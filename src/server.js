"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const { ensureProxyConfigured } = require("./httpClient");
const {
  ACTIVE_UPSTREAM_MODES,
  DEFAULT_PASSWORD,
  DEFAULT_USER_KEY,
  RELAY_USERS,
  RUNTIME_MODES,
  getActiveUpstreamId,
  getActiveUpstreamRuntime,
  getDisplayOrigin,
  getRelayToken,
  getUpstreamCloudConfig,
  isDefaultPasswordActive,
  listRelayUsers,
  listUpstreamConfigs,
  normalizeUserKey,
  resolveRelayUserByToken,
  updatePanelSettings,
  updatePassword,
  verifyPasswordLogin,
} = require("./authStore");
const {
  buildAppUpdateStatus,
  buildUpstreamCloudStatus,
  ensureCloudUpstreamsReady,
  invalidateCaches,
  runSystemUpdate,
  scheduleProcessRestart,
  syncCloudUpstreams,
} = require("./repoManager");
const {
  appendUserHistory,
  getUserState,
  listUserStates,
  loadRelayState,
} = require("./registrationStore");
const { listUpstreamModuleDiagnostics, reloadUpstreamModules } = require("./upstreams/core/registry");
const { URL_TYPES } = require("./upstreams/shared/snailApi");
const {
  getRuntimeCandidateUpstreamIds,
  manualRegisterWithRuntime,
  resolveRelayState,
  resolveViewState,
} = require("./upstreams/service");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const PUBLIC_ORIGIN = normalizeConfiguredOrigin(process.env.PUBLIC_ORIGIN || "");
const SESSION_COOKIE_NAME = "snail_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const RELAY_FETCH_TIMEOUT_MS = Number.parseInt(process.env.RELAY_FETCH_TIMEOUT_MS || "30000", 10);
const publicDir = path.join(__dirname, "..", "public");
const sessions = new Map();

const RELAY_TYPES = Object.keys(URL_TYPES);
const SUPPORTED_TYPES = new Set(["full", ...RELAY_TYPES]);
const FORWARDED_HEADERS = new Set([
  "cache-control",
  "content-disposition",
  "content-type",
  "etag",
  "last-modified",
  "profile-title",
  "profile-update-interval",
  "profile-web-page-url",
  "subscription-userinfo",
]);
const URI_NAME_QUERY_KEYS = new Set([
  "description",
  "label",
  "name",
  "ps",
  "remark",
  "remarks",
  "title",
]);

