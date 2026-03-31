"use strict";

process.env.NODE_TLS_REJECT_UNAUTHORIZED =
  process.env.ALLOW_INSECURE_TLS === "0" ? process.env.NODE_TLS_REJECT_UNAUTHORIZED : "0";

const yaml = require("js-yaml");

const DEFAULT_API_BASE = "https://ap.apsnaillink.com/api/v1";
const DEFAULT_UPSTREAM_ENTRY_URL = "https://xn--9kq658f7go.com/";
const DEFAULT_OFFICIAL_SITES = [
  "https://snaillink.com",
  "https://snaillink.net",
  "https://8.217.75.79:1000",
];
const MAX_RETRIES = Number.parseInt(process.env.MAX_RETRIES || "3", 10);
const RETRY_DELAY_MS = Number.parseInt(process.env.RETRY_DELAY_MS || "3000", 10);
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10);
const CONFIG_FETCH_TIMEOUT_MS = Number.parseInt(process.env.SNAIL_CONFIG_FETCH_TIMEOUT_MS || "5000", 10);
const CONFIG_CACHE_TTL_MS = Number.parseInt(process.env.SNAIL_CONFIG_CACHE_TTL_MS || "600000", 10);
const SUBSCRIPTION_VERIFY_ATTEMPTS = Number.parseInt(
  process.env.SNAIL_SUBSCRIPTION_VERIFY_ATTEMPTS || "3",
  10,
);
const SUBSCRIPTION_VERIFY_DELAY_MS = Number.parseInt(
  process.env.SNAIL_SUBSCRIPTION_VERIFY_DELAY_MS || "1200",
  10,
);
const DEFAULT_EMAIL_DOMAIN =
  (process.env.SNAIL_EMAIL_DOMAIN || "gmail.com").toString().trim().replace(/^@+/, "") || "gmail.com";
const { ensureProxyConfigured } = require("../../httpClient");
const upstreamConfigCache = new Map();

const URL_TYPES = Object.freeze({
  universal: "",
  clash: "clash",
  shadowrocket: "shadowrocket",
  surge: "surge",
  quantumultx: "quantumultx",
  "sing-box": "sing-box",
});

function createLogger(enabled, logger = console) {
  return {
    log(message) {
      if (enabled && logger && typeof logger.log === "function") {
        logger.log(message);
      }
    },
    error(message) {
      if (enabled && logger && typeof logger.error === "function") {
        logger.error(message);
      }
    },
  };
}

