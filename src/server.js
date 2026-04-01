"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const QRCode = require("qrcode");
const yaml = require("js-yaml");

const {
  getAggregateCacheEntry,
  getAggregateCacheScheduler,
  getAggregateCacheUserState,
  replaceAggregateCacheUserState,
  updateAggregateCacheScheduler,
} = require("./aggregateCacheStore");
const { ensureProxyConfigured } = require("./httpClient");
const {
  ACTIVE_UPSTREAM_MODES,
  DEFAULT_AGGREGATE_PREREGISTRATION_INTERVAL_MINUTES,
  DEFAULT_AGGREGATE_PREREGISTRATION_MAX_SOURCES,
  DEFAULT_AGGREGATE_TIMEOUT_SECONDS,
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
  normalizeAggregateTimeoutSeconds,
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
  updateUserState,
} = require("./registrationStore");
const {
  getUpstreamModule,
  listUpstreamModuleDiagnostics,
  reloadUpstreamModules,
} = require("./upstreams/core/registry");
const { loadAggregateClashTemplate } = require("./aggregateClashTemplate");
const { mergeSubscriptionBodies } = require("./subscriptionMerger");
const { URL_TYPES } = require("./upstreams/shared/snailApi");
const { BROWSER_UA } = require("./upstreams/shared/upstreamUtils");
const {
  getRuntimeAggregateTargets,
  getRuntimeCandidateUpstreamIds,
  manualRegisterAggregateWithRuntime,
  manualRegisterWithRuntime,
  mergeRegistrationWithUsage,
  queryCurrentUsage,
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
const MIN_SNAIL_SERVER_NODE_COUNT = Math.max(
  1,
  Number.parseInt(process.env.MIN_SNAIL_SERVER_NODE_COUNT || "2", 10) || 2,
);
const publicDir = path.join(__dirname, "..", "public");
const sessions = new Map();
let aggregatePreRegistrationTimer = null;
let aggregatePreRegistrationJob = null;
let aggregatePreRegistrationImmediateRequested = false;
let directFetchDispatcher = null;

const RELAY_TYPES = Object.keys(URL_TYPES);
const SUPPORTED_TYPES = new Set(["full", ...RELAY_TYPES]);
const AGGREGATE_STORAGE_DELIMITER = "::";
const SUBSCRIPTION_FETCH_ACCEPT =
  "text/plain, application/yaml, application/x-yaml, text/yaml, application/json, */*";
const SUBSCRIPTION_FETCH_PROFILE_DEFINITIONS = {
  browser: {
    key: "browser",
    headers: {
      Accept: SUBSCRIPTION_FETCH_ACCEPT,
      "User-Agent": BROWSER_UA,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  },
  clash: {
    key: "clash",
    headers: {
      Accept: SUBSCRIPTION_FETCH_ACCEPT,
      "User-Agent": "Clash",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  },
  mihomo: {
    key: "mihomo",
    headers: {
      Accept: SUBSCRIPTION_FETCH_ACCEPT,
      "User-Agent": "Mihomo",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  },
  clashVerge: {
    key: "clashVerge",
    headers: {
      Accept: SUBSCRIPTION_FETCH_ACCEPT,
      "User-Agent": "clash-verge/v1.7.7",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  },
  quantumultx: {
    key: "quantumultx",
    headers: {
      Accept: SUBSCRIPTION_FETCH_ACCEPT,
      "User-Agent": "Quantumult X",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  },
  shadowrocket: {
    key: "shadowrocket",
    headers: {
      Accept: SUBSCRIPTION_FETCH_ACCEPT,
      "User-Agent": "Shadowrocket/2.2.77",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  },
  surge: {
    key: "surge",
    headers: {
      Accept: SUBSCRIPTION_FETCH_ACCEPT,
      "User-Agent": "Surge iOS/3000",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  },
  nekoBox: {
    key: "nekoBox",
    headers: {
      Accept: SUBSCRIPTION_FETCH_ACCEPT,
      "User-Agent": "NekoBox/Windows",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  },
};
const SUBSCRIPTION_FETCH_PROFILE_KEYS_BY_TYPE = {
  universal: ["mihomo", "quantumultx", "shadowrocket", "browser"],
  clash: ["mihomo", "clash", "clashVerge", "browser"],
  shadowrocket: ["shadowrocket", "quantumultx", "mihomo", "browser"],
  surge: ["surge", "shadowrocket", "mihomo", "browser"],
  quantumultx: ["quantumultx", "shadowrocket", "mihomo", "browser"],
  "sing-box": ["nekoBox", "mihomo", "browser"],
};
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

function buildSubscriptionRequestProfiles(type = "") {
  const normalizedType = (type || "").toString().trim().toLowerCase();
  const orderedKeys = [
    ...(SUBSCRIPTION_FETCH_PROFILE_KEYS_BY_TYPE[normalizedType] || []),
    "browser",
  ];
  const seen = new Set();

  return orderedKeys
    .map((key) => {
      const definition = SUBSCRIPTION_FETCH_PROFILE_DEFINITIONS[key];
      if (!definition || seen.has(definition.key)) {
        return null;
      }
      seen.add(definition.key);
      return {
        key: definition.key,
        headers: {
          ...(definition.headers || {}),
        },
      };
    })
    .filter(Boolean);
}

function buildScopedRelayUrls(origin, relayToken, upstreamId = "") {
  const baseUrls = buildRelayUrls(origin, relayToken);
  const normalizedUpstreamId = (upstreamId || "").toString().trim();
  if (!normalizedUpstreamId) {
    return baseUrls;
  }

  return Object.fromEntries(
    Object.entries(baseUrls).map(([type, url]) => {
      const scopedUrl = new URL(url);
      scopedUrl.searchParams.set("upstreamId", normalizedUpstreamId);
      return [type, scopedUrl.toString()];
    }),
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

function splitClashRuleSegments(rule) {
  const segments = [];
  let current = "";
  let quote = "";
  let parenthesesDepth = 0;
  let bracketDepth = 0;

  for (const character of String(rule || "")) {
    if (quote) {
      current += character;
      if (character === quote) {
        quote = "";
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      current += character;
      continue;
    }

    if (character === "(") {
      parenthesesDepth += 1;
      current += character;
      continue;
    }

    if (character === ")") {
      parenthesesDepth = Math.max(0, parenthesesDepth - 1);
      current += character;
      continue;
    }

    if (character === "[") {
      bracketDepth += 1;
      current += character;
      continue;
    }

    if (character === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += character;
      continue;
    }

    if (character === "," && parenthesesDepth === 0 && bracketDepth === 0) {
      segments.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  segments.push(current.trim());
  return segments;
}

function getClashRuleTargetIndex(rule) {
  const segments = splitClashRuleSegments(rule);
  if (segments.length === 0) {
    return -1;
  }

  const ruleType = segments[0].toUpperCase();
  if (ruleType === "MATCH" || ruleType === "FINAL") {
    return segments.length >= 2 ? 1 : -1;
  }

  if (ruleType === "AND" || ruleType === "OR" || ruleType === "NOT") {
    return segments.length >= 2 ? segments.length - 1 : -1;
  }

  return segments.length >= 3 ? 2 : -1;
}

function sanitizeClashRule(rule, nameMap) {
  if (typeof rule !== "string" || nameMap.size === 0) {
    return rule;
  }

  const segments = splitClashRuleSegments(rule);
  const targetIndex = getClashRuleTargetIndex(rule);
  if (targetIndex < 0 || targetIndex >= segments.length) {
    return rule;
  }

  const target = segments[targetIndex];
  if (!nameMap.has(target)) {
    return rule;
  }

  segments[targetIndex] = nameMap.get(target);
  return segments.join(",");
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
        if (parentKey === "rules") {
          return value.map((item) => sanitizeClashRule(item, nameMap));
        }

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

    if (nameMap.size > 0) {
      result = result.replace(/(^\s*-\s*)(.+)$/gm, (match, prefix, content) => {
        const sanitizedRule = sanitizeClashRule(content, nameMap);
        return sanitizedRule === content ? match : `${prefix}${sanitizedRule}`;
      });
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

function filterUrlMapBySupportedTypes(urls, supportedTypes) {
  if (!urls || typeof urls !== "object") {
    return {};
  }

  const allowedTypes = Array.isArray(supportedTypes) && supportedTypes.length > 0
    ? supportedTypes
    : Object.keys(urls);

  return Object.fromEntries(
    Object.entries(urls).filter(([type]) => allowedTypes.includes(type)),
  );
}

function shapeRegistrationResponse(user, upstream, userState, type, relayUrls, warning = "") {
  const filteredRelayUrls = filterUrlMapBySupportedTypes(relayUrls, upstream?.supportedTypes);
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

function normalizeRequestTimeoutMs(timeoutMs, fallbackMs = RELAY_FETCH_TIMEOUT_MS) {
  const parsed = Number.parseInt(timeoutMs, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMs;
  }

  return Math.max(1, Math.min(parsed, fallbackMs));
}

function getDirectFetchDispatcher() {
  if (directFetchDispatcher) {
    return directFetchDispatcher;
  }

  const { Agent } = require("undici");
  directFetchDispatcher = new Agent({
    connect: {
      rejectUnauthorized: false,
    },
  });
  return directFetchDispatcher;
}

async function fetchUpstreamSubscription(upstreamUrl, timeoutMs = RELAY_FETCH_TIMEOUT_MS, options = {}) {
  ensureProxyConfigured();
  const requestHeaders =
    options.headers && typeof options.headers === "object" && !Array.isArray(options.headers)
      ? options.headers
      : undefined;

  if (options.direct === true) {
    const { request } = require("undici");
    const response = await request(upstreamUrl, {
      dispatcher: getDirectFetchDispatcher(),
      headers: requestHeaders,
      headersTimeout: normalizeRequestTimeoutMs(timeoutMs),
      bodyTimeout: normalizeRequestTimeoutMs(timeoutMs),
      maxRedirections: 3,
    });
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      headers: {
        forEach(callback) {
          Object.entries(response.headers || {}).forEach(([key, value]) => {
            if (Array.isArray(value)) {
              value.forEach((item) => callback(item, key));
              return;
            }
            callback(value, key);
          });
        },
        get(name) {
          const value = response.headers?.[(name || "").toLowerCase()];
          if (Array.isArray(value)) {
            return value.join(", ");
          }
          return value || null;
        },
      },
      arrayBuffer: async () => {
        const bodyBuffer = Buffer.from(await response.body.arrayBuffer());
        return bodyBuffer.buffer.slice(
          bodyBuffer.byteOffset,
          bodyBuffer.byteOffset + bodyBuffer.byteLength,
        );
      },
    };
  }

  const requestOptions = {
    headers: requestHeaders,
    signal: AbortSignal.timeout(normalizeRequestTimeoutMs(timeoutMs)),
  };

  return fetch(upstreamUrl, requestOptions);
}

function countSubscriptionNodes(type, bodyBuffer) {
  const rawBody = Buffer.isBuffer(bodyBuffer) ? bodyBuffer.toString("utf8").trim() : "";
  if (!rawBody) {
    return 0;
  }

  if (type === "clash") {
    try {
      const parsed = yaml.load(rawBody);
      if (Array.isArray(parsed)) {
        return parsed.filter((item) => item && typeof item === "object").length;
      }
      return Array.isArray(parsed?.proxies) ? parsed.proxies.length : 0;
    } catch {
      return 0;
    }
  }

  if (type === "sing-box") {
    try {
      const parsed = JSON.parse(rawBody);
      return Array.isArray(parsed?.outbounds) ? parsed.outbounds.length : 0;
    } catch {
      return 0;
    }
  }

  const decoded = tryDecodeBase64(rawBody);
  const subscriptionText = decoded && /:\/\//.test(decoded) ? decoded : rawBody;
  return subscriptionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /:\/\//.test(line))
    .length;
}

function isSnailDefaultUpstream(source = {}) {
  return (source?.upstreamId || "").toString().trim() === "snail-default";
}

function shouldRedirectRelayToUpstream(source = {}, type = "") {
  if (!isSnailDefaultUpstream(source)) {
    return false;
  }

  const latestRegistration = source?.userState?.latestRegistration;
  if (!latestRegistration || latestRegistration.mock) {
    return false;
  }

  return Boolean((latestRegistration?.clientUrls?.[type] || "").toString().trim());
}

function getRelayUpstreamRedirectLocation(source = {}, type = "") {
  if (!shouldRedirectRelayToUpstream(source, type)) {
    return "";
  }

  return (source?.userState?.latestRegistration?.clientUrls?.[type] || "").toString().trim();
}

function isDegradedSnailServerNodeCount(upstreamId = "", nodeCount = 0) {
  const parsedNodeCount = Number.parseInt(nodeCount, 10);
  return (upstreamId || "").toString().trim() === "snail-default"
    && Number.isFinite(parsedNodeCount)
    && parsedNodeCount > 0
    && parsedNodeCount < MIN_SNAIL_SERVER_NODE_COUNT;
}

function isDegradedServerSidePayload(source = {}, payload = {}, requestMethod = "GET") {
  if ((requestMethod || "GET").toUpperCase() === "HEAD") {
    return false;
  }

  return isDegradedSnailServerNodeCount(source?.upstreamId, payload?.meta?.nodeCount);
}

function createDegradedServerSidePayloadError(source = {}, payload = {}) {
  const nodeCount = Number.parseInt(payload?.meta?.nodeCount, 10) || 0;
  const requestProfileKey = (payload?.meta?.requestProfileKey || "").toString().trim();
  const transportKey = (payload?.meta?.transportKey || "").toString().trim();
  const messageParts = [
    `Server-side fetch returned only ${nodeCount} node(s)`,
    `for ${(source?.upstreamId || "upstream").toString().trim() || "upstream"}`,
  ];

  if (requestProfileKey) {
    messageParts.push(`using ${requestProfileKey}`);
  }
  if (transportKey) {
    messageParts.push(`via ${transportKey}`);
  }

  const error = new Error(`${messageParts.join(" ")}; treating it as degraded payload.`);
  error.code = "DEGRADED_SERVER_SIDE_PAYLOAD";
  error.status = 502;
  return error;
}

async function fetchPreferredSubscriptionPayload(type, upstreamUrl, requestTimeoutMs, requestMethod = "GET") {
  const requestProfiles = buildSubscriptionRequestProfiles(type);
  const attemptConfigs = requestProfiles.flatMap((profile, profileIndex) => ([
    {
      key: `direct:${profile.key}`,
      direct: true,
      transportKey: "direct",
      requestProfileKey: profile.key,
      requestProfileIndex: profileIndex,
      headers: profile.headers,
    },
    {
      key: `proxy:${profile.key}`,
      direct: false,
      transportKey: "proxy",
      requestProfileKey: profile.key,
      requestProfileIndex: profileIndex,
      headers: profile.headers,
    },
  ]));
  const attemptResults = await Promise.all(
    attemptConfigs.map(async (config) => {
      try {
        const response = await fetchUpstreamSubscription(upstreamUrl, requestTimeoutMs, {
          direct: config.direct,
          headers: config.headers,
        });
        if (!response.ok) {
          return {
            key: config.key,
            ok: false,
            status: response.status,
            transportKey: config.transportKey,
            requestProfileKey: config.requestProfileKey,
            requestProfileIndex: config.requestProfileIndex,
            error: new Error(`Upstream subscription request failed with status ${response.status}.`),
          };
        }

        const headers = {};
        response.headers.forEach((value, key) => {
          const normalizedKey = key.toLowerCase();
          if (FORWARDED_HEADERS.has(normalizedKey)) {
            headers[normalizedKey] = value;
          }
        });

        const body =
          requestMethod === "HEAD"
            ? Buffer.alloc(0)
            : await normalizeSubscriptionPayload(type, Buffer.from(await response.arrayBuffer()));

        return {
          key: config.key,
          ok: true,
          transportKey: config.transportKey,
          requestProfileKey: config.requestProfileKey,
          requestProfileIndex: config.requestProfileIndex,
          headers,
          body,
          nodeCount: requestMethod === "HEAD" ? 0 : countSubscriptionNodes(type, body),
        };
      } catch (error) {
        return {
          key: config.key,
          ok: false,
          status: error?.status || null,
          transportKey: config.transportKey,
          requestProfileKey: config.requestProfileKey,
          requestProfileIndex: config.requestProfileIndex,
          error,
        };
      }
    }),
  );

  const successful = attemptResults.filter((entry) => entry.ok);
  if (successful.length === 0) {
    const proxyFailure = attemptResults.find((entry) => entry.transportKey === "proxy" && entry.error);
    const directFailure = attemptResults.find((entry) => entry.transportKey === "direct" && entry.error);
    throw proxyFailure?.error || directFailure?.error || new Error("Upstream subscription request failed.");
  }

  successful.sort((left, right) => {
    if ((right.nodeCount || 0) !== (left.nodeCount || 0)) {
      return (right.nodeCount || 0) - (left.nodeCount || 0);
    }
    if ((left.requestProfileIndex || 0) !== (right.requestProfileIndex || 0)) {
      return (left.requestProfileIndex || 0) - (right.requestProfileIndex || 0);
    }
    if (left.transportKey === right.transportKey) {
      return 0;
    }
    return left.transportKey === "direct" ? -1 : 1;
  });

  return successful[0];
}

async function fetchFallbackSubscriptionUserInfoHeader(
  clientUrls,
  requestedType,
  timeoutMs = RELAY_FETCH_TIMEOUT_MS,
) {
  if (!clientUrls || requestedType === "clash") {
    return "";
  }

  const clashUrl = clientUrls.clash;
  const requestedUrl = clientUrls[requestedType];
  if (!clashUrl || clashUrl === requestedUrl) {
    return "";
  }

  try {
    const fallbackResponse = await fetchPreferredSubscriptionPayload("clash", clashUrl, timeoutMs, "GET");
    const fallbackHeader = (fallbackResponse.headers?.["subscription-userinfo"] || "").trim();
    return fallbackHeader;
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

function buildAggregateStorageKey(upstreamId, instanceNumber = 1) {
  const normalizedInstanceNumber = Number.parseInt(instanceNumber, 10);
  if (!Number.isFinite(normalizedInstanceNumber) || normalizedInstanceNumber <= 1) {
    return upstreamId;
  }

  return `${upstreamId}${AGGREGATE_STORAGE_DELIMITER}${normalizedInstanceNumber}`;
}

function createEmptyViewUserState() {
  return {
    latestRegistration: null,
    latestUsage: null,
    history: [],
    updatedAt: null,
  };
}

function getOrderedRuntimeUpstreams(runtime, upstreams) {
  const upstreamMap = new Map(
    (Array.isArray(upstreams) ? upstreams : [])
      .filter((upstream) => upstream?.id)
      .map((upstream) => [upstream.id, upstream]),
  );
  const orderedIds =
    Array.isArray(runtime?.upstreamOrder) && runtime.upstreamOrder.length > 0
      ? runtime.upstreamOrder.filter((upstreamId) => upstreamMap.has(upstreamId))
      : Array.from(upstreamMap.keys());

  return orderedIds.map((upstreamId) => upstreamMap.get(upstreamId)).filter(Boolean);
}

function buildLocalAggregateTargets(relayState, userKey, runtime, upstreams) {
  const counts =
    runtime?.upstreamAggregation?.counts && typeof runtime.upstreamAggregation.counts === "object"
      ? runtime.upstreamAggregation.counts
      : {};
  const userUpstreams =
    relayState?.users?.[userKey]?.upstreams && typeof relayState.users[userKey].upstreams === "object"
      ? relayState.users[userKey].upstreams
      : {};

  return getOrderedRuntimeUpstreams(runtime, upstreams).flatMap((upstream) => {
    if (upstream?.config?.enabled === false) {
      return [];
    }

    const rawCopies = Number.parseInt(counts[upstream.id], 10);
    const copies = Number.isFinite(rawCopies) && rawCopies > 0 ? rawCopies : 0;
    if (copies <= 0) {
      return [];
    }

    const baseLabel = upstream.label || upstream.id;
    return Array.from({ length: copies }, (_, index) => {
      const instanceNumber = index + 1;
      const storageKey = buildAggregateStorageKey(upstream.id, instanceNumber);
      return {
        upstreamId: upstream.id,
        storageKey,
        instanceNumber,
        instanceLabel: copies > 1 ? `${baseLabel} #${instanceNumber}` : baseLabel,
        upstreamConfig: upstream.config || null,
        userState:
          userUpstreams[storageKey] && typeof userUpstreams[storageKey] === "object"
            ? userUpstreams[storageKey]
            : createEmptyViewUserState(),
      };
    });
  });
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

function getAggregateTimeoutSeconds(upstreamAggregation = {}) {
  return normalizeAggregateTimeoutSeconds(
    upstreamAggregation?.timeoutSeconds,
    DEFAULT_AGGREGATE_TIMEOUT_SECONDS,
  );
}

function getAggregateTimeoutMs(upstreamAggregation = {}) {
  return getAggregateTimeoutSeconds(upstreamAggregation) * 1000;
}

function getAggregatePreRegistrationSettings(upstreamAggregation = {}) {
  const source =
    upstreamAggregation?.preRegistration && typeof upstreamAggregation.preRegistration === "object"
      ? upstreamAggregation.preRegistration
      : {};

  return {
    enabled: Boolean(source.enabled),
    intervalMinutes: Math.max(
      1,
      normalizeSubscriptionUpdateIntervalMinutes(
        source.intervalMinutes,
        DEFAULT_AGGREGATE_PREREGISTRATION_INTERVAL_MINUTES,
      ),
    ),
    maxSources: Math.max(
      1,
      Math.min(
        50,
        Number.parseInt(
          source.maxSources || `${DEFAULT_AGGREGATE_PREREGISTRATION_MAX_SOURCES}`,
          10,
        ) || DEFAULT_AGGREGATE_PREREGISTRATION_MAX_SOURCES,
      ),
    ),
  };
}

function buildAggregateTargetSignature(targets = []) {
  return (Array.isArray(targets) ? targets : [])
    .map((target) => target?.storageKey || target?.upstreamId || "")
    .filter(Boolean)
    .join("|");
}

function buildAggregateExecutionKey(target = {}) {
  return target.storageKey || `${target.upstreamId || "upstream"}:${target.instanceNumber || 1}`;
}

function normalizeAggregateExecutionError(error) {
  if (error instanceof Error) {
    return error;
  }

  return new Error(`${error || "Unknown error."}`);
}

function createAggregateRequestTimeoutError(timeoutSeconds) {
  const error = new Error(`聚合请求超过 ${timeoutSeconds} 秒，已跳过该实例。`);
  error.code = "AGGREGATE_TIMEOUT";
  return error;
}

async function collectAggregateExecutionResults(targets, executor, options = {}) {
  const orderedTargets = Array.isArray(targets) ? targets : [];
  const timeoutSeconds = getAggregateTimeoutSeconds({
    timeoutSeconds: options.timeoutSeconds,
  });
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : timeoutSeconds * 1000;
  const deadlineAt =
    Number.isFinite(options.deadlineAt) && options.deadlineAt > 0
      ? options.deadlineAt
      : Date.now() + timeoutMs;
  const successMap = new Map();
  const failureMap = new Map();
  const pendingEntries = new Map();

  orderedTargets.forEach((target) => {
    let wrappedPromise = null;
    wrappedPromise = Promise.resolve()
      .then(() => executor(target))
      .then(
        (value) => ({
          wrappedPromise,
          target,
          status: "fulfilled",
          value,
        }),
        (error) => ({
          wrappedPromise,
          target,
          status: "rejected",
          error: normalizeAggregateExecutionError(error),
        }),
      );
    pendingEntries.set(wrappedPromise, target);
  });

  while (pendingEntries.size > 0) {
    const pendingPromises = Array.from(pendingEntries.keys());
    if (pendingPromises.length === 0) {
      break;
    }

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    const outcome = await Promise.race([
      ...pendingPromises,
      new Promise((resolve) => {
        setTimeout(() => resolve(null), remainingMs);
      }),
    ]);

    if (!outcome) {
      break;
    }

    pendingEntries.delete(outcome.wrappedPromise);

    if (outcome.status === "fulfilled") {
      successMap.set(buildAggregateExecutionKey(outcome.target), {
        ...outcome.target,
        ...outcome.value,
      });
      continue;
    }

    failureMap.set(buildAggregateExecutionKey(outcome.target), {
      ...outcome.target,
      error: outcome.error,
    });
  }

  if (pendingEntries.size > 0) {
    pendingEntries.forEach((target) => {
      failureMap.set(buildAggregateExecutionKey(target), {
        ...target,
        error: createAggregateRequestTimeoutError(timeoutSeconds),
      });
    });
  }

  return {
    targets: orderedTargets
      .map((target) => successMap.get(buildAggregateExecutionKey(target)))
      .filter(Boolean),
    failures: orderedTargets
      .map((target) => failureMap.get(buildAggregateExecutionKey(target)))
      .filter(Boolean),
    timedOut: pendingEntries.size > 0,
    deadlineAt,
  };
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

function buildAggregateMergedHeaders(type, successfulFetches = [], title = "") {
  const mergedIntervalHours = toProfileUpdateIntervalHours(
    getAggregateRuntimeIntervalMinutes(successfulFetches.map((entry) => entry.target)),
  );
  const headers = {
    "content-type": getContentTypeByRelayType(
      type,
      successfulFetches[0]?.payload?.headers?.["content-type"] || "text/plain; charset=utf-8",
    ),
    "profile-title": title || `RelayHub Aggregate ${type}`,
    "profile-update-interval": mergedIntervalHours,
  };
  const mergedUserInfo = pickAggregateSubscriptionUserInfoHeader(successfulFetches);

  if (mergedUserInfo) {
    headers["subscription-userinfo"] = mergedUserInfo;
  }

  return headers;
}

async function buildAggregateMergedBody(type, successfulFetches = [], options = {}) {
  const clashTemplate =
    type === "clash" && options.stripRules !== true ? await loadAggregateClashTemplate() : null;
  const minimalGroups = type === "clash" && options.stripRules === true;
  const mergedBody = sanitizeSubscriptionBody(
    mergeSubscriptionBodies(
      type,
      successfulFetches.map((entry) => ({
        body: entry.payload.body,
        sourceLabel: entry.target.instanceLabel || entry.target.upstreamId,
      })),
      {
        clashTemplate,
        minimalGroups,
      },
    ),
  );

  validateSubscriptionPayload(type, mergedBody);
  return mergedBody;
}

function upgradeLegacyCachedAggregateBody(type, bodyBuffer) {
  if (type !== "clash" || !Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) {
    return bodyBuffer;
  }

  try {
    const parsed = yaml.load(bodyBuffer.toString("utf8"));
    const hasLegacyBareProxyShape =
      parsed
      && typeof parsed === "object"
      && Array.isArray(parsed.proxies)
      && parsed.proxies.length > 0
      && !Array.isArray(parsed["proxy-groups"])
      && !Array.isArray(parsed.rules);

    if (!hasLegacyBareProxyShape) {
      return bodyBuffer;
    }

    return sanitizeSubscriptionBody(
      mergeSubscriptionBodies(
        type,
        [bodyBuffer],
        {
          minimalGroups: true,
        },
      ),
    );
  } catch {
    return bodyBuffer;
  }
}

function sendSubscriptionPayload(response, requestMethod, headers, bodyBuffer) {
  response.writeHead(200, headers);
  if (requestMethod === "HEAD") {
    response.end();
    return;
  }

  response.end(bodyBuffer);
}

function buildEmptyAggregateSubscriptionBody(type) {
  if (type === "clash") {
    return Buffer.from("proxies: []\n", "utf8");
  }

  if (type === "sing-box") {
    return Buffer.from(
      `${JSON.stringify(
        {
          outbounds: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return Buffer.from("\n", "utf8");
}

function buildEmptyAggregateSubscriptionHeaders(type, runtime = {}) {
  const preRegistration = getAggregatePreRegistrationSettings(runtime?.upstreamAggregation);

  return {
    "content-type": getContentTypeByRelayType(type, "text/plain; charset=utf-8"),
    "profile-title": `RelayHub Aggregate ${type} Empty`,
    "profile-update-interval": toProfileUpdateIntervalHours(preRegistration.intervalMinutes),
  };
}

function shouldReturnEmptyAggregateSubscription(runtime = {}) {
  const preRegistration = getAggregatePreRegistrationSettings(runtime?.upstreamAggregation);
  return Boolean(
    runtime?.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.AGGREGATE
    && preRegistration.enabled,
  );
}

function sendEmptyAggregateSubscription(response, request, type, runtime = {}) {
  sendSubscriptionPayload(
    response,
    request.method,
    buildEmptyAggregateSubscriptionHeaders(type, runtime),
    buildEmptyAggregateSubscriptionBody(type),
  );
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

    (Array.isArray(parsed.rules) ? parsed.rules : []).forEach((rule) => {
      if (typeof rule !== "string") {
        return;
      }

      const segments = splitClashRuleSegments(rule);
      const targetIndex = getClashRuleTargetIndex(rule);
      if (targetIndex < 0 || targetIndex >= segments.length) {
        return;
      }

      const target = segments[targetIndex];
      if (
        target
        && !proxyNames.has(target)
        && !groupNames.has(target)
        && !builtinTargets.has(target)
        && !target.startsWith("[]")
      ) {
        throw new Error(`Clash rule references an unknown target: ${target}`);
      }
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
      nodeCount: 0,
      requestProfileKey: "",
      transportKey: "",
      error: "No subscription URL is available for testing.",
    };
  }

  const payload = await fetchPreferredSubscriptionPayload(
    probeType,
    record.clientUrls[probeType],
    RELAY_FETCH_TIMEOUT_MS,
    "GET",
  );

  return {
    verified: true,
    type: probeType,
    url: record.clientUrls[probeType] || "",
    nodeCount: payload.nodeCount || 0,
    requestProfileKey: payload.requestProfileKey || "",
    transportKey: payload.transportKey || "",
    error: "",
  };
}

function isUpstreamRegistrationRateLimited(error) {
  const message = (error?.message || "").toString().trim();
  if (!message) {
    return false;
  }

  return /注册频繁|请等待\s*\d+\s*分钟|too many|rate limit|retry later/i.test(message);
}

function buildUpstreamFallbackCandidateId(candidate = {}) {
  const record = candidate?.record || {};
  return [
    candidate?.source || "",
    candidate?.storageKey || "",
    record?.token || "",
    record?.email || "",
    record?.createdAt || "",
  ]
    .map((value) => (value || "").toString().trim())
    .filter(Boolean)
    .join(":");
}

function getVerifiedSubscriptionNodeCount(verification = null) {
  return Number.parseInt(verification?.subscriptionTest?.nodeCount, 10) || 0;
}

function compareReusableVerificationResults(left = {}, right = {}) {
  const leftSubscriptionVerified = Boolean(left?.subscriptionTest?.verified);
  const rightSubscriptionVerified = Boolean(right?.subscriptionTest?.verified);
  if (leftSubscriptionVerified !== rightSubscriptionVerified) {
    return rightSubscriptionVerified ? 1 : -1;
  }

  const leftNodeCount = getVerifiedSubscriptionNodeCount(left);
  const rightNodeCount = getVerifiedSubscriptionNodeCount(right);
  if (leftNodeCount !== rightNodeCount) {
    return rightNodeCount - leftNodeCount;
  }

  const leftUsageVerified = Boolean(left?.usage);
  const rightUsageVerified = Boolean(right?.usage);
  if (leftUsageVerified !== rightUsageVerified) {
    return rightUsageVerified ? 1 : -1;
  }

  return toTimestamp(right?.sortAt || "") - toTimestamp(left?.sortAt || "");
}

async function collectUpstreamFallbackCandidates(upstreamId) {
  const candidates = [];
  const userStates = await listUserStates(upstreamId);

  userStates.forEach((userState) => {
    if (!userState?.latestRegistration) {
      return;
    }

    candidates.push({
      source: "relay_state",
      userKey: userState.userKey || "",
      storageKey: upstreamId,
      record: userState.latestRegistration,
      usage: userState.latestUsage || null,
      sortAt: pickLatestIso([
        userState.latestUsage?.queriedAt,
        userState.latestRegistration?.createdAt,
        userState.updatedAt,
      ]),
    });
  });

  const aggregateCacheStates = await Promise.all(
    RELAY_USERS.map(async (relayUser) => ({
      userKey: relayUser.key,
      state: await getAggregateCacheUserState(relayUser.key),
    })),
  );

  aggregateCacheStates.forEach(({ userKey, state }) => {
    (Array.isArray(state?.sourcePool) ? state.sourcePool : [])
      .filter((entry) => (entry?.upstreamId || entry?.storageKey || "") === upstreamId)
      .forEach((entry) => {
        candidates.push({
          source: "aggregate_cache",
          userKey,
          storageKey: entry.storageKey || upstreamId,
          record: entry.registration,
          usage: entry.latestUsage || null,
          sortAt: pickLatestIso([
            entry.lastValidatedAt,
            entry.savedAt,
            entry.registration?.createdAt,
            entry.latestUsage?.queriedAt,
          ]),
        });
      });
  });

  const uniqueCandidates = new Map();
  candidates
    .filter((candidate) => candidate?.record)
    .sort((left, right) => toTimestamp(right.sortAt) - toTimestamp(left.sortAt))
    .forEach((candidate) => {
      const id = buildUpstreamFallbackCandidateId(candidate);
      if (id && !uniqueCandidates.has(id)) {
        uniqueCandidates.set(id, candidate);
      }
    });

  return Array.from(uniqueCandidates.values());
}

async function verifyUpstreamRecordForTest(module, upstreamId, upstreamConfig, candidate = {}) {
  const record = mergeRegistrationWithUsage(candidate.record, candidate.usage);
  let usage = null;
  let queryError = "";

  if (module.manifest?.capabilities?.supportsStatusQuery !== false) {
    try {
      usage = await module.query({
        record,
        upstreamConfig,
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

  return {
    upstreamId,
    source: candidate.source || "",
    userKey: candidate.userKey || "",
    storageKey: candidate.storageKey || upstreamId,
    sortAt: candidate.sortAt || "",
    record,
    usage,
    queryError,
    subscriptionTest,
    subscriptionError,
    verified: Boolean(usage || subscriptionTest?.verified),
  };
}

async function findReusableUpstreamTestResult(module, upstreamId, upstreamConfig) {
  const candidates = await collectUpstreamFallbackCandidates(upstreamId);
  if (candidates.length === 0) {
    return null;
  }

  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return await verifyUpstreamRecordForTest(module, upstreamId, upstreamConfig, candidate);
      } catch {
        return null;
      }
    }),
  );

  const verifiedResults = results.filter((result) => result?.verified);
  if (verifiedResults.length === 0) {
    return null;
  }

  verifiedResults.sort(compareReusableVerificationResults);
  return verifiedResults[0];
}

async function persistVerifiedUpstreamTestResult(userKey, upstreamId, verification, runtime = null) {
  const normalizedUserKey = normalizeUserKey(userKey);
  const normalizedRuntime = runtime || await getActiveUpstreamRuntime();
  const persistedAt = new Date().toISOString();
  const persistedRegistration = verification.record
    ? {
      ...verification.record,
      accountCreatedAt:
        verification.record.accountCreatedAt || verification.usage?.accountCreatedAt || "",
      expiredAt: verification.record.expiredAt || verification.usage?.expiredAt || "",
      lastUsageCheckAt: verification.usage?.queriedAt || verification.record.lastUsageCheckAt || "",
    }
    : null;
  const relayPersisted = Boolean(persistedRegistration);

  if (relayPersisted) {
    await updateUserState(normalizedUserKey, upstreamId, async (userState) => {
      userState.latestRegistration = persistedRegistration;
      userState.latestUsage = verification.usage || userState.latestUsage || null;
    });

    await appendUserHistory(normalizedUserKey, upstreamId, {
      action: "manual_test",
      title: verification.source === "fresh_registration" ? "上游测试成功并已缓存" : "复用缓存账号完成上游测试",
      message:
        verification.source === "fresh_registration"
          ? "测试注册成功，已写入当前用户状态，并可复用于后续调度。"
          : "本次测试命中限流兜底，已复用可用账号并刷新当前用户状态。",
      mode: "",
      decision: verification.source === "fresh_registration" ? "register" : "reuse",
      relayType: verification.subscriptionTest?.type || "",
      requestSource: "manual",
      registration: persistedRegistration,
      usage: verification.usage || null,
      details: {
        source: verification.source || "",
        queryVerified: Boolean(verification.usage),
        subscriptionVerified: Boolean(verification.subscriptionTest?.verified),
        subscriptionNodeCount: Number.parseInt(verification.subscriptionTest?.nodeCount, 10) || 0,
        subscriptionFetchProfile: verification.subscriptionTest?.requestProfileKey || "",
        subscriptionFetchTransport: verification.subscriptionTest?.transportKey || "",
      },
    });
  }

  const configuredTargets =
    normalizedRuntime.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.AGGREGATE
      ? await getRuntimeAggregateTargets("")
      : [];
  const matchingTarget =
    configuredTargets.find((target) => target.upstreamId === upstreamId)
    || {
      upstreamId,
      storageKey: upstreamId,
      instanceNumber: 1,
      instanceLabel: upstreamId,
    };
  const sourcePoolEntry = persistedRegistration
    && verification.subscriptionTest?.verified
    && !isDegradedSnailServerNodeCount(upstreamId, verification.subscriptionTest?.nodeCount)
    ? createAggregateSourcePoolEntry(
        {
          ...matchingTarget,
          id: buildAggregateSourcePoolUniqueKey({
            ...matchingTarget,
            registration: persistedRegistration,
          }),
          lastValidatedAt: persistedAt,
          lastValidationError: "",
          registration: persistedRegistration,
          latestUsage: verification.usage || null,
        },
        persistedAt,
      )
    : null;

  let aggregateUserCount = 0;
  const aggregateStorageKeys = [];
  if (sourcePoolEntry) {
    const preRegistration = getAggregatePreRegistrationSettings(normalizedRuntime.upstreamAggregation);
    const relayUsers = await listRelayUsers();
    const aggregateResults = await Promise.all(
      relayUsers.map(async (relayUser) => {
        const currentUserState = await getAggregateCacheUserState(relayUser.key);
        const mergedSourcePool = mergeAggregateSourcePoolEntries(
          [
            ...(Array.isArray(currentUserState?.sourcePool) ? currentUserState.sourcePool : []),
            sourcePoolEntry,
          ],
          preRegistration.maxSources,
        );
        await replaceAggregateCacheUserState(relayUser.key, {
          cacheEntries: currentUserState?.cacheEntries || {},
          sourcePool: mergedSourcePool,
        });
        return mergedSourcePool.length > 0;
      }),
    );
    aggregateUserCount = aggregateResults.filter(Boolean).length;
    aggregateStorageKeys.push(sourcePoolEntry.storageKey || upstreamId);
  }

  const aggregateRefreshScheduled =
    normalizedRuntime.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.AGGREGATE
    && sourcePoolEntry !== null;
  if (aggregateRefreshScheduled) {
    aggregatePreRegistrationImmediateRequested = true;
    scheduleAggregatePreRegistration().catch(() => undefined);
  }

  return {
    userKey: normalizedUserKey,
    relayPersisted,
    aggregateUserCount,
    aggregateStorageKeys,
    aggregateRefreshScheduled,
    persistedAt,
  };
}

async function fetchResolvedSubscriptionSource(source, type, requestMethod = "GET", options = {}) {
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
  const hasDeadline = Number.isFinite(options.deadlineAt) && options.deadlineAt > 0;
  const deadlineTimeoutMs = hasDeadline ? options.deadlineAt - Date.now() : 0;
  if (hasDeadline && deadlineTimeoutMs <= 0) {
    throw createAggregateRequestTimeoutError(
      getAggregateTimeoutSeconds({
        timeoutSeconds: options.timeoutSeconds,
      }),
    );
  }

  const requestTimeoutMs = hasDeadline
    ? normalizeRequestTimeoutMs(deadlineTimeoutMs, RELAY_FETCH_TIMEOUT_MS)
    : normalizeRequestTimeoutMs(options.timeoutMs, RELAY_FETCH_TIMEOUT_MS);

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

  const preferredPayload = await fetchPreferredSubscriptionPayload(
    type,
    upstreamUrl,
    requestTimeoutMs,
    requestMethod,
  );
  const headers = {
    ...(preferredPayload.headers || {}),
  };

  if (!headers["subscription-userinfo"]) {
    const fallbackUserInfoHeader = await fetchFallbackSubscriptionUserInfoHeader(
      latest?.clientUrls,
      type,
      requestTimeoutMs,
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

  const body = requestMethod === "HEAD" ? Buffer.alloc(0) : preferredPayload.body;

  return {
    headers,
    body,
    meta: {
      upstreamUrl,
      nodeCount: preferredPayload.nodeCount || 0,
      requestProfileKey: preferredPayload.requestProfileKey || "",
      transportKey: preferredPayload.transportKey || "",
    },
  };
}

async function proxyAggregateSubscription(response, request, type, relayUser, runtime) {
  const aggregateTimeoutMs = getAggregateTimeoutMs(runtime?.upstreamAggregation);
  const aggregateTimeoutSeconds = getAggregateTimeoutSeconds(runtime?.upstreamAggregation);
  const allowEmptyFallback = shouldReturnEmptyAggregateSubscription(runtime);
  const deadlineAt = Date.now() + aggregateTimeoutMs;
  const aggregateTargets = await getRuntimeAggregateTargets(type);
  const aggregateResult = await collectAggregateExecutionResults(
    aggregateTargets,
    async (target) => {
      let resolvedState = null;

      try {
        resolvedState = await resolveRelayState(relayUser.key, target.upstreamId, type, target);
        const payload = await fetchResolvedSubscriptionSource(
          {
            ...target,
            ...resolvedState,
          },
          type,
          request.method,
          {
            deadlineAt,
            timeoutSeconds: aggregateTimeoutSeconds,
          },
        );

        return {
          ...resolvedState,
          payload,
        };
      } catch (error) {
        const normalizedError = normalizeAggregateExecutionError(error);
        if (resolvedState) {
          normalizedError.aggregateTargetState = resolvedState;
        }
        throw normalizedError;
      }
    },
    {
      timeoutSeconds: aggregateTimeoutSeconds,
      deadlineAt,
    },
  );

  if (aggregateResult.targets.length === 0) {
    if (allowEmptyFallback) {
      sendEmptyAggregateSubscription(response, request, type, runtime);
      return;
    }

    sendText(response, 503, "No aggregate upstream is available.");
    return;
  }

  const failedFetches = [...aggregateResult.failures];
  const successfulFetches = [];

  aggregateResult.targets.forEach((entry) => {
    if (isDegradedServerSidePayload(entry, entry.payload, request.method)) {
      failedFetches.push({
        ...entry,
        error: createDegradedServerSidePayloadError(entry, entry.payload),
      });
      return;
    }

    successfulFetches.push({
      target: entry,
      payload: entry.payload,
    });
  });

  await Promise.all(
    successfulFetches.map(({ target, payload }) =>
      appendUserHistory(relayUser.key, target.storageKey || target.upstreamId, {
        action: "relay_success",
        title: "Aggregate relay returned.",
        message: `Client fetched ${type} aggregate subscription successfully.`,
        mode: ACTIVE_UPSTREAM_MODES.AGGREGATE,
        relayType: type,
        requestSource: "relay",
        registration: target?.userState?.latestRegistration || null,
        usage: target?.userState?.latestUsage || null,
        details: {
          aggregate: true,
          instanceLabel: target.instanceLabel || target.upstreamId,
          storageKey: target.storageKey || target.upstreamId,
          nodeCount: Number.parseInt(payload?.meta?.nodeCount, 10) || 0,
        },
      }).catch(() => undefined)
    ),
  );

  failedFetches.forEach((failure) => {
    appendUserHistory(relayUser.key, failure.storageKey || failure.upstreamId, {
      action: "relay_failed",
      title: "聚合订阅拉取失败",
      message: failure.error?.message || "Unknown error.",
      mode: ACTIVE_UPSTREAM_MODES.AGGREGATE,
      relayType: type,
      requestSource: "relay",
      registration:
        failure.error?.aggregateTargetState?.userState?.latestRegistration ||
        failure?.userState?.latestRegistration ||
        null,
      usage:
        failure.error?.aggregateTargetState?.userState?.latestUsage ||
        failure?.userState?.latestUsage ||
        null,
      details: {
        aggregate: true,
        instanceLabel: failure.instanceLabel || failure.upstreamId,
        storageKey: failure.storageKey || failure.upstreamId,
      },
    }).catch(() => undefined);
  });

  if (successfulFetches.length === 0) {
    if (allowEmptyFallback) {
      sendEmptyAggregateSubscription(response, request, type, runtime);
      return;
    }

    sendText(
      response,
      aggregateResult.timedOut ? 504 : 502,
      `Aggregate subscription request failed: ${buildAggregateWarning(failedFetches) || `Aggregate timeout after ${aggregateTimeoutSeconds}s.`}`,
    );
    return;
  }

  const mergedHeaders = buildAggregateMergedHeaders(
    type,
    successfulFetches,
    `RelayHub Aggregate ${type}`,
  );
  const mergedBody = await buildAggregateMergedBody(type, successfulFetches);
  sendSubscriptionPayload(response, request.method, mergedHeaders, mergedBody);
}

async function proxyScopedUpstreamSubscription(response, request, type, relayUser, upstreamId) {
  const normalizedUpstreamId = (upstreamId || "").toString().trim();
  if (!normalizedUpstreamId) {
    sendText(response, 400, "Upstream is required.");
    return;
  }

  const upstreamConfig = await getUpstreamConfig(normalizedUpstreamId);
  if (!upstreamConfig) {
    sendText(response, 404, "Upstream not found.");
    return;
  }

  const userState = await getUserState(relayUser.key, normalizedUpstreamId);
  if (!userState?.latestRegistration) {
    sendText(response, 404, "No cached upstream registration is available.");
    return;
  }

  const scopedSource = {
    upstreamId: normalizedUpstreamId,
    storageKey: normalizedUpstreamId,
    upstreamConfig,
    userState,
  };
  const redirectLocation = getRelayUpstreamRedirectLocation(scopedSource, type);
  if (redirectLocation) {
    await appendUserHistory(relayUser.key, normalizedUpstreamId, {
      action: "relay_success",
      title: "Scoped relay redirected to upstream.",
      message: `Client fetched ${type} subscription via upstream redirect.`,
      relayType: type,
      requestSource: "relay",
      registration: userState.latestRegistration,
      usage: userState.latestUsage || null,
      details: {
        scopedRelay: true,
        upstreamId: normalizedUpstreamId,
        redirected: true,
      },
    });
    response.writeHead(302, {
      Location: redirectLocation,
      "Cache-Control": "no-store, max-age=0, must-revalidate",
      Pragma: "no-cache",
    });
    response.end();
    return;
  }

  const payload = await fetchResolvedSubscriptionSource(
    scopedSource,
    type,
    request.method,
    {
      timeoutMs: RELAY_FETCH_TIMEOUT_MS,
    },
  );

  await appendUserHistory(relayUser.key, normalizedUpstreamId, {
    action: "relay_success",
    title: "测试转发订阅已返回",
    message: `客户端成功拉取 ${type} 测试转发订阅。`,
    relayType: type,
    requestSource: "relay",
    registration: userState.latestRegistration,
    usage: userState.latestUsage || null,
    details: {
      scopedRelay: true,
      upstreamId: normalizedUpstreamId,
    },
  });

  sendSubscriptionPayload(response, request.method, payload.headers, payload.body);
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

async function buildCachedViewResponse(request, userKey, type, runtime, upstreamId) {
  const relayToken = await getRelayToken(userKey);
  const relayUrls = buildRelayUrls(await getRequestOrigin(request), relayToken);
  const upstreams = await listUpstreamConfigs();
  const user = RELAY_USERS.find((item) => item.key === userKey) || RELAY_USERS[0];

  if (runtime.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.AGGREGATE && !upstreamId) {
    const relayState = await loadRelayState();
    const targets = buildLocalAggregateTargets(relayState, userKey, runtime, upstreams);

    return {
      message: targets.some((target) => target?.userState?.latestRegistration)
        ? "Cached aggregate user state returned."
        : "Current aggregate has no cached registration yet.",
      payload: await buildAggregateResponse(request, userKey, type, targets),
    };
  }

  const targetUpstreamId = upstreamId || runtime.activeUpstreamId;
  const upstream = getUpstreamSummary(upstreams, targetUpstreamId);
  const userState = await getUserState(userKey, targetUpstreamId);

  return {
    message: userState.latestRegistration
      ? "Cached user state returned."
      : "Current user has no cached registration yet.",
    payload: shapeRegistrationResponse(user, upstream, userState, type, relayUrls),
  };
}

function clearAggregatePreRegistrationTimer() {
  if (!aggregatePreRegistrationTimer) {
    return;
  }

  clearTimeout(aggregatePreRegistrationTimer);
  aggregatePreRegistrationTimer = null;
}

function buildAggregateCacheFailureMessage(userSummaries = []) {
  const messages = (Array.isArray(userSummaries) ? userSummaries : [])
    .map((item) => item?.error || "")
    .filter(Boolean);

  if (messages.length === 0) {
    return "Aggregate pre-registration did not produce a usable cache.";
  }

  return messages[0];
}

async function buildAggregateCacheEntriesForUser(
  userKey,
  configuredTargets = [],
  configuredTargetsByType = {},
  options = {},
) {
  const configuredTargetMap = new Map(
    (Array.isArray(configuredTargets) ? configuredTargets : []).map((target) => [
      target.storageKey || target.upstreamId,
      target,
    ]),
  );
  const currentUserState = await getAggregateCacheUserState(userKey);
  const existingSourcePool = (Array.isArray(currentUserState?.sourcePool) ? currentUserState.sourcePool : [])
    .filter((entry) => configuredTargetMap.has(entry.storageKey || entry.upstreamId));

  const existingValidationPromise = validateAggregateSourcePoolEntries(
    existingSourcePool,
    configuredTargetMap,
    options,
  );
  const registrationPromise = manualRegisterAggregateWithRuntime(userKey, {
    timeoutSeconds: options.timeoutSeconds,
  })
    .then((result) => ({
      result,
      error: null,
    }))
    .catch((error) => ({
      result: null,
      error: normalizeAggregateExecutionError(error),
    }));

  const [existingValidation, registrationOutcome] = await Promise.all([
    existingValidationPromise,
    registrationPromise,
  ]);

  const registrationFailures = registrationOutcome?.result?.failures
    ? [...registrationOutcome.result.failures]
    : registrationOutcome?.error
      ? [
          {
            upstreamId: "aggregate",
            storageKey: "aggregate",
            instanceLabel: "aggregate",
            error: registrationOutcome.error,
          },
        ]
      : [];

  const newSourceEntries = registrationOutcome?.result?.targets
    ? registrationOutcome.result.targets
      .map((target) => createAggregateSourcePoolEntry(target))
      .filter(Boolean)
    : [];
  const newValidation = await validateAggregateSourcePoolEntries(
    newSourceEntries,
    configuredTargetMap,
    options,
  );
  const retainedEntries = trimAggregateValidatedEntries(
    [...existingValidation.validatedEntries, ...newValidation.validatedEntries],
    options.maxSources,
  );
  const retainedSourcePool = retainedEntries.map((entry) => entry.sourcePoolEntry);
  const retainedTargets = retainedEntries.map((entry) => entry.target);
  const cacheBuild = await buildAggregateCacheEntriesFromSourceTargets(
    retainedTargets,
    configuredTargetsByType,
    options,
  );
  const combinedFailures = [
    ...registrationFailures,
    ...existingValidation.failures,
    ...newValidation.failures,
    ...cacheBuild.failures,
  ];
  const failureCount = combinedFailures.length;
  const error =
    cacheBuild.cacheCount > 0
      ? ""
      : buildAggregateWarning(combinedFailures)
        || registrationOutcome?.error?.message
        || "No aggregate source produced a cache.";

  return {
    userKey,
    cacheEntries: cacheBuild.cacheEntries,
    sourcePool: retainedSourcePool,
    cacheCount: cacheBuild.cacheCount,
    sourceCount: retainedSourcePool.length,
    failureCount,
    error,
  };
}

function getAggregateSourcePoolEntryTimestamp(entry = {}) {
  return toTimestamp(
    pickLatestIso([
      entry.lastValidatedAt,
      entry.savedAt,
      entry.registration?.createdAt,
    ]),
  );
}

function getAggregateValidatedEntryTimestamp(entry = {}) {
  return getAggregateSourcePoolEntryTimestamp(entry.sourcePoolEntry || {});
}

function sortAggregateSourcePoolEntries(entries = []) {
  return [...(Array.isArray(entries) ? entries : [])]
    .filter(Boolean)
    .sort((left, right) =>
      getAggregateSourcePoolEntryTimestamp(right) - getAggregateSourcePoolEntryTimestamp(left));
}

function buildAggregateSourcePoolEntryId(target = {}, savedAt = "") {
  const registration = target?.userState?.latestRegistration || target?.registration || null;
  const storageKey = (target.storageKey || target.upstreamId || "").toString().trim();
  return [
    storageKey,
    (savedAt || registration?.createdAt || "").toString().trim(),
    (registration?.email || "").toString().trim(),
  ]
    .filter(Boolean)
    .join(":");
}

function createAggregateSourcePoolEntry(target = {}, savedAt = "") {
  const registration = target?.userState?.latestRegistration || target?.registration || null;
  if (!registration) {
    return null;
  }

  const upstreamId = (target.upstreamId || target.storageKey || "").toString().trim();
  const storageKey = (target.storageKey || upstreamId).toString().trim() || upstreamId;
  const normalizedSavedAt =
    (savedAt || target.savedAt || registration.createdAt || new Date().toISOString())
      .toString()
      .trim();
  const id =
    (target.id || buildAggregateSourcePoolEntryId(target, normalizedSavedAt)).toString().trim()
    || buildAggregateSourcePoolEntryId(
      {
        upstreamId,
        storageKey,
        registration,
      },
      normalizedSavedAt,
    );

  return {
    id,
    upstreamId,
    storageKey,
    instanceNumber: Math.max(1, Number.parseInt(target.instanceNumber, 10) || 1),
    instanceLabel: (target.instanceLabel || storageKey || upstreamId).toString().trim()
      || storageKey
      || upstreamId,
    savedAt: normalizedSavedAt,
    lastValidatedAt: (target.lastValidatedAt || "").toString().trim(),
    lastValidationError: (target.lastValidationError || "").toString(),
    registration,
    latestUsage: target?.userState?.latestUsage || target?.latestUsage || null,
  };
}

function buildAggregateSourcePoolUniqueKey(entry = {}) {
  const registration = entry?.registration || entry?.userState?.latestRegistration || null;
  const storageKey = (entry.storageKey || entry.upstreamId || "").toString().trim();
  return [
    storageKey,
    (registration?.email || "").toString().trim(),
    (registration?.createdAt || "").toString().trim(),
  ]
    .filter(Boolean)
    .join(":");
}

function mergeAggregateSourcePoolEntries(
  entries = [],
  limit = DEFAULT_AGGREGATE_PREREGISTRATION_MAX_SOURCES,
) {
  const normalizedLimit = Math.max(
    1,
    Math.min(
      50,
      Number.parseInt(limit, 10) || DEFAULT_AGGREGATE_PREREGISTRATION_MAX_SOURCES,
    ),
  );
  const uniqueEntries = new Map();

  sortAggregateSourcePoolEntries(entries).forEach((entry) => {
    const uniqueKey = buildAggregateSourcePoolUniqueKey(entry);
    if (!uniqueKey || uniqueEntries.has(uniqueKey)) {
      return;
    }
    uniqueEntries.set(uniqueKey, entry);
  });

  return Array.from(uniqueEntries.values()).slice(0, normalizedLimit);
}

function trimAggregateValidatedEntries(entries = [], limit = DEFAULT_AGGREGATE_PREREGISTRATION_MAX_SOURCES) {
  const normalizedLimit = Math.max(
    1,
    Math.min(
      50,
      Number.parseInt(limit, 10) || DEFAULT_AGGREGATE_PREREGISTRATION_MAX_SOURCES,
    ),
  );
  const uniqueEntries = new Map();

  [...(Array.isArray(entries) ? entries : [])]
    .filter((entry) => entry?.sourcePoolEntry && entry?.target)
    .sort((left, right) => getAggregateValidatedEntryTimestamp(right) - getAggregateValidatedEntryTimestamp(left))
    .forEach((entry) => {
      const sourcePoolEntry = entry.sourcePoolEntry;
      const id =
        sourcePoolEntry?.id
        || buildAggregateSourcePoolEntryId(sourcePoolEntry, sourcePoolEntry?.savedAt || "");
      if (id && !uniqueEntries.has(id)) {
        uniqueEntries.set(id, entry);
      }
    });

  return Array.from(uniqueEntries.values()).slice(0, normalizedLimit);
}

function pickAggregatePoolValidationType(clientUrls = {}) {
  const preferredTypes = ["clash", "universal", "sing-box", ...RELAY_TYPES]
    .filter((type, index, list) => list.indexOf(type) === index);
  return preferredTypes.find((type) => Boolean(clientUrls?.[type])) || "";
}

function isAggregateRegistrationExpired(registration = null) {
  const expiredAt = (registration?.expiredAt || "").toString().trim();
  return Boolean(expiredAt) && toTimestamp(expiredAt) > 0 && toTimestamp(expiredAt) <= Date.now();
}

function isAggregateUsageExpiredOrExhausted(usage = null) {
  if (!usage || typeof usage !== "object") {
    return false;
  }

  const expiredAt = (usage.expiredAt || "").toString().trim();
  if (expiredAt && toTimestamp(expiredAt) > 0 && toTimestamp(expiredAt) <= Date.now()) {
    return true;
  }

  const transferEnable = typeof usage.transferEnable === "number" ? usage.transferEnable : null;
  const remainingTraffic = typeof usage.remainingTraffic === "number" ? usage.remainingTraffic : null;
  const remainingPercent = typeof usage.remainingPercent === "number" ? usage.remainingPercent : null;
  const usedTotal = typeof usage.usedTotal === "number" ? usage.usedTotal : null;
  const hasTrafficQuota = transferEnable !== null && transferEnable > 0;

  if (hasTrafficQuota && remainingTraffic !== null && remainingTraffic <= 0) {
    return true;
  }
  if (hasTrafficQuota && remainingPercent !== null && remainingPercent <= 0) {
    return true;
  }
  if (hasTrafficQuota && usedTotal !== null && usedTotal >= transferEnable) {
    return true;
  }

  return false;
}

function buildAggregateTargetFromPoolEntry(
  entry = {},
  configuredTarget = {},
  upstreamConfig = null,
  latestUsage = null,
) {
  const mergedRegistration = mergeRegistrationWithUsage(
    entry.registration,
    latestUsage || entry.latestUsage || null,
  );
  if (!mergedRegistration) {
    return null;
  }

  return {
    upstreamId: configuredTarget.upstreamId || entry.upstreamId,
    storageKey: configuredTarget.storageKey || entry.storageKey || entry.upstreamId,
    instanceNumber: configuredTarget.instanceNumber || entry.instanceNumber || 1,
    instanceLabel:
      configuredTarget.instanceLabel || entry.instanceLabel || entry.storageKey || entry.upstreamId,
    upstreamConfig,
    userState: {
      latestRegistration: mergedRegistration,
      latestUsage: latestUsage || entry.latestUsage || null,
    },
  };
}

async function validateAggregateSourcePoolEntries(entries = [], configuredTargetMap = new Map(), options = {}) {
  const sourceEntries = Array.isArray(entries) ? entries : [];
  if (sourceEntries.length === 0) {
    return {
      validatedEntries: [],
      failures: [],
      timedOut: false,
    };
  }

  const timeoutSeconds = options.timeoutSeconds;
  const timeoutMs = options.timeoutMs;
  const deadlineAt = Date.now() + (
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : getAggregateTimeoutSeconds({
        timeoutSeconds,
      }) * 1000
  );
  const validationResult = await collectAggregateExecutionResults(
    sourceEntries,
    async (entry) => {
      const configuredTarget = configuredTargetMap.get(entry.storageKey || entry.upstreamId);
      if (!configuredTarget) {
        throw new Error("Aggregate source is no longer configured.");
      }

      const upstreamConfig = await getUpstreamConfig(configuredTarget.upstreamId);
      if (!upstreamConfig || upstreamConfig.enabled === false) {
        throw new Error("Current upstream is disabled.");
      }

      let queriedUsage = null;
      try {
        queriedUsage = await queryCurrentUsage(configuredTarget.upstreamId, entry.registration);
      } catch {
        queriedUsage = null;
      }

      const resolvedTarget = buildAggregateTargetFromPoolEntry(
        entry,
        configuredTarget,
        upstreamConfig,
        queriedUsage,
      );
      const latestRegistration = resolvedTarget?.userState?.latestRegistration;
      if (!latestRegistration) {
        throw new Error("No latest registration is available.");
      }

      if (isAggregateRegistrationExpired(latestRegistration)) {
        throw new Error("Upstream subscription expired.");
      }
      if (queriedUsage && isAggregateUsageExpiredOrExhausted(queriedUsage)) {
        throw new Error("Upstream subscription exhausted.");
      }

      const probeType = pickAggregatePoolValidationType(latestRegistration.clientUrls);
      if (!probeType) {
        throw new Error("No subscription URL is available for testing.");
      }

      const payload = await fetchResolvedSubscriptionSource(resolvedTarget, probeType, "GET", {
        timeoutSeconds,
        timeoutMs,
        deadlineAt,
      });
      if (isDegradedServerSidePayload(resolvedTarget, payload, "GET")) {
        throw createDegradedServerSidePayloadError(resolvedTarget, payload);
      }

      return {
        validatedEntry: {
          sourcePoolEntry: {
            ...createAggregateSourcePoolEntry(
              {
                ...resolvedTarget,
                id: entry.id,
              },
              entry.savedAt || latestRegistration.createdAt || new Date().toISOString(),
            ),
            lastValidatedAt: new Date().toISOString(),
            lastValidationError: "",
            latestUsage: queriedUsage || resolvedTarget.userState.latestUsage || null,
          },
          target: resolvedTarget,
        },
      };
    },
    {
      timeoutSeconds,
      timeoutMs,
      deadlineAt,
    },
  );

  return {
    validatedEntries: validationResult.targets
      .map((entry) => entry.validatedEntry)
      .filter(Boolean),
    failures: validationResult.failures,
    timedOut: validationResult.timedOut,
  };
}

async function buildAggregateCacheEntriesFromSourceTargets(
  sourceTargets = [],
  configuredTargetsByType = {},
  options = {},
) {
  const generatedAt = new Date().toISOString();
  const timeoutSeconds = options.timeoutSeconds;
  const timeoutMs = options.timeoutMs;
  const deadlineAt = Date.now() + (
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : getAggregateTimeoutSeconds({
        timeoutSeconds,
      }) * 1000
  );
  const typeSummaries = await Promise.all(
    RELAY_TYPES.map(async (type) => {
      const configuredTargets = Array.isArray(configuredTargetsByType[type])
        ? configuredTargetsByType[type]
        : [];
      const signature = buildAggregateTargetSignature(configuredTargets);
      if (!signature) {
        return null;
      }

      const configuredStorageKeys = new Set(
        configuredTargets.map((target) => target.storageKey || target.upstreamId),
      );
      const fetchTargets = (Array.isArray(sourceTargets) ? sourceTargets : [])
        .filter((target) =>
          configuredStorageKeys.has(target.storageKey || target.upstreamId)
          && Boolean(target?.userState?.latestRegistration?.clientUrls?.[type]));
      if (fetchTargets.length === 0) {
        return {
          type,
          signature,
          cacheEntry: null,
          failures: [],
        };
      }

      const fetchResult = await collectAggregateExecutionResults(
        fetchTargets,
        async (target) => ({
          payload: await fetchResolvedSubscriptionSource(target, type, "GET", {
            timeoutSeconds,
            timeoutMs,
            deadlineAt,
          }),
        }),
        {
          timeoutSeconds,
          timeoutMs,
          deadlineAt,
        },
      );
      const degradedFailures = [];
      const successfulFetches = [];
      fetchResult.targets.forEach((entry) => {
        if (isDegradedServerSidePayload(entry, entry.payload, "GET")) {
          degradedFailures.push({
            ...entry,
            error: createDegradedServerSidePayloadError(entry, entry.payload),
          });
          return;
        }

        successfulFetches.push({
          target: entry,
          payload: entry.payload,
        });
      });
      if (successfulFetches.length === 0) {
        return {
          type,
          signature,
          cacheEntry: null,
          failures: [...fetchResult.failures, ...degradedFailures],
        };
      }

      const mergedHeaders = buildAggregateMergedHeaders(
        type,
        successfulFetches,
        `RelayHub Cached Aggregate ${type}`,
      );
      const mergedBody = await buildAggregateMergedBody(type, successfulFetches, {
        stripRules: true,
      });

      return {
        type,
        signature,
        cacheEntry: {
          type,
          signature,
          headers: mergedHeaders,
          bodyBase64: mergedBody.toString("base64"),
          generatedAt,
          sourceCount: successfulFetches.length,
          failureCount: fetchResult.failures.length + degradedFailures.length,
          warning: buildAggregateWarning([...fetchResult.failures, ...degradedFailures]),
          sourceLabels: successfulFetches.map(
            (entry) => entry.target.instanceLabel || entry.target.upstreamId,
          ),
        },
        failures: [...fetchResult.failures, ...degradedFailures],
      };
    }),
  );
  const cacheEntries = {};
  const failures = [];

  typeSummaries.filter(Boolean).forEach((summary) => {
    if (summary.cacheEntry) {
      cacheEntries[summary.type] = summary.cacheEntry;
    }
    failures.push(...summary.failures);
  });

  return {
    cacheEntries,
    cacheCount: Object.keys(cacheEntries).length,
    sourceCount: Array.isArray(sourceTargets) ? sourceTargets.length : 0,
    failureCount: failures.length,
    failures,
  };
}

async function scheduleAggregatePreRegistration(options = {}) {
  clearAggregatePreRegistrationTimer();

  const runtime = await getActiveUpstreamRuntime();
  const preRegistration = getAggregatePreRegistrationSettings(runtime.upstreamAggregation);
  const configuredTargets =
    runtime.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.AGGREGATE
      ? await getRuntimeAggregateTargets("")
      : [];
  const enabled =
    runtime.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.AGGREGATE
    && preRegistration.enabled
    && configuredTargets.length > 0;

  if (!enabled) {
    aggregatePreRegistrationImmediateRequested = false;
    await updateAggregateCacheScheduler({
      enabled,
      intervalMinutes: preRegistration.intervalMinutes,
      nextRunAt: "",
      running: Boolean(aggregatePreRegistrationJob),
    });
    return;
  }

  const schedulerStatus = await getAggregateCacheScheduler();
  const immediate = Boolean(options.immediate || aggregatePreRegistrationImmediateRequested);
  const lastCompletedAtMs = Date.parse(schedulerStatus.lastCompletedAt || "");
  const now = Date.now();
  const nextRunAtMs =
    immediate || !Number.isFinite(lastCompletedAtMs)
      ? now
      : Math.max(now, lastCompletedAtMs + preRegistration.intervalMinutes * 60 * 1000);
  const nextRunAt = new Date(nextRunAtMs).toISOString();

  await updateAggregateCacheScheduler({
    enabled: true,
    intervalMinutes: preRegistration.intervalMinutes,
    nextRunAt,
    running: Boolean(aggregatePreRegistrationJob),
  });

  if (aggregatePreRegistrationJob) {
    return;
  }

  aggregatePreRegistrationTimer = setTimeout(() => {
    runAggregatePreRegistrationCycle("scheduled").catch((error) => {
      console.error("Aggregate pre-registration run failed:", error);
    });
  }, Math.max(0, nextRunAtMs - now));
}

async function runAggregatePreRegistrationCycle(trigger = "scheduled") {
  if (aggregatePreRegistrationJob) {
    return aggregatePreRegistrationJob;
  }

  clearAggregatePreRegistrationTimer();
  const startedAtMs = Date.now();

  aggregatePreRegistrationJob = (async () => {
    const runtime = await getActiveUpstreamRuntime();
    const preRegistration = getAggregatePreRegistrationSettings(runtime.upstreamAggregation);
    const configuredTargets =
      runtime.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.AGGREGATE
        ? await getRuntimeAggregateTargets("")
        : [];
    const enabled =
      runtime.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.AGGREGATE
      && preRegistration.enabled
      && configuredTargets.length > 0;

    if (!enabled) {
      aggregatePreRegistrationImmediateRequested = false;
      await updateAggregateCacheScheduler({
        enabled,
        intervalMinutes: preRegistration.intervalMinutes,
        running: false,
        nextRunAt: "",
      });
      return {
        skipped: true,
        trigger,
      };
    }

    aggregatePreRegistrationImmediateRequested = false;

    const configuredTargetsByType = Object.fromEntries(
      await Promise.all(
        RELAY_TYPES.map(async (type) => [type, await getRuntimeAggregateTargets(type)]),
      ),
    );

    await updateAggregateCacheScheduler({
      enabled: true,
      intervalMinutes: preRegistration.intervalMinutes,
      running: true,
      nextRunAt: "",
      lastStartedAt: new Date(startedAtMs).toISOString(),
      lastError: "",
    });

    const relayUsers = await listRelayUsers();
    const aggregateTimeoutSeconds = getAggregateTimeoutSeconds(runtime.upstreamAggregation);
    const aggregateTimeoutMs = getAggregateTimeoutMs(runtime.upstreamAggregation);
    const userSummaries = await Promise.all(
      relayUsers.map((relayUser) =>
        buildAggregateCacheEntriesForUser(
          relayUser.key,
          configuredTargets,
          configuredTargetsByType,
          {
            timeoutSeconds: aggregateTimeoutSeconds,
            timeoutMs: aggregateTimeoutMs,
            maxSources: preRegistration.maxSources,
          },
        )),
    );
    await Promise.all(
      userSummaries.map((summary) =>
        replaceAggregateCacheUserState(summary.userKey, {
          cacheEntries: summary.cacheEntries,
          sourcePool: summary.sourcePool,
        })),
    );

    const completedAt = new Date().toISOString();
    const cacheCount = userSummaries.reduce((total, item) => total + (item.cacheCount || 0), 0);
    const sourceCount = userSummaries.reduce((total, item) => total + (item.sourceCount || 0), 0);
    const failureCount = userSummaries.reduce((total, item) => total + (item.failureCount || 0), 0);
    const schedulerPatch = {
      enabled: true,
      intervalMinutes: preRegistration.intervalMinutes,
      running: false,
      lastCompletedAt: completedAt,
      lastDurationMs: Date.now() - startedAtMs,
      lastRun: {
        userCount: relayUsers.length,
        cacheCount,
        sourceCount,
        failureCount,
      },
      lastError: cacheCount > 0 ? "" : buildAggregateCacheFailureMessage(userSummaries),
    };

    if (cacheCount > 0) {
      schedulerPatch.lastSuccessfulAt = completedAt;
    }

    await updateAggregateCacheScheduler(schedulerPatch);

    return {
      trigger,
      userSummaries,
      cacheCount,
      sourceCount,
      failureCount,
    };
  })()
    .catch(async (error) => {
      await updateAggregateCacheScheduler({
        running: false,
        lastCompletedAt: new Date().toISOString(),
        lastDurationMs: Date.now() - startedAtMs,
        lastError: error.message,
      });
      throw error;
    })
    .finally(async () => {
      aggregatePreRegistrationJob = null;
      await scheduleAggregatePreRegistration();
    });

  return aggregatePreRegistrationJob;
}

async function tryServeAggregatePreRegistrationCache(response, request, type, relayUser, runtime) {
  const preRegistration = getAggregatePreRegistrationSettings(runtime?.upstreamAggregation);
  if (
    runtime?.activeUpstreamMode !== ACTIVE_UPSTREAM_MODES.AGGREGATE
    || !preRegistration.enabled
  ) {
    return false;
  }

  const configuredTargets = await getRuntimeAggregateTargets(type);
  const signature = buildAggregateTargetSignature(configuredTargets);
  const cacheEntry = await getAggregateCacheEntry(relayUser.key, type);
  const hasUsableCache = Boolean(cacheEntry?.bodyBase64);
  const signatureMatches = Boolean(signature && cacheEntry?.signature === signature);

  if (!hasUsableCache || !signatureMatches) {
    aggregatePreRegistrationImmediateRequested = true;
    scheduleAggregatePreRegistration().catch(() => undefined);
  }

  if (!hasUsableCache) {
    sendEmptyAggregateSubscription(response, request, type, runtime);
    return true;
  }

  const bodyBuffer = upgradeLegacyCachedAggregateBody(
    type,
    Buffer.from(cacheEntry.bodyBase64, "base64"),
  );
  if (bodyBuffer.length === 0) {
    sendEmptyAggregateSubscription(response, request, type, runtime);
    return true;
  }

  sendSubscriptionPayload(
    response,
    request.method,
    {
      ...cacheEntry.headers,
      "content-type": getContentTypeByRelayType(
        type,
        cacheEntry.headers?.["content-type"] || "text/plain; charset=utf-8",
      ),
    },
    bodyBuffer,
  );

  return true;
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
    aggregatePreRegistrationStatus,
  ] = await Promise.all([
    getActiveUpstreamRuntime(),
    getDisplayOrigin(),
    listRelayUsers(),
    buildAppUpdateStatus(false),
    buildUpstreamCloudStatus(false),
    getUpstreamCloudConfig(),
    getAggregateCacheScheduler(),
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
    aggregatePreRegistrationStatus,
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
  const shouldRefreshAggregateCache =
    body.upstreamAggregation !== undefined
    || body.activeUpstreamMode !== undefined
    || body.upstreamOrder !== undefined
    || body.upstreamId !== undefined
    || body.name !== undefined
    || body.remark !== undefined
    || body.enabled !== undefined
    || body.inviteCode !== undefined
    || body.runtimeMode !== undefined
    || body.trafficThresholdPercent !== undefined
    || body.maxRegistrationAgeMinutes !== undefined
    || body.subscriptionUpdateIntervalMinutes !== undefined
    || body.providerSettings !== undefined;

  if (body.upstreamCloud !== undefined) {
    invalidateCaches();
  }

  if (shouldRefreshAggregateCache) {
    aggregatePreRegistrationImmediateRequested = true;
  }

  await scheduleAggregatePreRegistration({
    immediate: shouldRefreshAggregateCache,
  });
  const aggregatePreRegistrationStatus = await getAggregateCacheScheduler();

  sendJson(response, 200, {
    success: true,
    message: "Settings updated.",
    activeUpstreamId: result.activeUpstreamId,
    activeUpstreamMode: result.activeUpstreamMode,
    displayOrigin: result.displayOrigin,
    upstreamOrder: result.upstreamOrder,
    upstreamAggregation: result.upstreamAggregation,
    aggregatePreRegistrationStatus,
    upstreamCloud: result.upstreamCloud,
    updatedAt: result.updatedAt,
    upstreamConfig: result.upstreamConfig,
  });
}

async function handleTestUpstream(request, response) {
  const body = await readJsonBody(request);
  const upstreamId = (body.upstreamId || "").toString().trim();
  const userKey = normalizeUserKey(body.userKey);
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

  let verification = null;
  let usedFallback = false;
  const runtime = await getActiveUpstreamRuntime();

  try {
    const record = await module.register({
      inviteCode: (body.inviteCode || testConfig.inviteCode || "").toString().trim(),
      upstreamConfig: testConfig,
      verbose: false,
      logger: console,
    });

    verification = await verifyUpstreamRecordForTest(module, upstreamId, testConfig, {
      source: "fresh_registration",
      record,
      usage: null,
      userKey: "",
      storageKey: upstreamId,
    });
  } catch (error) {
    if (!isUpstreamRegistrationRateLimited(error)) {
      throw error;
    }

    verification = await findReusableUpstreamTestResult(module, upstreamId, testConfig);
    if (!verification) {
      throw error;
    }
    usedFallback = true;
  }

  const persisted = await persistVerifiedUpstreamTestResult(userKey, upstreamId, verification, runtime);
  const relayToken = await getRelayToken(userKey);
  const clientUrls = filterUrlMapBySupportedTypes(
    verification.record?.clientUrls,
    Array.isArray(module.manifest?.supportedTypes) ? module.manifest.supportedTypes : [],
  );
  const supportedTypes = Array.from(
    new Set([
      ...Object.keys(clientUrls),
      ...(Array.isArray(module.manifest?.supportedTypes) ? module.manifest.supportedTypes : []),
    ]),
  ).filter((type) => Boolean(clientUrls[type]));
  const relayUrls = filterUrlMapBySupportedTypes(
    buildRelayUrls(await getRequestOrigin(request), relayToken),
    supportedTypes,
  );
  const scopedRelayUrls = filterUrlMapBySupportedTypes(
    buildScopedRelayUrls(await getRequestOrigin(request), relayToken, upstreamId),
    supportedTypes,
  );

  sendJson(response, 200, {
    success: true,
    message: usedFallback
      ? verification.subscriptionError
        ? `Upstream registration is temporarily rate-limited, but cached account verification succeeded: ${verification.subscriptionError}`
        : verification.queryError
        ? `Upstream registration is temporarily rate-limited, but cached account status verification succeeded: ${verification.queryError}`
        : "Upstream registration is temporarily rate-limited, but cached account verification succeeded."
      : verification.subscriptionError
      ? `Upstream registration succeeded, but subscription verification failed: ${verification.subscriptionError}`
      : verification.queryError
      ? `Upstream registration succeeded, but status query failed: ${verification.queryError}`
      : "Upstream test succeeded.",
    test: {
      upstreamId,
      label: testConfig.name || module.manifest.label || upstreamId,
      supportedTypes,
      registration: {
        email: verification.record?.email || "",
        upstreamSite: verification.record?.upstreamSite || "",
        createdAt: verification.record?.createdAt || "",
      },
      queryVerified: Boolean(verification.usage),
      queryError: verification.queryError,
      subscriptionVerified: Boolean(verification.subscriptionTest?.verified),
      subscriptionType: verification.subscriptionTest?.type || "",
      subscriptionNodeCount: Number.parseInt(verification.subscriptionTest?.nodeCount, 10) || 0,
      subscriptionFetchProfile: verification.subscriptionTest?.requestProfileKey || "",
      subscriptionFetchTransport: verification.subscriptionTest?.transportKey || "",
      subscriptionUrl: verification.subscriptionTest?.url || "",
      subscriptionError: verification.subscriptionError,
      clientUrls,
      relayUrls,
      scopedRelayUrls,
      usedFallback,
      fallbackSource: usedFallback ? verification.source : "",
      persisted,
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
  const viewMode = (url.searchParams.get("view") || "").toString().trim().toLowerCase();
  const localOnly = viewMode === "local";
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

  if (localOnly) {
    const cachedView = await buildCachedViewResponse(
      request,
      userKey,
      type,
      runtime,
      url.searchParams.get("upstreamId") ? upstreamId : "",
    );

    sendJson(response, 200, {
      success: true,
      message: cachedView.message,
      ...cachedView.payload,
    });
    return;
  }

  if (!url.searchParams.get("upstreamId") && runtime.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.AGGREGATE) {
    const result = await resolveAggregateViewStates(userKey, type === "full" ? "universal" : type, {
      timeoutSeconds: runtime.upstreamAggregation?.timeoutSeconds,
    });

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
  const scopedUpstreamId = (url.searchParams.get("upstreamId") || "").trim();
  const relayUser = await resolveRelayUserByToken(token);

  if (!relayUser) {
    sendText(response, 403, "Invalid subscription token.");
    return;
  }

  if (scopedUpstreamId) {
    await proxyScopedUpstreamSubscription(response, request, type, relayUser, scopedUpstreamId);
    return;
  }

  const runtime = await getActiveUpstreamRuntime();
  if (runtime.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.AGGREGATE) {
    if (await tryServeAggregatePreRegistrationCache(response, request, type, relayUser, runtime)) {
      return;
    }

    await proxyAggregateSubscription(response, request, type, relayUser, runtime);
    return;
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

      const relaySource = {
        upstreamId,
        storageKey: upstreamId,
        upstreamConfig,
        userState,
      };
      const redirectLocation =
        candidateUpstreamIds.length === 1
          ? getRelayUpstreamRedirectLocation(relaySource, type)
          : "";
      if (redirectLocation) {
        await appendUserHistory(relayUser.key, upstreamId, {
          action: "relay_success",
          title: "Relay redirected to upstream.",
          message: `Client fetched ${type} subscription via upstream redirect.`,
          mode: runtimeMode,
          relayType: type,
          requestSource: "relay",
          registration: latest,
          usage: userState.latestUsage,
          details: {
            redirected: true,
            upstreamId,
          },
        });
        response.writeHead(302, {
          Location: redirectLocation,
          "Cache-Control": "no-store, max-age=0, must-revalidate",
          Pragma: "no-cache",
        });
        response.end();
        return;
      }

      const payload = await fetchResolvedSubscriptionSource(
        relaySource,
        type,
        request.method,
      );
      if (isDegradedServerSidePayload(relaySource, payload, request.method)) {
        throw createDegradedServerSidePayloadError(relaySource, payload);
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
  scheduleAggregatePreRegistration().catch((error) => {
    console.error("Failed to initialize aggregate pre-registration scheduler:", error);
  });
});