function normalizeConfiguredOrigin(input) {
  const value = (input || "").toString().trim();
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}`;
  } catch (error) {
    return "";
  }
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0, must-revalidate",
    Pragma: "no-cache",
    ...headers,
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, max-age=0, must-revalidate",
    Pragma: "no-cache",
  });
  response.end(html);
}

function sendText(response, statusCode, text, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store, max-age=0, must-revalidate",
    Pragma: "no-cache",
    ...headers,
  });
  response.end(`${text}\n`);
}

async function getAssetVersion() {
  const assets = ["index.html", "app.js", "styles.css"];
  const stats = await Promise.all(
    assets.map(async (fileName) => {
      const filePath = path.join(publicDir, fileName);
      try {
        return await fs.stat(filePath);
      } catch (error) {
        return { mtimeMs: Date.now() };
      }
    }),
  );

  return Math.max(...stats.map((item) => Math.floor(item.mtimeMs))).toString(36);
}

async function serveIndex(response) {
  const template = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
  const assetVersion = await getAssetVersion();
  sendHtml(response, 200, template.replaceAll("__ASSET_VERSION__", assetVersion));
}

async function serveStaticFile(response, fileName, contentType) {
  const filePath = path.join(publicDir, fileName);
  const content = await fs.readFile(filePath);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0, must-revalidate",
    Pragma: "no-cache",
  });
  response.end(content);
}

function getRequestOriginFromHeaders(request) {
  if (PUBLIC_ORIGIN) {
    return PUBLIC_ORIGIN;
  }

  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = forwardedProto
    ? forwardedProto.toString().split(",")[0].trim()
    : request.socket.encrypted
      ? "https"
      : "http";
  const host = request.headers["x-forwarded-host"] || request.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

async function getRequestOrigin(request) {
  const displayOrigin = await getDisplayOrigin();
  if (displayOrigin) {
    return displayOrigin;
  }

  return getRequestOriginFromHeaders(request);
}

function buildRelayUrls(origin, relayToken) {
  const encodedToken = encodeURIComponent(relayToken);
  return Object.fromEntries(
    RELAY_TYPES.map((type) => [
      type,
      `${origin}/subscribe/${encodeURIComponent(type)}?token=${encodedToken}`,
    ]),
  );
}

async function buildRelayUrlsByUser(origin) {
  const relayUsers = await listRelayUsers();
  return Object.fromEntries(
    relayUsers.map((user) => [user.key, buildRelayUrls(origin, user.relayToken)]),
  );
}

function normalizeType(input) {
  const value = (input || "full").toString().trim().toLowerCase();
  if (value === "default" || value === "raw") {
    return "universal";
  }
  if (value === "all") {
    return "full";
  }
  return value || "full";
}

function normalizeSubscriptionUpdateIntervalMinutes(rawValue, fallback = 30) {
  const parsed = Number.parseInt(rawValue || `${fallback}`, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function toProfileUpdateIntervalHours(minutes) {
  return String(Math.max(1, Math.ceil(minutes / 60)));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createRandomNodeName() {
  return crypto.randomBytes(6).toString("hex");
}

function normalizeNodeNameForMatching(value) {
  return value.normalize("NFKC").replace(/[\u3002\uFF61\uFE52\uFF0E]/g, ".");
}

function isAdvertisementNodeName(value) {
  const text = normalizeNodeNameForMatching((value || "").toString().trim());
  if (!text) {
    return false;
  }

  return /(?:https?:\/\/|www\.)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,63}|xn--[a-z0-9-]{2,59})\b/iu.test(
    text,
  );
}

function getSanitizedNodeName(name, nameMap) {
  if (!isAdvertisementNodeName(name)) {
    return name;
  }

  if (!nameMap.has(name)) {
    let replacement = "";
    do {
      replacement = createRandomNodeName();
    } while (nameMap.has(replacement));
    nameMap.set(name, replacement);
  }

  return nameMap.get(name);
}

function sanitizeJsonSubscriptionBody(rawBody) {
  const nameMap = new Map();
  const directNameKeys = new Set(["tag", "name", "ps", "remarks"]);
  const referenceArrayKeys = new Set(["outbounds", "proxies"]);

  function visit(value, parentKey = "") {
    if (Array.isArray(value)) {
      return value.map((item) =>
        typeof item === "string" && referenceArrayKeys.has(parentKey)
          ? getSanitizedNodeName(item, nameMap)
          : visit(item, parentKey),
      );
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => {
        if (typeof entryValue === "string" && directNameKeys.has(key)) {
          return [key, getSanitizedNodeName(entryValue, nameMap)];
        }

        if (Array.isArray(entryValue) && referenceArrayKeys.has(key)) {
          return [
            key,
            entryValue.map((item) =>
              typeof item === "string" ? getSanitizedNodeName(item, nameMap) : visit(item, key),
            ),
          ];
        }

        return [key, visit(entryValue, key)];
      }),
    );
  }

  return JSON.stringify(visit(JSON.parse(rawBody)));
}

function normalizeBase64Padding(value) {
  const remainder = value.length % 4;
  if (remainder === 0) {
    return value;
  }

  return value.padEnd(value.length + (4 - remainder), "=");
}

function tryDecodeBase64(value) {
  const normalized = normalizeBase64Padding(value.replace(/-/g, "+").replace(/_/g, "/"));

  try {
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch (error) {
    return "";
  }
}

function encodeBase64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function sanitizeUriQueryParams(uri, nameMap) {
  try {
    const parsedUrl = new URL(uri);
    let changed = false;

    URI_NAME_QUERY_KEYS.forEach((key) => {
      const currentValue = parsedUrl.searchParams.get(key);
      if (!currentValue) {
        return;
      }

      const sanitizedValue = getSanitizedNodeName(currentValue, nameMap);
      if (sanitizedValue === currentValue) {
        return;
      }

      parsedUrl.searchParams.set(key, sanitizedValue);
      changed = true;
    });

    return changed ? parsedUrl.toString() : uri;
  } catch (error) {
    return uri;
  }
}

function sanitizeUriLine(line, nameMap) {
  const trimmed = line.trim();
  if (!trimmed) {
    return line;
  }

  if (/^vmess:\/\//i.test(trimmed)) {
    const encoded = trimmed.slice("vmess://".length);
    const decoded = tryDecodeBase64(encoded);
    if (!decoded) {
      return line;
    }

    try {
      const payload = JSON.parse(decoded);
      if (typeof payload.ps === "string") {
        payload.ps = getSanitizedNodeName(payload.ps, nameMap);
      }
      return `vmess://${encodeBase64(JSON.stringify(payload))}`;
    } catch (error) {
      return line;
    }
  }

  const sanitizedQueryUri = sanitizeUriQueryParams(trimmed, nameMap);
  const hashIndex = sanitizedQueryUri.indexOf("#");
  if (hashIndex < 0) {
    return sanitizedQueryUri === trimmed ? line : sanitizedQueryUri;
  }

  const prefix = sanitizedQueryUri.slice(0, hashIndex + 1);
  const rawName = sanitizedQueryUri.slice(hashIndex + 1);
  const decodedName = (() => {
    try {
      return decodeURIComponent(rawName);
    } catch (error) {
      return rawName;
    }
  })();
  const sanitizedName = getSanitizedNodeName(decodedName, nameMap);

  if (sanitizedName === decodedName) {
    return sanitizedQueryUri === trimmed ? line : sanitizedQueryUri;
  }

  return `${prefix}${encodeURIComponent(sanitizedName)}`;
}