function normalizeUrlBase(input) {
  const url = new URL(input);
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

function normalizeOptionalUrlBase(input) {
  const value = (input || "").toString().trim();
  if (!value) {
    return "";
  }

  try {
    return normalizeUrlBase(value);
  } catch (error) {
    return "";
  }
}

function buildUrl(base, pathName) {
  return new URL(pathName, `${normalizeUrlBase(base)}/`).toString();
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.json();
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildUpstreamConfigCacheKey(input = {}) {
  return JSON.stringify({
    entryUrl: input.entryUrl || "",
    officialSiteUrl: input.officialSiteUrl || "",
    apiBase: input.apiBase || "",
    defaultApiBase: input.defaultApiBase || "",
    defaultOfficialSites: Array.isArray(input.defaultOfficialSites) ? input.defaultOfficialSites : [],
  });
}

function getCachedUpstreamConfig(cacheKey) {
  const cached = upstreamConfigCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    upstreamConfigCache.delete(cacheKey);
    return null;
  }

  return cloneSerializable(cached.value);
}

function setCachedUpstreamConfig(cacheKey, value) {
  const cachedValue = cloneSerializable(value);
  upstreamConfigCache.set(cacheKey, {
    expiresAt: Date.now() + Math.max(1000, CONFIG_CACHE_TTL_MS),
    value: cachedValue,
  });
  return cloneSerializable(cachedValue);
}

function deleteCachedUpstreamConfig(cacheKey) {
  upstreamConfigCache.delete(cacheKey);
}

async function resolveConfigFromCandidate(candidate, logger) {
  const siteBase = normalizeUrlBase(candidate);
  const siteConfig = await fetchJson(buildUrl(siteBase, "/config.json"), CONFIG_FETCH_TIMEOUT_MS);
  const apiBase =
    typeof siteConfig.api_base === "string" && siteConfig.api_base.trim()
      ? siteConfig.api_base.trim()
      : "";

  if (!apiBase) {
    throw new Error("Site config did not return api_base.");
  }

  logger.log(`[upstream] Resolved API from ${siteBase}`);
  return {
    siteBase,
    apiBase,
  };
}

async function resolveUpstreamConfig(options = {}) {
  const logger = createLogger(options.verbose !== false, options.logger);
  const defaultEntryUrl =
    options.defaultEntryUrl || options.entryUrl || process.env.UPSTREAM_ENTRY_URL || DEFAULT_UPSTREAM_ENTRY_URL;
  const defaultApiBase =
    options.defaultApiBase || options.apiBase || process.env.API_BASE || DEFAULT_API_BASE;
  const defaultOfficialSites = uniqueStrings([
    ...(Array.isArray(options.defaultOfficialSites) ? options.defaultOfficialSites : []),
    ...(Array.isArray(DEFAULT_OFFICIAL_SITES) ? DEFAULT_OFFICIAL_SITES : []),
  ]);
  const entryUrl = options.entryUrl || process.env.UPSTREAM_ENTRY_URL || defaultEntryUrl;
  const configuredOfficialSiteUrl = options.officialSiteUrl || process.env.OFFICIAL_SITE_URL || "";
  const detectorConfigUrl = buildUrl(entryUrl, "/config.json");

  if (options.apiBase || process.env.API_BASE) {
    return {
      entryUrl,
      detectorConfigUrl,
      siteBase: configuredOfficialSiteUrl,
      apiBase: options.apiBase || process.env.API_BASE,
      source: options.apiBase ? "config" : "env",
    };
  }

  const cacheKey = buildUpstreamConfigCacheKey({
    entryUrl,
    officialSiteUrl: configuredOfficialSiteUrl,
    defaultApiBase,
    defaultOfficialSites,
  });
  if (!options.forceRefresh) {
    const cached = getCachedUpstreamConfig(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const candidates = [
    configuredOfficialSiteUrl,
    ...defaultOfficialSites,
  ];

  try {
    const detectorConfig = await fetchJson(detectorConfigUrl, CONFIG_FETCH_TIMEOUT_MS);
    if (Array.isArray(detectorConfig.urls)) {
      candidates.unshift(...detectorConfig.urls);
    }
  } catch (error) {
    logger.log(`[upstream] Failed to read detector config: ${error.message}`);
  }

  const uniqueCandidates = uniqueStrings(candidates);
  try {
    const resolved = await Promise.any(
      uniqueCandidates.map(async (candidate) => {
        try {
          return await resolveConfigFromCandidate(candidate, logger);
        } catch (error) {
          logger.log(`[upstream] Candidate failed: ${candidate} (${error.message})`);
          throw error;
        }
      }),
    );

    return setCachedUpstreamConfig(cacheKey, {
      entryUrl,
      detectorConfigUrl,
      siteBase: resolved.siteBase,
      apiBase: resolved.apiBase,
      source: "detector",
    });
  } catch (error) {
    // Fall through to the default API base.
  }

  logger.log(`[upstream] Falling back to default API base: ${defaultApiBase}`);
  return setCachedUpstreamConfig(cacheKey, {
    entryUrl,
    detectorConfigUrl,
    siteBase: normalizeOptionalUrlBase(configuredOfficialSiteUrl || defaultOfficialSites[0] || ""),
    apiBase: defaultApiBase,
    source: "fallback",
  });
}

function generateRandomEmail(domain = DEFAULT_EMAIL_DOMAIN) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let localPart = "";

  for (let index = 0; index < 10; index += 1) {
    localPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return `${localPart}@${domain}`;
}

function generateRandomPassword() {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const special = "@#$%&*!";
  const all = upper + lower + digits + special;

  let password = "";
  password += upper.charAt(Math.floor(Math.random() * upper.length));
  password += lower.charAt(Math.floor(Math.random() * lower.length));
  password += digits.charAt(Math.floor(Math.random() * digits.length));
  password += special.charAt(Math.floor(Math.random() * special.length));

  for (let index = 0; index < 8; index += 1) {
    password += all.charAt(Math.floor(Math.random() * all.length));
  }

  return password
    .split("")
    .sort(() => Math.random() - 0.5)
    .join("");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createApiError(message, options = {}) {
  const error = new Error(message);
  error.retryable = options.retryable !== false;
  if (Number.isFinite(options.status) && options.status > 0) {
    error.status = options.status;
  }
  return error;
}

function isRetryableApiMessage(message = "") {
  const text = (message || "").toString().trim();
  const normalized = text.toLowerCase();
  if (!text) {
    return false;
  }

  const permanentMessages = [
    "邮箱后缀不处于白名单中",
    "注册频繁，请等待 60 分钟后再次尝试",
    "未登录或登陆已过期",
    "邀请码",
    "邮箱已存在",
    "参数错误",
  ];
  if (permanentMessages.some((item) => text.includes(item))) {
    return false;
  }

  const temporaryKeywords = [
    "timeout",
    "timed out",
    "fetch failed",
    "network",
    "temporarily",
    "temporary",
    "超时",
    "稍后",
    "繁忙",
    "异常",
    "失败",
  ];
  return temporaryKeywords.some((item) => normalized.includes(item.toLowerCase()));
}

async function apiRequest(apiBase, endpoint, options = {}, retries = MAX_RETRIES) {
  const url = `${apiBase}${endpoint}`;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });

      const raw = await response.text();
      let data;

      try {
        data = JSON.parse(raw);
      } catch (error) {
        throw createApiError(`Unexpected non-JSON response from ${endpoint}`, {
          retryable: true,
          status: response.status,
        });
      }

      if (!response.ok) {
        const message =
          data?.message || data?.error || `Request failed with status ${response.status}`;
        throw createApiError(message, {
          retryable: response.status >= 500 || response.status === 408 || response.status === 429,
          status: response.status,
        });
      }

      if (data?.status && data.status !== "success") {
        throw createApiError(data.message || data.error || `Request to ${endpoint} failed.`, {
          retryable: isRetryableApiMessage(data.message || data.error || ""),
          status: response.status,
        });
      }

      return data;
    } catch (error) {
      if (error.retryable === false) {
        throw createApiError(`Request to ${endpoint} failed: ${error.message}`, {
          retryable: false,
          status: error.status,
        });
      }

      if (attempt >= retries) {
        throw createApiError(`Request to ${endpoint} failed after ${retries} attempts: ${error.message}`, {
          retryable: error.retryable !== false,
          status: error.status,
        });
      }

      await sleep(RETRY_DELAY_MS);
    }
  }

  throw new Error(`Request to ${endpoint} failed unexpectedly.`);
}

