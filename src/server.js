"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const QRCode = require("qrcode");
const yaml = require("js-yaml");

const { ensureProxyConfigured } = require("./httpClient");
const {
  ACTIVE_UPSTREAM_MODES,
  DEFAULT_PASSWORD,
  DEFAULT_USER_KEY,
  RELAY_USERS,
  RUNTIME_MODES,
  getActiveUpstreamRuntime,
  getDisplayOrigin,
  getRelayToken,
  getUpstreamConfig,
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
const {
  getUpstreamModule,
  listUpstreamModuleDiagnostics,
  reloadUpstreamModules,
} = require("./upstreams/core/registry");
const { loadAggregateClashTemplate } = require("./aggregateClashTemplate");
const { mergeSubscriptionBodies } = require("./subscriptionMerger");
const { URL_TYPES } = require("./upstreams/shared/snailApi");
const {
  getRuntimeCandidateUpstreamIds,
  manualRegisterAggregateWithRuntime,
  manualRegisterWithRuntime,
  resolveAggregateRelayStates,
  resolveAggregateViewStates,
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
  try {
    const parsed = yaml.load(rawBody);
    if (!parsed || typeof parsed !== "object") {
      return rawBody;
    }

    const nameMap = new Map();
    const directNameKeys = new Set(["name"]);
    const referenceArrayKeys = new Set(["proxies"]);

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

    return yaml.dump(visit(parsed), {
      noRefs: true,
      lineWidth: -1,
    });
  } catch (error) {
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

const CLASH_FALLBACK_HEALTHCHECK_URL = "http://www.gstatic.com/generate_204";
const CLASH_FALLBACK_HEALTHCHECK_INTERVAL_SECONDS = 30;
const CLASH_FALLBACK_HEALTHCHECK_TIMEOUT_MS = 5000;
const CLASH_FALLBACK_MAIN_GROUP = "\ud83d\udd30 \u8282\u70b9\u9009\u62e9";
const CLASH_FALLBACK_AUTO_GROUP = "\u267b\ufe0f \u81ea\u52a8\u9009\u62e9";
const CLASH_FALLBACK_FAILOVER_GROUP = "\u2699\ufe0f \u6545\u969c\u8f6c\u79fb";
const CLASH_FALLBACK_DIRECT_GROUP = "\ud83c\udfaf \u5168\u7403\u76f4\u8fde";
const CLASH_FALLBACK_FINAL_GROUP = "\ud83d\udc1f \u6f0f\u7f51\u4e4b\u9c7c";

function decodeUriComponentSafely(value) {
  try {
    return decodeURIComponent(value || "");
  } catch (error) {
    return (value || "").toString();
  }
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseQueryBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = value.toString().trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function splitUniversalSubscriptionLines(rawBody) {
  const trimmedBody = (rawBody || "").toString("utf8").trim();
  if (!trimmedBody) {
    return [];
  }

  const decodedBody = tryDecodeBase64(trimmedBody);
  const subscriptionText = decodedBody && /:\/\//.test(decodedBody) ? decodedBody : trimmedBody;
  return subscriptionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildUniqueProxyName(name, usedNames) {
  const baseName = (name || "node").toString().trim() || "node";
  let candidate = baseName;
  let suffix = 2;

  while (usedNames.has(candidate)) {
    candidate = `${baseName} ${suffix}`;
    suffix += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function parseSsPluginOptions(pluginValue = "") {
  const decodedPlugin = decodeUriComponentSafely(pluginValue);
  if (!decodedPlugin) {
    return {};
  }

  const segments = decodedPlugin
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return {};
  }

  const pluginName = segments.shift();
  const rawOptions = Object.fromEntries(
    segments.map((segment) => {
      const separatorIndex = segment.indexOf("=");
      if (separatorIndex < 0) {
        return [segment, "true"];
      }
      return [
        segment.slice(0, separatorIndex).trim(),
        decodeUriComponentSafely(segment.slice(separatorIndex + 1).trim()),
      ];
    }),
  );

  if (pluginName === "obfs-local" || pluginName === "simple-obfs") {
    const pluginOpts = {};
    if (rawOptions.obfs || rawOptions.mode) {
      pluginOpts.mode = rawOptions.obfs || rawOptions.mode;
    }
    if (rawOptions["obfs-host"] || rawOptions.host) {
      pluginOpts.host = rawOptions["obfs-host"] || rawOptions.host;
    }

    return {
      plugin: pluginName,
      "plugin-opts": pluginOpts,
    };
  }

  if (pluginName === "v2ray-plugin") {
    const pluginOpts = {};
    if (rawOptions.mode) {
      pluginOpts.mode = rawOptions.mode;
    }
    if (rawOptions.host) {
      pluginOpts.host = rawOptions.host;
    }
    if (rawOptions.path) {
      pluginOpts.path = rawOptions.path;
    }
    if (parseQueryBoolean(rawOptions.tls, false)) {
      pluginOpts.tls = true;
    }

    return {
      plugin: pluginName,
      "plugin-opts": pluginOpts,
    };
  }

  return {
    plugin: pluginName,
    "plugin-opts": rawOptions,
  };
}

function parseSsUriToClashProxy(line) {
  let rest = line.slice("ss://".length).trim();
  let fragment = "";
  let query = "";

  const hashIndex = rest.indexOf("#");
  if (hashIndex >= 0) {
    fragment = rest.slice(hashIndex + 1);
    rest = rest.slice(0, hashIndex);
  }

  const queryIndex = rest.indexOf("?");
  if (queryIndex >= 0) {
    query = rest.slice(queryIndex + 1);
    rest = rest.slice(0, queryIndex);
  }

  let userInfo = "";
  let hostPort = "";
  const atIndex = rest.lastIndexOf("@");
  if (atIndex >= 0) {
    userInfo = rest.slice(0, atIndex);
    hostPort = rest.slice(atIndex + 1);
  } else {
    const decoded = tryDecodeBase64(rest);
    if (!decoded || !decoded.includes("@")) {
      return null;
    }
    const decodedAtIndex = decoded.lastIndexOf("@");
    userInfo = decoded.slice(0, decodedAtIndex);
    hostPort = decoded.slice(decodedAtIndex + 1);
  }

  if (!userInfo.includes(":")) {
    userInfo = tryDecodeBase64(userInfo);
  }
  if (!userInfo || !userInfo.includes(":")) {
    return null;
  }

  const separatorIndex = userInfo.indexOf(":");
  const cipher = decodeUriComponentSafely(userInfo.slice(0, separatorIndex));
  const password = decodeUriComponentSafely(userInfo.slice(separatorIndex + 1));
  if (!cipher || !password || !hostPort) {
    return null;
  }

  const parsedEndpoint = new URL(`http://${hostPort}`);
  const proxy = {
    name: decodeUriComponentSafely(fragment) || parsedEndpoint.hostname || "ss",
    type: "ss",
    server: parsedEndpoint.hostname,
    port: normalizeInteger(parsedEndpoint.port, 8388),
    cipher,
    password,
    udp: true,
  };

  const pluginConfig = parseSsPluginOptions(new URLSearchParams(query).get("plugin") || "");
  if (pluginConfig.plugin) {
    proxy.plugin = pluginConfig.plugin;
    proxy["plugin-opts"] = pluginConfig["plugin-opts"];
  }

  return proxy;
}

function parseVmessUriToClashProxy(line) {
  const encoded = line.slice("vmess://".length).trim();
  const decoded = tryDecodeBase64(encoded);
  if (!decoded) {
    return null;
  }

  const payload = JSON.parse(decoded);
  const tlsValue = (payload.tls || payload.security || "").toString().trim().toLowerCase();
  const network = (payload.net || "tcp").toString().trim().toLowerCase() || "tcp";
  const proxy = {
    name: payload.ps || payload.add || "vmess",
    type: "vmess",
    server: payload.add || "",
    port: normalizeInteger(payload.port, 443),
    uuid: payload.id || "",
    alterId: Number.parseInt(payload.aid || "0", 10) || 0,
    cipher: payload.scy || "auto",
    udp: true,
  };

  if (!proxy.server || !proxy.uuid) {
    return null;
  }

  if (tlsValue && tlsValue !== "none" && tlsValue !== "false") {
    proxy.tls = true;
    if (payload.sni || payload.host) {
      proxy.servername = payload.sni || payload.host;
    }
  }
  if (parseQueryBoolean(payload.allowInsecure || payload["skip-cert-verify"], false)) {
    proxy["skip-cert-verify"] = true;
  }
  if (network !== "tcp") {
    proxy.network = network;
  }
  if (network === "ws") {
    proxy["ws-opts"] = {
      path: payload.path || "/",
      headers: payload.host ? { Host: payload.host } : undefined,
    };
  } else if (network === "grpc") {
    proxy["grpc-opts"] = {
      "grpc-service-name": payload.path || payload.serviceName || "",
    };
  } else if (network === "h2" || network === "http") {
    proxy["h2-opts"] = {
      path: payload.path || "/",
      host: payload.host ? [payload.host] : undefined,
    };
  }

  return proxy;
}

function parseTrojanUriToClashProxy(line) {
  const parsedUrl = new URL(line);
  const params = parsedUrl.searchParams;
  const network = (params.get("type") || "tcp").toLowerCase();
  const proxy = {
    name: decodeUriComponentSafely(parsedUrl.hash.slice(1)) || parsedUrl.hostname || "trojan",
    type: "trojan",
    server: parsedUrl.hostname,
    port: normalizeInteger(parsedUrl.port, 443),
    password: decodeUriComponentSafely(parsedUrl.username),
    udp: parseQueryBoolean(params.get("udp"), true),
    sni: params.get("sni") || params.get("peer") || parsedUrl.hostname,
  };

  if (!proxy.server || !proxy.password) {
    return null;
  }

  if (parseQueryBoolean(params.get("allowInsecure") || params.get("insecure"), false)) {
    proxy["skip-cert-verify"] = true;
  }
  if (network !== "tcp") {
    proxy.network = network;
  }
  if (network === "ws") {
    proxy["ws-opts"] = {
      path: params.get("path") || "/",
      headers: params.get("host") ? { Host: params.get("host") } : undefined,
    };
  } else if (network === "grpc") {
    proxy["grpc-opts"] = {
      "grpc-service-name": params.get("serviceName") || params.get("service-name") || "",
    };
  }
  if (params.get("alpn")) {
    proxy.alpn = params
      .get("alpn")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return proxy;
}

function parseVlessUriToClashProxy(line) {
  const parsedUrl = new URL(line);
  const params = parsedUrl.searchParams;
  const security = (params.get("security") || "none").toLowerCase();
  const network = (params.get("type") || "tcp").toLowerCase();
  const proxy = {
    name: decodeUriComponentSafely(parsedUrl.hash.slice(1)) || parsedUrl.hostname || "vless",
    type: "vless",
    server: parsedUrl.hostname,
    port: normalizeInteger(parsedUrl.port, security === "tls" || security === "reality" ? 443 : 80),
    uuid: decodeUriComponentSafely(parsedUrl.username),
    cipher: "auto",
    udp: parseQueryBoolean(params.get("udp"), true),
  };

  if (!proxy.server || !proxy.uuid) {
    return null;
  }

  if (security === "tls" || security === "reality") {
    proxy.tls = true;
    proxy.servername = params.get("sni") || params.get("host") || parsedUrl.hostname;
  }
  if (security === "reality") {
    proxy["client-fingerprint"] = params.get("fp") || "chrome";
    proxy["reality-opts"] = {
      "public-key": params.get("pbk") || "",
      "short-id": params.get("sid") || "",
    };
  }
  if (params.get("flow")) {
    proxy.flow = params.get("flow");
  }
  if (parseQueryBoolean(params.get("allowInsecure") || params.get("insecure"), false)) {
    proxy["skip-cert-verify"] = true;
  }
  if (network !== "tcp") {
    proxy.network = network;
  }
  if (network === "ws") {
    proxy["ws-opts"] = {
      path: params.get("path") || "/",
      headers: params.get("host") ? { Host: params.get("host") } : undefined,
    };
  } else if (network === "grpc") {
    proxy["grpc-opts"] = {
      "grpc-service-name": params.get("serviceName") || params.get("service-name") || "",
    };
  }
  if (params.get("alpn")) {
    proxy.alpn = params
      .get("alpn")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return proxy;
}

function parseHysteria2UriToClashProxy(line) {
  const parsedUrl = new URL(line.replace(/^hy2:\/\//i, "hysteria2://"));
  const params = parsedUrl.searchParams;
  const proxy = {
    name: decodeUriComponentSafely(parsedUrl.hash.slice(1)) || parsedUrl.hostname || "hysteria2",
    type: "hysteria2",
    server: parsedUrl.hostname,
    port: normalizeInteger(parsedUrl.port, 443),
    password:
      decodeUriComponentSafely(parsedUrl.username) ||
      decodeUriComponentSafely(params.get("auth") || params.get("password")),
    sni: params.get("sni") || parsedUrl.hostname,
  };

  if (!proxy.server || !proxy.password) {
    return null;
  }

  if (parseQueryBoolean(params.get("insecure"), false)) {
    proxy["skip-cert-verify"] = true;
  }
  if (params.get("obfs")) {
    proxy.obfs = params.get("obfs");
  }
  if (params.get("obfs-password")) {
    proxy["obfs-password"] = params.get("obfs-password");
  }
  if (params.get("upmbps") || params.get("up")) {
    proxy.up = params.get("upmbps") || params.get("up");
  }
  if (params.get("downmbps") || params.get("down")) {
    proxy.down = params.get("downmbps") || params.get("down");
  }

  return proxy;
}

function parseUniversalUriToClashProxy(line) {
  const trimmedLine = (line || "").trim();
  if (!trimmedLine) {
    return null;
  }

  try {
    if (/^ss:\/\//i.test(trimmedLine)) {
      return parseSsUriToClashProxy(trimmedLine);
    }
    if (/^vmess:\/\//i.test(trimmedLine)) {
      return parseVmessUriToClashProxy(trimmedLine);
    }
    if (/^trojan:\/\//i.test(trimmedLine)) {
      return parseTrojanUriToClashProxy(trimmedLine);
    }
    if (/^vless:\/\//i.test(trimmedLine)) {
      return parseVlessUriToClashProxy(trimmedLine);
    }
    if (/^(hysteria2|hy2):\/\//i.test(trimmedLine)) {
      return parseHysteria2UriToClashProxy(trimmedLine);
    }
  } catch (error) {
    return null;
  }

  return null;
}

function buildFallbackClashConfig(proxies) {
  const proxyNames = proxies.map((proxy) => proxy.name).filter(Boolean);

  return {
    "mixed-port": 7890,
    "allow-lan": true,
    mode: "rule",
    "log-level": "info",
    proxies,
    "proxy-groups": [
      {
        name: CLASH_FALLBACK_MAIN_GROUP,
        type: "select",
        proxies: [
          CLASH_FALLBACK_AUTO_GROUP,
          CLASH_FALLBACK_DIRECT_GROUP,
          CLASH_FALLBACK_FAILOVER_GROUP,
          ...proxyNames,
        ],
      },
      {
        name: CLASH_FALLBACK_AUTO_GROUP,
        type: "url-test",
        proxies: proxyNames,
        url: CLASH_FALLBACK_HEALTHCHECK_URL,
        interval: CLASH_FALLBACK_HEALTHCHECK_INTERVAL_SECONDS,
        lazy: false,
        timeout: CLASH_FALLBACK_HEALTHCHECK_TIMEOUT_MS,
      },
      {
        name: CLASH_FALLBACK_FAILOVER_GROUP,
        type: "fallback",
        proxies: proxyNames,
        url: CLASH_FALLBACK_HEALTHCHECK_URL,
        interval: CLASH_FALLBACK_HEALTHCHECK_INTERVAL_SECONDS,
        lazy: false,
        timeout: CLASH_FALLBACK_HEALTHCHECK_TIMEOUT_MS,
      },
      {
        name: CLASH_FALLBACK_DIRECT_GROUP,
        type: "select",
        proxies: ["DIRECT"],
      },
      {
        name: CLASH_FALLBACK_FINAL_GROUP,
        type: "select",
        proxies: [CLASH_FALLBACK_MAIN_GROUP, CLASH_FALLBACK_DIRECT_GROUP],
      },
    ],
    rules: [`MATCH,${CLASH_FALLBACK_FINAL_GROUP}`],
  };
}

async function tryConvertUniversalBodyToClash(bodyBuffer) {
  const lines = splitUniversalSubscriptionLines(bodyBuffer);
  if (lines.length === 0) {
    return null;
  }

  const usedNames = new Set();
  const proxies = lines
    .map((line) => parseUniversalUriToClashProxy(line))
    .filter(Boolean)
    .map((proxy) => ({
      ...proxy,
      name: buildUniqueProxyName(proxy.name, usedNames),
    }));

  if (proxies.length === 0) {
    return null;
  }

  return Buffer.from(
    yaml.dump(buildFallbackClashConfig(proxies), {
      noRefs: true,
      lineWidth: -1,
    }),
    "utf8",
  );
}

async function normalizeSubscriptionPayload(type, bodyBuffer) {
  const sanitizedBody = sanitizeSubscriptionBody(bodyBuffer);

  try {
    validateSubscriptionPayload(type, sanitizedBody);
    return sanitizedBody;
  } catch (error) {
    if (type !== "clash") {
      throw error;
    }

    const convertedBody = await tryConvertUniversalBodyToClash(sanitizedBody);
    if (!convertedBody) {
      throw error;
    }

    const sanitizedConvertedBody = sanitizeSubscriptionBody(convertedBody);
    validateSubscriptionPayload(type, sanitizedConvertedBody);
    return sanitizedConvertedBody;
  }
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

  const contentType = ((request.headers["content-type"] || "").toString().split(";")[0] || "")
    .trim()
    .toLowerCase();

  if (contentType === "application/x-www-form-urlencoded") {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    if (raw.includes("=")) {
      return Object.fromEntries(new URLSearchParams(raw).entries());
    }
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

function formatAggregateSelectionLabel(targets = []) {
  const counts = new Map();
  const labels = new Map();

  targets.forEach((target) => {
    if (!target?.upstreamId) {
      return;
    }

    counts.set(target.upstreamId, (counts.get(target.upstreamId) || 0) + 1);
    labels.set(target.upstreamId, target.instanceLabel || target.upstreamId);
  });

  return Array.from(counts.entries())
    .map(([upstreamId, copies]) => {
      const baseLabel = labels.get(upstreamId) || upstreamId;
      const normalizedLabel = baseLabel.replace(/\s+#\d+$/, "");
      return copies > 1 ? `${normalizedLabel} x${copies}` : normalizedLabel;
    })
    .join(" + ");
}

function parseSubscriptionUserInfo(headerValue = "") {
  const result = {};

  headerValue
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex < 0) {
        return;
      }

      const key = part.slice(0, separatorIndex).trim();
      const rawValue = part.slice(separatorIndex + 1).trim();
      const parsedValue = Number.parseInt(rawValue, 10);
      if (key && Number.isFinite(parsedValue)) {
        result[key] = parsedValue;
      }
    });

  return result;
}

function getSubscriptionUserInfoRemainingTraffic(entry = {}) {
  const total = Number.isFinite(entry.total) ? entry.total : 0;
  const upload = Number.isFinite(entry.upload) ? entry.upload : 0;
  const download = Number.isFinite(entry.download) ? entry.download : 0;
  return Math.max(total - upload - download, 0);
}

function formatSubscriptionUserInfo(entry = {}) {
  return Object.entries(entry)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

function mergeSubscriptionUserInfoHeaders(headerValues = []) {
  const parsedValues = headerValues
    .map((value) => parseSubscriptionUserInfo(value))
    .filter((value) => Object.keys(value).length > 0);

  if (parsedValues.length === 0) {
    return "";
  }

  const bestEntry = parsedValues.sort((left, right) => {
    const remainingDiff = getSubscriptionUserInfoRemainingTraffic(right) - getSubscriptionUserInfoRemainingTraffic(left);
    if (remainingDiff !== 0) {
      return remainingDiff;
    }

    const totalDiff = (right.total || 0) - (left.total || 0);
    if (totalDiff !== 0) {
      return totalDiff;
    }

    return (right.expire || 0) - (left.expire || 0);
  })[0];

  return formatSubscriptionUserInfo(bestEntry);
}

function getUsageRemainingTraffic(usage) {
  if (!usage || typeof usage !== "object") {
    return 0;
  }

  if (typeof usage.remainingTraffic === "number" && Number.isFinite(usage.remainingTraffic)) {
    return usage.remainingTraffic;
  }

  const transferEnable = typeof usage.transferEnable === "number" ? usage.transferEnable : 0;
  const usedTotal = typeof usage.usedTotal === "number" ? usage.usedTotal : 0;
  return Math.max(transferEnable - usedTotal, 0);
}

function pickAggregateDisplayTarget(targets = []) {
  const sortableTargets = targets.filter((target) => target?.userState?.latestUsage);
  if (sortableTargets.length === 0) {
    return null;
  }

  return sortableTargets.sort((left, right) => {
    const usageLeft = left.userState.latestUsage;
    const usageRight = right.userState.latestUsage;
    const remainingDiff = getUsageRemainingTraffic(usageRight) - getUsageRemainingTraffic(usageLeft);
    if (remainingDiff !== 0) {
      return remainingDiff;
    }

    const transferDiff = (usageRight.transferEnable || 0) - (usageLeft.transferEnable || 0);
    if (transferDiff !== 0) {
      return transferDiff;
    }

    return toTimestamp(usageRight.expiredAt) - toTimestamp(usageLeft.expiredAt);
  })[0];
}

function pickAggregateSubscriptionUserInfoHeader(successfulFetches = []) {
  const displayTarget = pickAggregateDisplayTarget(successfulFetches.map((entry) => entry.target));
  const displayKey = displayTarget ? displayTarget.storageKey || displayTarget.upstreamId : "";

  if (displayKey) {
    const preferredEntry = successfulFetches.find(
      (entry) => (entry.target?.storageKey || entry.target?.upstreamId || "") === displayKey,
    );
    const preferredHeader = (preferredEntry?.payload?.headers?.["subscription-userinfo"] || "").trim();
    if (preferredHeader) {
      return preferredHeader;
    }
  }

  return mergeSubscriptionUserInfoHeaders(
    successfulFetches.map((entry) => entry.payload?.headers?.["subscription-userinfo"] || ""),
  );
}

function getAggregateRuntimeIntervalMinutes(targets = []) {
  const values = targets
    .map((target) => normalizeSubscriptionUpdateIntervalMinutes(target?.upstreamConfig?.subscriptionUpdateIntervalMinutes))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (values.length === 0) {
    return 30;
  }

  return Math.min(...values);
}

function getAggregateSupportedTypes(upstreams, targets = []) {
  const supportedTypes = new Set();

  targets.forEach((target) => {
    const upstream = getUpstreamSummary(upstreams, target.upstreamId);
    (Array.isArray(upstream?.supportedTypes) ? upstream.supportedTypes : []).forEach((type) => {
      supportedTypes.add(type);
    });
  });

  if (supportedTypes.size === 0) {
    RELAY_TYPES.forEach((type) => supportedTypes.add(type));
  }

  return Array.from(supportedTypes);
}

function getAggregateUpstreamSummary(upstreams, targets = [], sampleConfig = null) {
  const label = formatAggregateSelectionLabel(targets) || "聚合模式";

  return {
    id: "__aggregate__",
    label: "聚合模式",
    apiVersion: 1,
    moduleLabel: "aggregate",
    description: label,
    website: "",
    docsUrl: "",
    author: "",
    capabilities: {
      supportsStatusQuery: true,
      supportsInviteCode: false,
    },
    supportedTypes: getAggregateSupportedTypes(upstreams, targets),
    remark: label,
    settingFields: [],
    config: {
      enabled: true,
      name: "聚合模式",
      remark: label,
      runtimeMode: ACTIVE_UPSTREAM_MODES.AGGREGATE,
      trafficThresholdPercent: 0,
      maxRegistrationAgeMinutes: 0,
      subscriptionUpdateIntervalMinutes: getAggregateRuntimeIntervalMinutes(targets),
      inviteCode: "",
      ...(sampleConfig || {}),
    },
    active: true,
  };
}

function toTimestamp(value) {
  const timestamp = new Date(value || "").getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function pickLatestIso(values = []) {
  const sorted = values
    .map((value) => (value || "").toString().trim())
    .filter(Boolean)
    .sort((left, right) => toTimestamp(right) - toTimestamp(left));
  return sorted[0] || "";
}

function pickEarliestIso(values = []) {
  const sorted = values
    .map((value) => (value || "").toString().trim())
    .filter(Boolean)
    .sort((left, right) => toTimestamp(left) - toTimestamp(right));
  return sorted[0] || "";
}

function buildAggregateUsageSummary(targets = []) {
  const displayTarget = pickAggregateDisplayTarget(targets);
  const displayUsage = displayTarget?.userState?.latestUsage;

  if (!displayUsage) {
    return null;
  }

  return {
    ...displayUsage,
    email: displayUsage.email || `展示流量来源：${displayTarget.instanceLabel || displayTarget.upstreamId}`,
    planName: displayUsage.planName || "聚合模式",
    stat: {
      ...(displayUsage.stat && typeof displayUsage.stat === "object" ? displayUsage.stat : {}),
      aggregate: true,
      sourceCount: targets.length,
      displaySource: displayTarget.instanceLabel || displayTarget.upstreamId,
    },
    upstreamSite: formatAggregateSelectionLabel(targets),
  };
}

function buildAggregateHistory(targets = []) {
  return targets
    .flatMap((target) =>
      (Array.isArray(target?.userState?.history) ? target.userState.history : []).map((entry) => ({
        ...entry,
        title: `[${target.instanceLabel || target.upstreamId}] ${entry.title || ""}`.trim(),
        message: entry.message || "",
        details: {
          ...(entry.details && typeof entry.details === "object" ? entry.details : {}),
          aggregate: true,
          instanceLabel: target.instanceLabel || target.upstreamId,
          storageKey: target.storageKey || target.upstreamId,
        },
      })),
    )
    .sort((left, right) => toTimestamp(right.timestamp) - toTimestamp(left.timestamp))
    .slice(0, 120);
}

function buildAggregateUserState(targets = [], failures = []) {
  const successfulTargets = targets.filter((target) => target?.userState?.latestRegistration);
  const latestRegistration = successfulTargets.length
    ? {
        email: `已聚合 ${successfulTargets.length} 份上游`,
        password: "",
        inviteCode: "",
        createdAt: pickLatestIso(
          successfulTargets.map((target) => target.userState.latestRegistration?.createdAt),
        ),
        accountCreatedAt: pickEarliestIso(
          successfulTargets.map((target) => target.userState.latestRegistration?.accountCreatedAt),
        ),
        expiredAt: pickEarliestIso(
          successfulTargets.map((target) => target.userState.latestRegistration?.expiredAt),
        ),
        mock: successfulTargets.every((target) => Boolean(target.userState.latestRegistration?.mock)),
        upstreamSite: formatAggregateSelectionLabel(successfulTargets),
        apiBase: "",
        entryUrl: "",
        upstreamSource: "aggregate",
        lastUsageCheckAt: pickLatestIso(
          successfulTargets.map((target) => target.userState.latestRegistration?.lastUsageCheckAt),
        ),
      }
    : null;

  return {
    latestRegistration,
    latestUsage: buildAggregateUsageSummary(successfulTargets),
    history: buildAggregateHistory(successfulTargets),
    updatedAt: pickLatestIso(successfulTargets.map((target) => target.userState.updatedAt)),
    aggregateFailures: failures,
  };
}

function buildAggregateWarning(failures = []) {
  if (!Array.isArray(failures) || failures.length === 0) {
    return "";
  }

  return failures
    .map((failure) => `${failure.instanceLabel || failure.upstreamId}: ${failure.error?.message || "Unknown error."}`)
    .join(" | ");
}

function getContentTypeByRelayType(type, fallback = "text/plain; charset=utf-8") {
  if (type === "clash") {
    return "text/yaml; charset=utf-8";
  }
  if (type === "sing-box") {
    return "application/json; charset=utf-8";
  }
  return fallback;
}

function validateSubscriptionPayload(type, bodyBuffer) {
  const rawBody = Buffer.isBuffer(bodyBuffer) ? bodyBuffer.toString("utf8") : "";
  const trimmedBody = rawBody.trim();
  if (!trimmedBody) {
    throw new Error("Subscription returned an empty body.");
  }

  if (type === "clash") {
    const parsed = yaml.load(trimmedBody);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Clash subscription did not return a YAML object.");
    }

    const proxyNames = new Set(
      (Array.isArray(parsed.proxies) ? parsed.proxies : [])
        .map((proxy) => (proxy && typeof proxy === "object" ? proxy.name : ""))
        .filter(Boolean),
    );
    const groupNames = new Set(
      (Array.isArray(parsed["proxy-groups"]) ? parsed["proxy-groups"] : [])
        .map((group) => (group && typeof group === "object" ? group.name : ""))
        .filter(Boolean),
    );
    const builtinTargets = new Set(["DIRECT", "REJECT", "GLOBAL"]);

    (Array.isArray(parsed["proxy-groups"]) ? parsed["proxy-groups"] : []).forEach((group) => {
      if (!group || typeof group !== "object" || !Array.isArray(group.proxies)) {
        return;
      }

      group.proxies.forEach((target) => {
        if (
          typeof target === "string"
          && !proxyNames.has(target)
          && !groupNames.has(target)
          && !builtinTargets.has(target)
        ) {
          throw new Error(`Clash proxy group "${group.name || "unnamed"}" references an unknown target: ${target}`);
        }
      });
    });
    return;
  }

  if (type === "sing-box") {
    const parsed = JSON.parse(trimmedBody);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Sing-box subscription did not return a JSON object.");
    }
    return;
  }

  if (type === "universal") {
    const decoded = tryDecodeBase64(trimmedBody);
    if (decoded && /:\/\//.test(decoded)) {
      return;
    }

    if (!/:\/\//.test(trimmedBody)) {
      throw new Error("Universal subscription did not contain a valid node list.");
    }
  }
}

async function probeUpstreamSubscription(record, supportedTypes = []) {
  const availableTypes = Array.isArray(supportedTypes) && supportedTypes.length > 0
    ? supportedTypes.filter((type) => record?.clientUrls?.[type])
    : RELAY_TYPES.filter((type) => record?.clientUrls?.[type]);
  const preferredTypes = ["clash", "universal", "sing-box", ...availableTypes];
  const probeType = preferredTypes.find((type, index) =>
    record?.clientUrls?.[type] && preferredTypes.indexOf(type) === index) || "";

  if (!probeType) {
    return {
      verified: false,
      type: "",
      error: "No subscription URL is available for testing.",
    };
  }

  const response = await fetchUpstreamSubscription(record.clientUrls[probeType]);
  if (!response.ok) {
    throw new Error(`Subscription request failed with status ${response.status}.`);
  }

  await normalizeSubscriptionPayload(
    probeType,
    Buffer.from(await response.arrayBuffer()),
  );

  return {
    verified: true,
    type: probeType,
    error: "",
  };
}

async function fetchResolvedSubscriptionSource(source, type, requestMethod = "GET") {
  const latest = source?.userState?.latestRegistration;
  if (!latest) {
    throw new Error("No latest registration is available.");
  }

  const upstreamUrl = latest?.clientUrls?.[type];
  if (!upstreamUrl) {
    throw new Error(`Unsupported relay type: ${type}`);
  }

  const subscriptionUpdateIntervalMinutes = normalizeSubscriptionUpdateIntervalMinutes(
    source?.upstreamConfig?.subscriptionUpdateIntervalMinutes,
  );
  const profileUpdateIntervalHours = toProfileUpdateIntervalHours(subscriptionUpdateIntervalMinutes);

  if (latest.mock) {
    return {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "profile-title": `RelayHub Mock ${type}`,
        "profile-update-interval": profileUpdateIntervalHours,
      },
      body:
        requestMethod === "HEAD"
          ? Buffer.alloc(0)
          : Buffer.from(
              [
                "# Mock relay subscription",
                `type=${type}`,
                `email=${latest.email}`,
                `createdAt=${latest.createdAt || ""}`,
              ].join("\n"),
              "utf8",
            ),
    };
  }

  const upstreamResponse = await fetchUpstreamSubscription(upstreamUrl);
  if (!upstreamResponse.ok) {
    const nextError = new Error(
      `Upstream subscription request failed with status ${upstreamResponse.status}.`,
    );
    nextError.status = upstreamResponse.status;
    throw nextError;
  }

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
  headers["content-type"] = getContentTypeByRelayType(
    type,
    headers["content-type"] || "text/plain; charset=utf-8",
  );

  const body =
    requestMethod === "HEAD"
      ? Buffer.alloc(0)
      : await normalizeSubscriptionPayload(type, Buffer.from(await upstreamResponse.arrayBuffer()));

  return {
    headers,
    body,
  };
}

async function buildAggregateResponse(request, userKey, type, targets, failures = [], warning = "") {
  const relayToken = await getRelayToken(userKey);
  const relayUrls = buildRelayUrls(await getRequestOrigin(request), relayToken);
  const upstreams = await listUpstreamConfigs();
  const user = RELAY_USERS.find((item) => item.key === userKey) || RELAY_USERS[0];
  const aggregateUpstream = getAggregateUpstreamSummary(upstreams, targets);
  const aggregateUserState = buildAggregateUserState(targets, failures);
  const aggregateWarning = [warning, buildAggregateWarning(failures)].filter(Boolean).join(" | ");

  return {
    ...shapeRegistrationResponse(
      user,
      aggregateUpstream,
      aggregateUserState,
      type,
      relayUrls,
      aggregateWarning,
    ),
    aggregate: {
      enabled: true,
      label: formatAggregateSelectionLabel(targets),
      sourceCount: targets.length,
      failureCount: failures.length,
      sources: targets.map((target) => ({
        upstreamId: target.upstreamId,
        storageKey: target.storageKey,
        instanceNumber: target.instanceNumber,
        label: target.instanceLabel || target.upstreamId,
        hasRegistration: Boolean(target?.userState?.latestRegistration),
      })),
    },
  };
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
    { activeUpstreamId, activeUpstreamMode, upstreamOrder, upstreamAggregation },
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
    upstreamAggregation,
    upstreams,
    runtimeModes: {
      alwaysRefresh: RUNTIME_MODES.ALWAYS_REFRESH,
      smartUsage: RUNTIME_MODES.SMART_USAGE,
    },
    activeUpstreamModes: {
      single: ACTIVE_UPSTREAM_MODES.SINGLE,
      polling: ACTIVE_UPSTREAM_MODES.POLLING,
      aggregate: ACTIVE_UPSTREAM_MODES.AGGREGATE,
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
    upstreamAggregation: body.upstreamAggregation,
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
    upstreamAggregation: result.upstreamAggregation,
    upstreamCloud: result.upstreamCloud,
    updatedAt: result.updatedAt,
    upstreamConfig: result.upstreamConfig,
  });
}

async function handleTestUpstream(request, response) {
  const body = await readJsonBody(request);
  const upstreamId = (body.upstreamId || "").toString().trim();
  if (!upstreamId) {
    sendJson(response, 400, {
      success: false,
      error: "Upstream is required.",
    });
    return;
  }

  const module = getUpstreamModule(upstreamId);
  if (!module) {
    sendJson(response, 404, {
      success: false,
      error: "Upstream not found.",
    });
    return;
  }

  const currentConfig = (await getUpstreamConfig(upstreamId)) || module.normalizeSettings({});
  const testConfig = module.applySettingsPatch(currentConfig, {
    name: body.name,
    remark: body.remark,
    enabled: body.enabled,
    inviteCode: body.inviteCode,
    runtimeMode: body.runtimeMode,
    trafficThresholdPercent: body.trafficThresholdPercent,
    maxRegistrationAgeMinutes: body.maxRegistrationAgeMinutes,
    subscriptionUpdateIntervalMinutes: body.subscriptionUpdateIntervalMinutes,
    providerSettings: body.providerSettings,
  });

  const record = await module.register({
    inviteCode: (body.inviteCode || testConfig.inviteCode || "").toString().trim(),
    upstreamConfig: testConfig,
    verbose: false,
    logger: console,
  });

  let usage = null;
  let queryError = "";
  if (module.manifest?.capabilities?.supportsStatusQuery !== false) {
    try {
      usage = await module.query({
        record,
        upstreamConfig: testConfig,
        verbose: false,
        logger: console,
      });
    } catch (error) {
      queryError = error.message;
    }
  }

  let subscriptionTest = null;
  let subscriptionError = "";
  try {
    subscriptionTest = await probeUpstreamSubscription(
      record,
      Array.isArray(module.manifest?.supportedTypes) ? module.manifest.supportedTypes : [],
    );
  } catch (error) {
    subscriptionError = error.message;
  }

  sendJson(response, 200, {
    success: true,
    message: subscriptionError
      ? `Upstream registration succeeded, but subscription verification failed: ${subscriptionError}`
      : queryError
      ? `Upstream registration succeeded, but status query failed: ${queryError}`
      : "Upstream test succeeded.",
    test: {
      upstreamId,
      label: testConfig.name || module.manifest.label || upstreamId,
      supportedTypes: Array.isArray(module.manifest.supportedTypes) ? module.manifest.supportedTypes : [],
      registration: {
        email: record.email || "",
        upstreamSite: record.upstreamSite || "",
      },
      queryVerified: Boolean(usage),
      queryError,
      subscriptionVerified: Boolean(subscriptionTest?.verified),
      subscriptionType: subscriptionTest?.type || "",
      subscriptionError,
    },
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

  if (result.restartRequired && result.shouldExitCurrentProcess) {
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

  const runtime = await getActiveUpstreamRuntime();
  if (
    !requestedUpstreamId &&
    runtime.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.AGGREGATE
  ) {
    const aggregateResult = await manualRegisterAggregateWithRuntime(userKey, {
      relayType: type === "full" ? "universal" : type,
    });

    sendJson(response, 200, {
      success: true,
      message: "Aggregate registration completed.",
      ...(await buildAggregateResponse(
        request,
        userKey,
        type,
        aggregateResult.targets,
        aggregateResult.failures,
      )),
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
    result.upstreamId || requestedUpstreamId || runtime.activeUpstreamId,
  );
  const user = RELAY_USERS.find((item) => item.key === userKey) || RELAY_USERS[0];

  sendJson(response, 200, {
    success: true,
    message: "Registration completed.",
    ...shapeRegistrationResponse(user, upstream, result.userState, type, relayUrls),
  });
}

async function handleGenerateQrCode(request, response) {
  const body = await readJsonBody(request);
  const text = typeof body.text === "string" ? body.text.trim() : "";

  if (!text) {
    sendJson(response, 400, {
      success: false,
      error: "QR text is required.",
    });
    return;
  }

  if (text.length > 4096) {
    sendJson(response, 400, {
      success: false,
      error: "QR text is too long.",
    });
    return;
  }

  const dataUrl = await QRCode.toDataURL(text, {
    type: "image/png",
    width: 320,
    margin: 1,
    errorCorrectionLevel: "M",
    color: {
      dark: "#0f172a",
      light: "#ffffff",
    },
  });

  sendJson(response, 200, {
    success: true,
    dataUrl,
  });
}

async function handleLatestSubscription(request, response, url) {
  const type = normalizeType(url.searchParams.get("type"));
  const userKey = normalizeUserKey(url.searchParams.get("user"));
  const runtime = await getActiveUpstreamRuntime();
  const upstreamId = (url.searchParams.get("upstreamId") || runtime.activeUpstreamId).toString();

  if (!SUPPORTED_TYPES.has(type)) {
    sendJson(response, 400, {
      success: false,
      error: `Unsupported type: ${type}`,
      supportedTypes: Array.from(SUPPORTED_TYPES),
    });
    return;
  }

  if (!url.searchParams.get("upstreamId") && runtime.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.AGGREGATE) {
    const result = await resolveAggregateViewStates(userKey, type === "full" ? "universal" : type);

    sendJson(response, 200, {
      success: true,
      message: result.targets.length > 0
        ? "Latest aggregate user state returned."
        : "Current aggregate has no registration yet.",
      ...(await buildAggregateResponse(
        request,
        userKey,
        type,
        result.targets,
        result.failures,
      )),
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

  const runtime = await getActiveUpstreamRuntime();
  if (runtime.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.AGGREGATE) {
    const aggregateResult = await resolveAggregateRelayStates(relayUser.key, type);
    if (aggregateResult.targets.length === 0) {
      sendText(response, 503, "No aggregate upstream is available.");
      return;
    }

    const fetchResults = await Promise.allSettled(
      aggregateResult.targets.map(async (target) => {
        const payload = await fetchResolvedSubscriptionSource(target, type, request.method);
        await appendUserHistory(relayUser.key, target.storageKey || target.upstreamId, {
          action: "relay_success",
          title: "已成功中转聚合订阅",
          message: `客户端成功拉取 ${type} 聚合订阅。`,
          mode: ACTIVE_UPSTREAM_MODES.AGGREGATE,
          relayType: type,
          requestSource: "relay",
          registration: target?.userState?.latestRegistration || null,
          usage: target?.userState?.latestUsage || null,
          details: {
            aggregate: true,
            instanceLabel: target.instanceLabel || target.upstreamId,
            storageKey: target.storageKey || target.upstreamId,
          },
        });
        return {
          target,
          payload,
        };
      }),
    );

    const successfulFetches = [];
    const failedFetches = [...aggregateResult.failures];

    fetchResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        successfulFetches.push(result.value);
        return;
      }

      const failedTarget = aggregateResult.targets[index] || null;
      if (failedTarget) {
        appendUserHistory(relayUser.key, failedTarget.storageKey || failedTarget.upstreamId, {
          action: "relay_failed",
          title: "聚合订阅拉取失败",
          message:
            result.reason instanceof Error ? result.reason.message : `${result.reason || "Unknown error."}`,
          mode: ACTIVE_UPSTREAM_MODES.AGGREGATE,
          relayType: type,
          requestSource: "relay",
          registration: failedTarget?.userState?.latestRegistration || null,
          usage: failedTarget?.userState?.latestUsage || null,
          details: {
            aggregate: true,
            instanceLabel: failedTarget.instanceLabel || failedTarget.upstreamId,
            storageKey: failedTarget.storageKey || failedTarget.upstreamId,
          },
        }).catch(() => undefined);
      }
      failedFetches.push({
        ...(failedTarget || {}),
        error: result.reason instanceof Error ? result.reason : new Error(`${result.reason || "Unknown error."}`),
      });
    });

    if (successfulFetches.length === 0) {
      sendText(
        response,
        502,
        `Aggregate subscription request failed: ${buildAggregateWarning(failedFetches) || "Unknown error."}`,
      );
      return;
    }

    const mergedIntervalHours = toProfileUpdateIntervalHours(
      getAggregateRuntimeIntervalMinutes(successfulFetches.map((entry) => entry.target)),
    );
    const mergedHeaders = {
      "content-type": getContentTypeByRelayType(
        type,
        successfulFetches[0]?.payload?.headers?.["content-type"] || "text/plain; charset=utf-8",
      ),
      "profile-title": `RelayHub Aggregate ${type}`,
      "profile-update-interval": mergedIntervalHours,
    };
    const mergedUserInfo = pickAggregateSubscriptionUserInfoHeader(successfulFetches);
    if (mergedUserInfo) {
      mergedHeaders["subscription-userinfo"] = mergedUserInfo;
    }

    response.writeHead(200, mergedHeaders);
    if (request.method === "HEAD") {
      response.end();
      return;
    }

    const clashTemplate = type === "clash" ? await loadAggregateClashTemplate() : null;
    const mergedBody = sanitizeSubscriptionBody(
      mergeSubscriptionBodies(
        type,
        successfulFetches.map((entry) => ({
          body: entry.payload.body,
          sourceLabel: entry.target.instanceLabel || entry.target.upstreamId,
        })),
        {
          clashTemplate,
        },
      ),
    );
    validateSubscriptionPayload(type, mergedBody);
    response.end(mergedBody);
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

      const subscriptionUpdateIntervalMinutes = normalizeSubscriptionUpdateIntervalMinutes(
        upstreamConfig?.subscriptionUpdateIntervalMinutes,
      );
      const profileUpdateIntervalHours = toProfileUpdateIntervalHours(
        subscriptionUpdateIntervalMinutes,
      );

      if (!latest?.clientUrls?.[type]) {
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
            "profile-title": `RelayHub Mock ${type}`,
            "profile-update-interval": profileUpdateIntervalHours,
          },
        );
        return;
      }

      const payload = await fetchResolvedSubscriptionSource(
        {
          upstreamConfig,
          userState,
        },
        type,
        request.method,
      );

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

      response.writeHead(200, payload.headers);

      if (request.method === "HEAD") {
        response.end();
        return;
      }

      response.end(payload.body);
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
  const runtime = await getActiveUpstreamRuntime();
  const latestRegistrationAvailable =
    runtime.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.AGGREGATE
      ? Object.values(relayState.users || {}).some((userState) =>
          (runtime.upstreamAggregation?.counts ? Object.entries(runtime.upstreamAggregation.counts) : []).some(
            ([upstreamId, copies]) => {
              const count = Number.parseInt(copies, 10);
              if (!Number.isFinite(count) || count <= 0) {
                return false;
              }

              return Array.from({ length: count }).some((_, index) => {
                const storageKey = index === 0 ? upstreamId : `${upstreamId}::${index + 1}`;
                return Boolean(userState?.upstreams?.[storageKey]?.latestRegistration);
              });
            },
          ),
        )
      : Object.values(relayState.users || {}).some((userState) =>
          Boolean(userState?.upstreams?.[runtime.activeUpstreamId]?.latestRegistration),
        );

  sendJson(response, 200, {
    success: true,
    status: "ok",
    activeUpstreamId: runtime.activeUpstreamId,
    activeUpstreamMode: runtime.activeUpstreamMode,
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

      if (request.method === "POST" && url.pathname === "/api/upstreams/test") {
        await handleTestUpstream(request, response);
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

      if (request.method === "POST" && url.pathname === "/api/qrcode") {
        await handleGenerateQrCode(request, response);
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