function sanitizeEncodedSubscriptionBody(rawBody) {
  const decoded = tryDecodeBase64(rawBody.trim());
  if (!decoded || !/:\/\//.test(decoded)) {
    return rawBody;
  }

  const nameMap = new Map();
  const sanitizedLines = decoded
    .split(/\r?\n/)
    .map((line) => sanitizeUriLine(line, nameMap))
    .join("\n");

  return encodeBase64(sanitizedLines);
}

function sanitizeYamlSubscriptionBody(rawBody) {
  const nameMap = new Map();
  let result = rawBody
    .replace(/(name:\s*)(['"])(.*?)\2/g, (match, prefix, quote, name) => {
      const sanitizedName = getSanitizedNodeName(name, nameMap);
      return `${prefix}${quote}${sanitizedName}${quote}`;
    })
    .replace(/(name:\s*)([^,'"\r\n}][^,\r\n}]*)/g, (match, prefix, name) => {
      const sanitizedName = getSanitizedNodeName(name.trim(), nameMap);
      return sanitizedName === name.trim() ? match : `${prefix}${sanitizedName}`;
    });

  for (const [sourceName, targetName] of nameMap.entries()) {
    const quotedPattern = new RegExp(`(['"])${escapeRegExp(sourceName)}\\1`, "g");
    result = result.replace(quotedPattern, (match, quote) => `${quote}${targetName}${quote}`);
  }

  return result;
}

function sanitizeSubscriptionBody(bodyBuffer) {
  const rawBody = bodyBuffer.toString("utf8");
  const trimmedBody = rawBody.trim();

  if (!trimmedBody) {
    return bodyBuffer;
  }

  try {
    if (trimmedBody.startsWith("{") || trimmedBody.startsWith("[")) {
      return Buffer.from(sanitizeJsonSubscriptionBody(rawBody), "utf8");
    }
  } catch (error) {
    // Ignore JSON parse failures and fall through to other formats.
  }

  if (/^[A-Za-z0-9+/=\r\n_-]+$/.test(trimmedBody) && trimmedBody.length > 32) {
    const sanitizedEncodedBody = sanitizeEncodedSubscriptionBody(rawBody);
    if (sanitizedEncodedBody !== rawBody) {
      return Buffer.from(sanitizedEncodedBody, "utf8");
    }
  }

  return Buffer.from(sanitizeYamlSubscriptionBody(rawBody), "utf8");
}

function sanitizeRegistration(record) {
  if (!record) {
    return null;
  }

  return {
    email: record.email || "",
    password: record.password || "",
    inviteCode: record.inviteCode || "",
    createdAt: record.createdAt || "",
    accountCreatedAt: record.accountCreatedAt || "",
    expiredAt: record.expiredAt || "",
    mock: Boolean(record.mock),
    upstreamSite: record.upstreamSite || "",
    apiBase: record.apiBase || "",
    entryUrl: record.entryUrl || "",
    upstreamSource: record.upstreamSource || "",
    lastUsageCheckAt: record.lastUsageCheckAt || "",
  };
}

function sanitizeUsage(usage) {
  if (!usage) {
    return null;
  }

  return {
    queriedAt: usage.queriedAt || "",
    email: usage.email || "",
    planId: usage.planId ?? null,
    planName: usage.planName || "",
    resetDay: usage.resetDay ?? null,
    expiredAt: usage.expiredAt || "",
    accountCreatedAt: usage.accountCreatedAt || "",
    lastLoginAt: usage.lastLoginAt || "",
    transferEnable: usage.transferEnable ?? 0,
    usedUpload: usage.usedUpload ?? 0,
    usedDownload: usage.usedDownload ?? 0,
    usedTotal: usage.usedTotal ?? 0,
    remainingTraffic: usage.remainingTraffic ?? 0,
    remainingPercent: usage.remainingPercent ?? 0,
    usagePercent: usage.usagePercent ?? 0,
    stat: usage.stat ?? null,
    upstreamSite: usage.upstreamSite || "",
  };
}

function sanitizeHistoryEntry(entry) {
  return {
    id: entry.id || "",
    timestamp: entry.timestamp || "",
    action: entry.action || "",
    title: entry.title || "",
    message: entry.message || "",
    mode: entry.mode || "",
    decision: entry.decision || "",
    relayType: entry.relayType || "",
    requestSource: entry.requestSource || "",
    upstreamId: entry.upstreamId || "",
    usage: sanitizeUsage(entry.usage),
    registration: sanitizeRegistration(entry.registration),
    details: entry.details || null,
  };
}

function buildUserSummary(user, userState) {
  const latestHistory = Array.isArray(userState.history) && userState.history.length > 0
    ? userState.history[0]
    : null;

  return {
    key: user.key,
    label: user.label,
    hasRegistration: Boolean(userState.latestRegistration),
    createdAt: userState.latestRegistration?.createdAt || "",
    updatedAt: userState.updatedAt || "",
    remainingPercent: userState.latestUsage?.remainingPercent ?? null,
    remainingTraffic: userState.latestUsage?.remainingTraffic ?? null,
    transferEnable: userState.latestUsage?.transferEnable ?? null,
    queriedAt: userState.latestUsage?.queriedAt || "",
    lastAction: latestHistory?.title || "",
  };
}

function filterRelayUrlsBySupportedTypes(relayUrls, supportedTypes) {
  if (!relayUrls || typeof relayUrls !== "object") {
    return {};
  }

  const allowedTypes = Array.isArray(supportedTypes) && supportedTypes.length > 0
    ? supportedTypes
    : Object.keys(relayUrls);

  return Object.fromEntries(
    Object.entries(relayUrls).filter(([type]) => allowedTypes.includes(type)),
  );
}

function shapeRegistrationResponse(user, upstream, userState, type, relayUrls, warning = "") {
  const filteredRelayUrls = filterRelayUrlsBySupportedTypes(relayUrls, upstream?.supportedTypes);
  const subscriptionUrl = type === "full" ? filteredRelayUrls.universal : filteredRelayUrls[type];

  return {
    user: {
      key: user.key,
      label: user.label,
    },
    upstream: upstream
      ? {
          id: upstream.id,
          label: upstream.label,
          apiVersion: upstream.apiVersion ?? null,
          moduleLabel: upstream.moduleLabel || "",
          description: upstream.description || "",
          website: upstream.website || "",
          docsUrl: upstream.docsUrl || "",
          author: upstream.author || "",
          capabilities: upstream.capabilities || {},
          supportedTypes: upstream.supportedTypes || [],
          remark: upstream.remark || "",
          settingFields: Array.isArray(upstream.settingFields) ? upstream.settingFields : [],
          config: upstream.config || null,
          active: Boolean(upstream.active),
        }
      : null,
    runtimeMode: upstream?.config?.runtimeMode || "",
    trafficThresholdPercent: upstream?.config?.trafficThresholdPercent ?? 20,
    maxRegistrationAgeMinutes: upstream?.config?.maxRegistrationAgeMinutes ?? 0,
    subscriptionUpdateIntervalMinutes: upstream?.config?.subscriptionUpdateIntervalMinutes ?? 30,
    type,
    subscriptionUrl,
    relayUrls: filteredRelayUrls,
    registration: sanitizeRegistration(userState.latestRegistration),
    usage: sanitizeUsage(userState.latestUsage),
    history: Array.isArray(userState.history)
      ? userState.history.map(sanitizeHistoryEntry)
      : [],
    warning,
  };
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("Request body must be valid JSON.");
  }
}

async function fetchUpstreamSubscription(upstreamUrl) {
  ensureProxyConfigured();

  return fetch(upstreamUrl, {
    signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS),
  });
}