function buildClientUrls(subscribeUrl) {
  const urls = {};

  for (const [type, flag] of Object.entries(URL_TYPES)) {
    urls[type] = flag ? `${subscribeUrl}&flag=${flag}` : subscribeUrl;
  }

  return urls;
}

function buildRegistrationResult({
  email,
  password,
  inviteCode,
  token,
  subscribeUrl,
  mock = false,
  upstreamSite = "",
  apiBase = DEFAULT_API_BASE,
  entryUrl = DEFAULT_UPSTREAM_ENTRY_URL,
  detectorConfigUrl = buildUrl(DEFAULT_UPSTREAM_ENTRY_URL, "/config.json"),
  upstreamSource = "fallback",
}) {
  return {
    email,
    password,
    inviteCode: inviteCode || "",
    token,
    subscribeUrl,
    clientUrls: buildClientUrls(subscribeUrl),
    createdAt: new Date().toISOString(),
    mock,
    upstreamSite,
    apiBase,
    entryUrl,
    detectorConfigUrl,
    upstreamSource,
  };
}

function normalizeBase64Padding(value) {
  const remainder = value.length % 4;
  if (remainder === 0) {
    return value;
  }

  return value.padEnd(value.length + (4 - remainder), "=");
}

function tryDecodeBase64(value) {
  const source = (value || "").toString().trim();
  if (!source || !/^[A-Za-z0-9+/=\r\n_-]+$/.test(source)) {
    return "";
  }

  try {
    return Buffer.from(
      normalizeBase64Padding(source.replace(/-/g, "+").replace(/_/g, "/")),
      "base64",
    ).toString("utf8");
  } catch (error) {
    return "";
  }
}

function countUniversalSubscriptionNodes(body) {
  const rawBody = (body || "").toString("utf8").trim();
  if (!rawBody) {
    return 0;
  }

  const decoded = tryDecodeBase64(rawBody);
  const source = decoded && /:\/\//.test(decoded) ? decoded : rawBody;
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("://")).length;
}

function countClashSubscriptionNodes(body) {
  try {
    const parsed = yaml.load((body || "").toString("utf8"));
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => item && typeof item === "object").length;
    }
    return Array.isArray(parsed?.proxies) ? parsed.proxies.length : 0;
  } catch (error) {
    return 0;
  }
}

function buildFlaggedSubscribeUrl(subscribeUrl, type) {
  if (!type || type === "universal") {
    return subscribeUrl;
  }

  return `${subscribeUrl}${subscribeUrl.includes("?") ? "&" : "?"}flag=${encodeURIComponent(type)}`;
}

async function fetchSubscriptionText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await response.text(),
  };
}

async function verifySubscriptionReadiness(subscribeUrl) {
  const universalUrl = buildFlaggedSubscribeUrl(subscribeUrl, "universal");

  try {
    const universal = await fetchSubscriptionText(universalUrl);
    const universalNodeCount = universal.ok ? countUniversalSubscriptionNodes(universal.body) : 0;
    if (universalNodeCount > 0) {
      return {
        ready: true,
        verifiedType: "universal",
        nodeCount: universalNodeCount,
      };
    }
  } catch (error) {
    // Fall through to clash verification.
  }

  const clashUrl = buildFlaggedSubscribeUrl(subscribeUrl, "clash");
  try {
    const clash = await fetchSubscriptionText(clashUrl);
    const clashNodeCount = clash.ok ? countClashSubscriptionNodes(clash.body) : 0;
    if (clashNodeCount > 0) {
      return {
        ready: true,
        verifiedType: "clash",
        nodeCount: clashNodeCount,
      };
    }

    return {
      ready: false,
      reason: clash.ok
        ? "Subscription returned an empty clash node list."
        : `Subscription request failed with status ${clash.status}.`,
    };
  } catch (error) {
    return {
      ready: false,
      reason: error.message,
    };
  }
}

async function fetchVerifiedSubscriptionUrl(apiBase, token, logger) {
  const headers = { Authorization: token };
  let lastReason = "Subscription URL is missing from API response.";

  for (let attempt = 1; attempt <= SUBSCRIPTION_VERIFY_ATTEMPTS; attempt += 1) {
    const subscribeResult = await apiRequest(apiBase, "/user/getSubscribe", { headers });
    const subscribeUrl = typeof subscribeResult.data?.subscribe_url === "string"
      ? subscribeResult.data.subscribe_url.trim()
      : "";

    if (subscribeUrl) {
      const verification = await verifySubscriptionReadiness(subscribeUrl);
      if (verification.ready) {
        return subscribeUrl;
      }

      lastReason = verification.reason || lastReason;
    }

    if (attempt < SUBSCRIPTION_VERIFY_ATTEMPTS) {
      logger.log(
        `[upstream] Subscription not ready yet (${attempt}/${SUBSCRIPTION_VERIFY_ATTEMPTS}): ${lastReason}`,
      );
      await sleep(SUBSCRIPTION_VERIFY_DELAY_MS);
    }
  }

  throw new Error(
    `Subscription was created but returned no nodes after ${SUBSCRIPTION_VERIFY_ATTEMPTS} checks: ${lastReason}`,
  );
}

function toIsoDate(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "";
  }

  return new Date(value * 1000).toISOString();
}

function normalizeTrafficValue(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return value;
}

function buildUsageSnapshot({
  subscribeData,
  infoData,
  statData,
  apiBase,
  upstreamSite = "",
  entryUrl = DEFAULT_UPSTREAM_ENTRY_URL,
  detectorConfigUrl = buildUrl(DEFAULT_UPSTREAM_ENTRY_URL, "/config.json"),
  upstreamSource = "fallback",
}) {
  const usedUpload = normalizeTrafficValue(subscribeData?.u);
  const usedDownload = normalizeTrafficValue(subscribeData?.d);
  const transferEnable = normalizeTrafficValue(
    subscribeData?.transfer_enable ?? infoData?.transfer_enable,
  );
  const usedTotal = usedUpload + usedDownload;
  const remainingTraffic = Math.max(transferEnable - usedTotal, 0);
  const remainingPercent = transferEnable > 0 ? (remainingTraffic / transferEnable) * 100 : 0;
  const usagePercent = transferEnable > 0 ? (usedTotal / transferEnable) * 100 : 0;
  const subscribeUrl = typeof subscribeData?.subscribe_url === "string"
    ? subscribeData.subscribe_url
    : "";

  return {
    queriedAt: new Date().toISOString(),
    email: subscribeData?.email || infoData?.email || "",
    subscribeUrl,
    clientUrls: subscribeUrl ? buildClientUrls(subscribeUrl) : {},
    planId: subscribeData?.plan_id ?? infoData?.plan_id ?? null,
    planName: subscribeData?.plan?.name || "",
    resetDay: subscribeData?.reset_day ?? null,
    expiredAt: toIsoDate(subscribeData?.expired_at ?? infoData?.expired_at),
    accountCreatedAt: toIsoDate(infoData?.created_at),
    lastLoginAt: toIsoDate(infoData?.last_login_at),
    transferEnable,
    usedUpload,
    usedDownload,
    usedTotal,
    remainingTraffic,
    remainingPercent: Number(remainingPercent.toFixed(2)),
    usagePercent: Number(usagePercent.toFixed(2)),
    stat: statData ?? null,
    upstreamSite,
    apiBase,
    entryUrl,
    detectorConfigUrl,
    upstreamSource,
  };
}