async function fetchFallbackSubscriptionUserInfoHeader(clientUrls, requestedType) {
  if (!clientUrls || requestedType === "clash") {
    return "";
  }

  const clashUrl = clientUrls.clash;
  const requestedUrl = clientUrls[requestedType];
  if (!clashUrl || clashUrl === requestedUrl) {
    return "";
  }

  try {
    const fallbackResponse = await fetchUpstreamSubscription(clashUrl);
    const fallbackHeader = (fallbackResponse.headers.get("subscription-userinfo") || "").trim();

    if (fallbackResponse.body && typeof fallbackResponse.body.cancel === "function") {
      fallbackResponse.body.cancel().catch(() => undefined);
    }

    return fallbackResponse.ok ? fallbackHeader : "";
  } catch (error) {
    return "";
  }
}

function parseCookies(request) {
  const header = request.headers.cookie || "";
  const cookies = {};

  for (const item of header.split(";")) {
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function createSession() {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, {
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

function destroySession(token) {
  if (token) {
    sessions.delete(token);
  }
}

function getSession(request) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE_NAME];

  if (!token) {
    return null;
  }

  const session = sessions.get(token);
  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { token };
}

function setSessionCookie(response, token) {
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  );
}

function clearSessionCookie(response) {
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
  );
}