async function querySubscriptionStatus(options = {}) {
  const logger = createLogger(options.verbose !== false, options.logger);
  const authToken = (options.token || "").toString().trim();

  if (!authToken) {
    throw new Error("Missing auth token for upstream status query.");
  }

  ensureProxyConfigured();

  const upstream =
    options.apiBase || options.entryUrl || options.officialSiteUrl
      ? {
          entryUrl:
            options.entryUrl ||
            process.env.UPSTREAM_ENTRY_URL ||
            options.defaultEntryUrl ||
            DEFAULT_UPSTREAM_ENTRY_URL,
          detectorConfigUrl:
            options.detectorConfigUrl ||
            buildUrl(
              options.entryUrl ||
                process.env.UPSTREAM_ENTRY_URL ||
                options.defaultEntryUrl ||
                DEFAULT_UPSTREAM_ENTRY_URL,
              "/config.json",
            ),
          siteBase: options.upstreamSite || options.officialSiteUrl || "",
          apiBase: options.apiBase || options.defaultApiBase || DEFAULT_API_BASE,
          source: options.upstreamSource || "record",
        }
      : await resolveUpstreamConfig({
          entryUrl: options.entryUrl,
          officialSiteUrl: options.officialSiteUrl,
          apiBase: options.apiBase,
          defaultEntryUrl: options.defaultEntryUrl,
          defaultOfficialSites: options.defaultOfficialSites,
          defaultApiBase: options.defaultApiBase,
          verbose: options.verbose,
          logger: options.logger,
        });

  logger.log("[upstream] Querying current subscription status");

  const headers = { Authorization: authToken };
  const [subscribeResult, infoResult, statResult] = await Promise.all([
    apiRequest(upstream.apiBase, "/user/getSubscribe", { headers }),
    apiRequest(upstream.apiBase, "/user/info", { headers }),
    apiRequest(upstream.apiBase, "/user/getStat", { headers }),
  ]);

  if (subscribeResult.status !== "success") {
    throw new Error(subscribeResult.message || JSON.stringify(subscribeResult));
  }

  if (infoResult.status !== "success") {
    throw new Error(infoResult.message || JSON.stringify(infoResult));
  }

  if (statResult.status !== "success") {
    throw new Error(statResult.message || JSON.stringify(statResult));
  }

  return buildUsageSnapshot({
    subscribeData: subscribeResult.data || {},
    infoData: infoResult.data || {},
    statData: statResult.data,
    apiBase: upstream.apiBase,
    upstreamSite: upstream.siteBase,
    entryUrl: upstream.entryUrl,
    detectorConfigUrl: upstream.detectorConfigUrl,
    upstreamSource: upstream.source,
  });
}

function buildMockResult(inviteCode = "") {
  const email = generateRandomEmail();
  const password = generateRandomPassword();
  const token = `mock-token-${Date.now()}`;
  const subscribeUrl = `https://mock.snail.local/sub/${token}`;

  return buildRegistrationResult({
    email,
    password,
    inviteCode,
    token,
    subscribeUrl,
    mock: true,
    upstreamSite: "https://snaillink.com",
    apiBase: DEFAULT_API_BASE,
    entryUrl: process.env.UPSTREAM_ENTRY_URL || DEFAULT_UPSTREAM_ENTRY_URL,
    detectorConfigUrl: buildUrl(
      process.env.UPSTREAM_ENTRY_URL || DEFAULT_UPSTREAM_ENTRY_URL,
      "/config.json",
    ),
    upstreamSource: "mock",
  });
}