function requireAuth(request, response) {
  const session = getSession(request);

  if (!session) {
    sendJson(response, 401, {
      success: false,
      error: "Authentication required.",
    });
    return null;
  }

  return session;
}

function getUpstreamSummary(upstreams, upstreamId) {
  return upstreams.find((item) => item.id === upstreamId) || upstreams[0] || null;
}

async function handleLogin(request, response) {
  const body = await readJsonBody(request);
  const password = (body.password || "").toString();

  if (!password) {
    sendJson(response, 400, {
      success: false,
      error: "Password is required.",
    });
    return;
  }

  const { valid } = await verifyPasswordLogin(password);
  if (!valid) {
    sendJson(response, 401, {
      success: false,
      error: "Invalid password.",
    });
    return;
  }

  const token = createSession();
  setSessionCookie(response, token);

  sendJson(response, 200, {
    success: true,
    message: "Login successful.",
  });
}

async function handleLogout(request, response) {
  const session = getSession(request);
  if (session) {
    destroySession(session.token);
  }

  clearSessionCookie(response);
  sendJson(response, 200, {
    success: true,
    message: "Logged out.",
  });
}

async function handleSession(request, response) {
  const session = getSession(request);
  const passwordIsDefault = await isDefaultPasswordActive();
  if (!session) {
    sendJson(response, 200, {
      success: true,
      authenticated: false,
      defaultPassword: passwordIsDefault ? DEFAULT_PASSWORD : "",
      passwordIsDefault,
    });
    return;
  }

  const origin = await getRequestOrigin(request);
  await ensureCloudUpstreamsReady();
  const [
    { activeUpstreamId, activeUpstreamMode, upstreamOrder },
    displayOrigin,
    relayUsers,
    appUpdate,
    upstreamCloudStatus,
    upstreamCloud,
  ] = await Promise.all([
    getActiveUpstreamRuntime(),
    getDisplayOrigin(),
    listRelayUsers(),
    buildAppUpdateStatus(false),
    buildUpstreamCloudStatus(false),
    getUpstreamCloudConfig(),
  ]);
  const upstreams = await listUpstreamConfigs();
  const userStates = await listUserStates(activeUpstreamId);
  const stateByUser = Object.fromEntries(userStates.map((item) => [item.userKey, item]));
  const relayUrlsByUser = await buildRelayUrlsByUser(origin);
  const userSummaries = relayUsers.map((user) =>
    buildUserSummary(
      user,
      stateByUser[user.key] || { latestRegistration: null, latestUsage: null, history: [], updatedAt: null },
    ),
  );

  sendJson(response, 200, {
    success: true,
    authenticated: true,
    defaultPassword: passwordIsDefault ? DEFAULT_PASSWORD : "",
    passwordIsDefault,
    displayOrigin,
    activeUpstreamId,
    activeUpstreamMode,
    upstreamOrder,
    upstreams,
    runtimeModes: {
      alwaysRefresh: RUNTIME_MODES.ALWAYS_REFRESH,
      smartUsage: RUNTIME_MODES.SMART_USAGE,
    },
    activeUpstreamModes: {
      single: ACTIVE_UPSTREAM_MODES.SINGLE,
      polling: ACTIVE_UPSTREAM_MODES.POLLING,
    },
    users: relayUsers.map((user) => ({
      key: user.key,
      label: user.label,
    })),
    relayUrlsByUser,
    userSummaries,
    defaultUserKey: DEFAULT_USER_KEY,
    appUpdate,
    upstreamCloud: {
      ...upstreamCloudStatus,
      config: upstreamCloud,
    },
    upstreamCloudStatus,
  });
}

async function handleUpdatePassword(request, response) {
  const body = await readJsonBody(request);
  const result = await updatePassword({
    currentPassword: (body.currentPassword || "").toString(),
    newPassword: (body.newPassword || "").toString(),
  });

  sendJson(response, 200, {
    success: true,
    message: "Password updated.",
    ...result,
  });
}

async function handleUpdateSettings(request, response) {
  const body = await readJsonBody(request);
  const result = await updatePanelSettings({
    displayOrigin: body.displayOrigin,
    activeUpstreamId: body.activeUpstreamId,
    activeUpstreamMode: body.activeUpstreamMode,
    upstreamOrder: body.upstreamOrder,
    upstreamCloud: body.upstreamCloud,
    upstreamId: body.upstreamId,
    runtimeMode: body.runtimeMode,
    trafficThresholdPercent: body.trafficThresholdPercent,
    maxRegistrationAgeMinutes: body.maxRegistrationAgeMinutes,
    subscriptionUpdateIntervalMinutes: body.subscriptionUpdateIntervalMinutes,
    inviteCode: body.inviteCode,
    name: body.name,
    remark: body.remark,
    providerSettings: body.providerSettings,
    enabled: body.enabled,
  });

  if (body.upstreamCloud !== undefined) {
    invalidateCaches();
  }

  sendJson(response, 200, {
    success: true,
    message: "Settings updated.",
    activeUpstreamId: result.activeUpstreamId,
    activeUpstreamMode: result.activeUpstreamMode,
    displayOrigin: result.displayOrigin,
    upstreamOrder: result.upstreamOrder,
    upstreamCloud: result.upstreamCloud,
    updatedAt: result.updatedAt,
    upstreamConfig: result.upstreamConfig,
  });
}

async function handleReloadUpstreams(response) {
  reloadUpstreamModules();
  const upstreams = await listUpstreamConfigs();
  const diagnostics = listUpstreamModuleDiagnostics();
  const upstreamCloudStatus = await buildUpstreamCloudStatus(true);

  sendJson(response, 200, {
    success: true,
    message:
      diagnostics.length > 0
        ? `Upstream modules reloaded with ${diagnostics.length} issue(s).`
        : "Upstream modules reloaded.",
    upstreams,
    upstreamCloudStatus,
    diagnostics,
  });
}

async function handleCheckAppUpdate(response) {
  const appUpdate = await buildAppUpdateStatus(true);
  sendJson(response, 200, {
    success: true,
    appUpdate,
  });
}

async function handleStartAppUpdate(response) {
  const result = await runSystemUpdate();
  sendJson(response, 200, {
    success: true,
    message: result.updated ? "Online update completed. Server will restart." : "Already up to date.",
    appUpdate: result.status,
    restartRequired: Boolean(result.restartRequired),
  });

  if (result.restartRequired) {
    scheduleProcessRestart();
    setTimeout(() => {
      server.close(() => {
        process.exit(0);
      });
    }, 250);
  }
}

async function handleCheckUpstreamCloud(response) {
  const upstreamCloud = await buildUpstreamCloudStatus(true);
  sendJson(response, 200, {
    success: true,
    upstreamCloud,
  });
}

async function handleSyncUpstreamCloud(response) {
  const result = await syncCloudUpstreams();
  const upstreams = await listUpstreamConfigs();
  const diagnostics = listUpstreamModuleDiagnostics();
  const upstreamCloud = await buildUpstreamCloudStatus(true);

  sendJson(response, 200, {
    success: true,
    message: result.synced ? "Cloud upstream modules synchronized." : "Cloud upstream modules are current.",
    upstreamCloud,
    synced: Boolean(result.synced),
    syncedAt: result.syncedAt || "",
    syncedModuleIds: Array.isArray(result.syncedModuleIds) ? result.syncedModuleIds : [],
    upstreams,
    diagnostics,
  });
}