async function registerAndFetchSubscribe(options = {}) {
  const inviteCode = typeof options.inviteCode === "string" ? options.inviteCode.trim() : "";
  const logger = createLogger(options.verbose !== false, options.logger);

  if (process.env.AUTO_REGISTER_MOCK === "1") {
    const mockResult = buildMockResult(inviteCode);
    logger.log("[mock] Registration script executed in mock mode.");
    return mockResult;
  }

  ensureProxyConfigured();

  const resolveOptions = {
    entryUrl: options.entryUrl,
    officialSiteUrl: options.officialSiteUrl,
    apiBase: options.apiBase,
    defaultEntryUrl: options.defaultEntryUrl,
    defaultOfficialSites: options.defaultOfficialSites,
    defaultApiBase: options.defaultApiBase,
    verbose: options.verbose,
    logger: options.logger,
  };
  const cacheKey = buildUpstreamConfigCacheKey({
    entryUrl:
      options.entryUrl || process.env.UPSTREAM_ENTRY_URL || options.defaultEntryUrl || DEFAULT_UPSTREAM_ENTRY_URL,
    officialSiteUrl: options.officialSiteUrl || process.env.OFFICIAL_SITE_URL || "",
    apiBase: options.apiBase || process.env.API_BASE || "",
    defaultApiBase: options.defaultApiBase || DEFAULT_API_BASE,
    defaultOfficialSites: uniqueStrings([
      ...(Array.isArray(options.defaultOfficialSites) ? options.defaultOfficialSites : []),
      ...DEFAULT_OFFICIAL_SITES,
    ]),
  });
  const email = generateRandomEmail();
  const password = generateRandomPassword();

  logger.log("==================================================");
  logger.log("  SnailLink auto registration");
  logger.log("==================================================");

  async function attemptRegistration(upstream) {
    logger.log(`[upstream] Entry: ${upstream.entryUrl}`);
    logger.log(`[upstream] API: ${upstream.apiBase}`);
    logger.log(`[1/3] Registering account: ${email}`);

    const registerBody = { email, password };
    if (inviteCode) {
      registerBody.invite_code = inviteCode;
    }

    const registerResult = await apiRequest(upstream.apiBase, "/passport/auth/register", {
      method: "POST",
      body: JSON.stringify(registerBody),
    });

    logger.log("[2/3] Fetching auth token");

    let token = registerResult.data?.auth_data || registerResult.data?.token;

    if (!token) {
      const loginResult = await apiRequest(upstream.apiBase, "/passport/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      token = loginResult.data?.auth_data || loginResult.data?.token;
    }

    if (!token) {
      throw new Error("No auth token returned from register/login endpoint.");
    }

    logger.log("[3/3] Fetching subscription URL");
    const subscribeUrl = await fetchVerifiedSubscriptionUrl(upstream.apiBase, token, logger);

    return buildRegistrationResult({
      email,
      password,
      inviteCode,
      token,
      subscribeUrl,
      upstreamSite: upstream.siteBase,
      apiBase: upstream.apiBase,
      entryUrl: upstream.entryUrl,
      detectorConfigUrl: upstream.detectorConfigUrl,
      upstreamSource: upstream.source,
    });
  }

  let upstream = await resolveUpstreamConfig(resolveOptions);
  try {
    return await attemptRegistration(upstream);
  } catch (error) {
    if (
      (options.apiBase || process.env.API_BASE)
      || error.retryable === false
    ) {
      throw error;
    }

    logger.log(`[upstream] Initial registration attempt failed, refreshing upstream config: ${error.message}`);
    deleteCachedUpstreamConfig(cacheKey);
    upstream = await resolveUpstreamConfig({
      ...resolveOptions,
      forceRefresh: true,
    });
    return attemptRegistration(upstream);
  }
}

module.exports = {
  DEFAULT_API_BASE,
  DEFAULT_OFFICIAL_SITES,
  DEFAULT_UPSTREAM_ENTRY_URL,
  URL_TYPES,
  apiRequest,
  buildClientUrls,
  buildRegistrationResult,
  buildUsageSnapshot,
  ensureProxyConfigured,
  querySubscriptionStatus,
  registerAndFetchSubscribe,
  resolveUpstreamConfig,
};