async function handleCreateSubscription(request, response) {
  const body = await readJsonBody(request);
  const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";
  const type = normalizeType(body.type);
  const userKey = normalizeUserKey(body.userKey);
  const requestedUpstreamId =
    typeof body.upstreamId === "string" ? body.upstreamId.trim() : "";

  if (!SUPPORTED_TYPES.has(type)) {
    sendJson(response, 400, {
      success: false,
      error: `Unsupported type: ${type}`,
      supportedTypes: Array.from(SUPPORTED_TYPES),
    });
    return;
  }

  const result = await manualRegisterWithRuntime(userKey, {
    inviteCode,
    relayType: type === "full" ? "universal" : type,
    upstreamId: requestedUpstreamId || undefined,
  });
  const relayToken = await getRelayToken(userKey);
  const relayUrls = buildRelayUrls(await getRequestOrigin(request), relayToken);
  const upstreams = await listUpstreamConfigs();
  const upstream = getUpstreamSummary(
    upstreams,
    result.upstreamId || requestedUpstreamId || (await getActiveUpstreamId()),
  );
  const user = RELAY_USERS.find((item) => item.key === userKey) || RELAY_USERS[0];

  sendJson(response, 200, {
    success: true,
    message: "Registration completed.",
    ...shapeRegistrationResponse(user, upstream, result.userState, type, relayUrls),
  });
}

async function handleLatestSubscription(request, response, url) {
  const type = normalizeType(url.searchParams.get("type"));
  const userKey = normalizeUserKey(url.searchParams.get("user"));
  const upstreamId = (url.searchParams.get("upstreamId") || (await getActiveUpstreamId())).toString();

  if (!SUPPORTED_TYPES.has(type)) {
    sendJson(response, 400, {
      success: false,
      error: `Unsupported type: ${type}`,
      supportedTypes: Array.from(SUPPORTED_TYPES),
    });
    return;
  }

  const result = await resolveViewState(userKey, upstreamId);
  const relayToken = await getRelayToken(userKey);
  const relayUrls = buildRelayUrls(await getRequestOrigin(request), relayToken);
  const upstreams = await listUpstreamConfigs();
  const upstream = getUpstreamSummary(upstreams, upstreamId);
  const user = RELAY_USERS.find((item) => item.key === userKey) || RELAY_USERS[0];

  sendJson(response, 200, {
    success: true,
    message: result.userState.latestRegistration
      ? "Latest user state returned."
      : "Current user has no registration yet.",
    ...shapeRegistrationResponse(user, upstream, result.userState, type, relayUrls, result.warning),
  });
}

async function proxySubscription(response, request, type, url) {
  const token = (url.searchParams.get("token") || "").trim();
  const relayUser = await resolveRelayUserByToken(token);

  if (!relayUser) {
    sendText(response, 403, "Invalid subscription token.");
    return;
  }

  const candidateUpstreamIds = await getRuntimeCandidateUpstreamIds(type);
  if (candidateUpstreamIds.length === 0) {
    sendText(response, 503, "No enabled upstream is available.");
    return;
  }

  let lastFailure = null;

  for (const upstreamId of candidateUpstreamIds) {
    let runtimeMode = "";
    let upstreamConfig = null;
    let userState = {
      latestRegistration: null,
      latestUsage: null,
    };
    let latest = null;

    try {
      const result = await resolveRelayState(relayUser.key, upstreamId, type);
      runtimeMode = result.runtimeMode;
      upstreamConfig = result.upstreamConfig;
      userState = result.userState;
      latest = userState.latestRegistration;

      const upstreamUrl = latest?.clientUrls?.[type];
      const subscriptionUpdateIntervalMinutes = normalizeSubscriptionUpdateIntervalMinutes(
        upstreamConfig?.subscriptionUpdateIntervalMinutes,
      );
      const profileUpdateIntervalHours = toProfileUpdateIntervalHours(
        subscriptionUpdateIntervalMinutes,
      );

      if (!upstreamUrl) {
        throw new Error(`Unsupported relay type: ${type}`);
      }

      if (latest.mock) {
        await appendUserHistory(relayUser.key, upstreamId, {
          action: "relay_mock",
          title: "已返回 Mock 订阅",
          message: "当前用户处于 Mock 模式，客户端收到的是本地生成的调试内容。",
          mode: runtimeMode,
          relayType: type,
          requestSource: "relay",
          registration: latest,
          usage: userState.latestUsage,
        });

        sendText(
          response,
          200,
          [
            "# Mock relay subscription",
            `user=${relayUser.label}`,
            `type=${type}`,
            `email=${latest.email}`,
            `inviteCode=${latest.inviteCode || ""}`,
            `createdAt=${latest.createdAt || ""}`,
          ].join("\n"),
          {
            "profile-title": `Snail Mock ${type}`,
            "profile-update-interval": profileUpdateIntervalHours,
          },
        );
        return;
      }

      const upstreamResponse = await fetchUpstreamSubscription(upstreamUrl);
      if (!upstreamResponse.ok) {
        const nextError = new Error(
          `Upstream subscription request failed with status ${upstreamResponse.status}.`,
        );
        nextError.status = upstreamResponse.status;
        throw nextError;
      }

      await appendUserHistory(relayUser.key, upstreamId, {
        action: "relay_success",
        title: "已成功中转客户端订阅",
        message: `客户端成功拉取 ${type} 订阅。`,
        mode: runtimeMode,
        relayType: type,
        requestSource: "relay",
        registration: latest,
        usage: userState.latestUsage,
      });

      const headers = {};
      upstreamResponse.headers.forEach((value, key) => {
        const normalizedKey = key.toLowerCase();
        if (FORWARDED_HEADERS.has(normalizedKey)) {
          headers[normalizedKey] = value;
        }
      });
      if (!headers["subscription-userinfo"]) {
        const fallbackUserInfoHeader = await fetchFallbackSubscriptionUserInfoHeader(
          latest?.clientUrls,
          type,
        );
        if (fallbackUserInfoHeader) {
          headers["subscription-userinfo"] = fallbackUserInfoHeader;
        }
      }
      headers["profile-update-interval"] = profileUpdateIntervalHours;

      const body = sanitizeSubscriptionBody(Buffer.from(await upstreamResponse.arrayBuffer()));
      response.writeHead(200, headers);

      if (request.method === "HEAD") {
        response.end();
        return;
      }

      response.end(body);
      return;
    } catch (error) {
      lastFailure = error;

      await appendUserHistory(relayUser.key, upstreamId, {
        action: candidateUpstreamIds.length > 1 ? "polling_skip" : "relay_failed",
        title: candidateUpstreamIds.length > 1 ? "轮询跳过不可用上游" : "中转拉取上游失败",
        message: error.message,
        mode: runtimeMode,
        relayType: type,
        requestSource: "relay",
        registration: latest,
        usage: userState.latestUsage,
        details: {
          polling: candidateUpstreamIds.length > 1,
          status: error.status || null,
        },
      });
    }
  }

  sendText(
    response,
    candidateUpstreamIds.length > 1 ? 502 : lastFailure?.status || 502,
    candidateUpstreamIds.length > 1
      ? `No available upstream succeeded: ${lastFailure?.message || "Unknown error."}`
      : `Upstream subscription request failed: ${lastFailure?.message || "Unknown error."}`,
  );
}

async function handleHealth(response) {
  const relayState = await loadRelayState();
  const activeUpstreamId = await getActiveUpstreamId();
  const latestRegistrationAvailable = Object.values(relayState.users || {}).some((userState) =>
    Boolean(userState?.upstreams?.[activeUpstreamId]?.latestRegistration),
  );

  sendJson(response, 200, {
    success: true,
    status: "ok",
    activeUpstreamId,
    latestRegistrationAvailable,
  });
}

async function requestListener(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method === "GET" && url.pathname === "/") {
      await serveIndex(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/app.js") {
      await serveStaticFile(response, "app.js", "application/javascript; charset=utf-8");
      return;
    }

    if (request.method === "GET" && url.pathname === "/styles.css") {
      await serveStaticFile(response, "styles.css", "text/css; charset=utf-8");
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/subscribe/")) {
      const type = decodeURIComponent(url.pathname.slice("/subscribe/".length));
      if (!RELAY_TYPES.includes(type)) {
        sendText(response, 404, "Subscription route not found.");
        return;
      }

      await proxySubscription(response, request, type, url);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      await handleHealth(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      await handleLogin(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
      await handleLogout(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/session") {
      await handleSession(request, response);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const session = requireAuth(request, response);
      if (!session) {
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/password") {
        await handleUpdatePassword(request, response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/settings") {
        await handleUpdateSettings(request, response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/upstreams/reload") {
        await handleReloadUpstreams(response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/upstreams/cloud/check") {
        await handleCheckUpstreamCloud(response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/upstreams/cloud/sync") {
        await handleSyncUpstreamCloud(response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/system/check-update") {
        await handleCheckAppUpdate(response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/system/update") {
        await handleStartAppUpdate(response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/subscriptions/latest") {
        await handleLatestSubscription(request, response, url);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/subscriptions") {
        await handleCreateSubscription(request, response);
        return;
      }
    }

    sendJson(response, 404, {
      success: false,
      error: "Route not found.",
    });
  } catch (error) {
    if (url.pathname.startsWith("/subscribe/")) {
      sendText(response, 500, error.message);
      return;
    }

    sendJson(response, 500, {
      success: false,
      error: error.message,
    });
  }
}

const server = http.createServer(requestListener);

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
