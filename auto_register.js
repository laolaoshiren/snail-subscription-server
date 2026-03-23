"use strict";

process.env.NODE_TLS_REJECT_UNAUTHORIZED =
  process.env.ALLOW_INSECURE_TLS === "0" ? process.env.NODE_TLS_REJECT_UNAUTHORIZED : "0";

const DEFAULT_API_BASE = "https://ap.apsnaillink.com/api/v1";
const DEFAULT_UPSTREAM_ENTRY_URL = "https://xn--9kq658f7go.com/";
const DEFAULT_OFFICIAL_SITES = [
  "https://snaillink.com",
  "https://snaillink.net",
  "https://8.217.75.79:1000",
];
const DEFAULT_PROXY_URL = process.env.PROXY_URL || "http://127.0.0.1:7890";
const MAX_RETRIES = Number.parseInt(process.env.MAX_RETRIES || "3", 10);
const RETRY_DELAY_MS = Number.parseInt(process.env.RETRY_DELAY_MS || "3000", 10);
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10);

const URL_TYPES = Object.freeze({
  universal: "",
  clash: "clash",
  shadowrocket: "shadowrocket",
  surge: "surge",
  quantumultx: "quantumultx",
  "sing-box": "sing-box",
});

let proxyConfigured = false;

function ensureProxyConfigured() {
  if (proxyConfigured) {
    return;
  }

  if (!DEFAULT_PROXY_URL || DEFAULT_PROXY_URL === "off") {
    proxyConfigured = true;
    return;
  }

  try {
    const { ProxyAgent, setGlobalDispatcher } = require("undici");
    const dispatcher = new ProxyAgent({
      uri: DEFAULT_PROXY_URL,
      requestTls: { rejectUnauthorized: false },
    });
    setGlobalDispatcher(dispatcher);
  } catch (error) {
    // Fallback to direct connection if undici is unavailable.
  }

  proxyConfigured = true;
}

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

function buildUrl(base, pathName) {
  return new URL(pathName, `${normalizeUrlBase(base)}/`).toString();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.json();
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

async function resolveUpstreamConfig(options = {}) {
  const logger = createLogger(options.verbose !== false, options.logger);
  const entryUrl = options.entryUrl || process.env.UPSTREAM_ENTRY_URL || DEFAULT_UPSTREAM_ENTRY_URL;
  const detectorConfigUrl = buildUrl(entryUrl, "/config.json");

  if (process.env.API_BASE) {
    return {
      entryUrl,
      detectorConfigUrl,
      siteBase: process.env.OFFICIAL_SITE_URL || "",
      apiBase: process.env.API_BASE,
      source: "env",
    };
  }

  const candidates = [
    process.env.OFFICIAL_SITE_URL || "",
    ...DEFAULT_OFFICIAL_SITES,
  ];

  try {
    const detectorConfig = await fetchJson(detectorConfigUrl);
    if (Array.isArray(detectorConfig.urls)) {
      candidates.unshift(...detectorConfig.urls);
    }
  } catch (error) {
    logger.log(`[upstream] Failed to read detector config: ${error.message}`);
  }

  for (const candidate of uniqueStrings(candidates)) {
    try {
      const siteBase = normalizeUrlBase(candidate);
      const siteConfig = await fetchJson(buildUrl(siteBase, "/config.json"));
      if (typeof siteConfig.api_base === "string" && siteConfig.api_base.trim()) {
        logger.log(`[upstream] Resolved API from ${siteBase}`);
        return {
          entryUrl,
          detectorConfigUrl,
          siteBase,
          apiBase: siteConfig.api_base.trim(),
          source: "detector",
        };
      }
    } catch (error) {
      logger.log(`[upstream] Candidate failed: ${candidate} (${error.message})`);
    }
  }

  logger.log(`[upstream] Falling back to default API base: ${DEFAULT_API_BASE}`);
  return {
    entryUrl,
    detectorConfigUrl,
    siteBase: "",
    apiBase: DEFAULT_API_BASE,
    source: "fallback",
  };
}

function generateRandomEmail() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const domains = ["gmail.com", "outlook.com", "yahoo.com", "hotmail.com"];
  let localPart = "";

  for (let index = 0; index < 10; index += 1) {
    localPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  const domain = domains[Math.floor(Math.random() * domains.length)];
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
        throw new Error(`Unexpected non-JSON response from ${endpoint}`);
      }

      if (!response.ok) {
        const message =
          data?.message || data?.error || `Request failed with status ${response.status}`;
        throw new Error(message);
      }

      return data;
    } catch (error) {
      if (attempt >= retries) {
        throw new Error(`Request to ${endpoint} failed after ${retries} attempts: ${error.message}`);
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

  const upstream = await resolveUpstreamConfig({
    entryUrl: options.entryUrl,
    verbose: options.verbose,
    logger: options.logger,
  });
  const email = generateRandomEmail();
  const password = generateRandomPassword();

  logger.log("==================================================");
  logger.log("  SnailLink auto registration");
  logger.log("==================================================");
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

  if (registerResult.status !== "success") {
    throw new Error(registerResult.message || JSON.stringify(registerResult));
  }

  logger.log("[2/3] Fetching auth token");

  let token = registerResult.data?.auth_data || registerResult.data?.token;

  if (!token) {
    const loginResult = await apiRequest(upstream.apiBase, "/passport/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });

    if (loginResult.status !== "success") {
      throw new Error(loginResult.message || JSON.stringify(loginResult));
    }

    token = loginResult.data?.auth_data || loginResult.data?.token;
  }

  if (!token) {
    throw new Error("No auth token returned from register/login endpoint.");
  }

  logger.log("[3/3] Fetching subscription URL");

  const subscribeResult = await apiRequest(upstream.apiBase, "/user/getSubscribe", {
    headers: { Authorization: token },
  });

  if (subscribeResult.status !== "success") {
    throw new Error(subscribeResult.message || JSON.stringify(subscribeResult));
  }

  const subscribeUrl = subscribeResult.data?.subscribe_url;

  if (!subscribeUrl) {
    throw new Error("Subscription URL is missing from API response.");
  }

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

function renderHumanReadableResult(result) {
  return [
    "==================================================",
    "  Registration Result",
    "==================================================",
    `Email:          ${result.email}`,
    `Password:       ${result.password}`,
    `Invite Code:    ${result.inviteCode || "(none)"}`,
    `Created At:     ${result.createdAt}`,
    `Mock Mode:      ${result.mock ? "yes" : "no"}`,
    `Entry URL:      ${result.entryUrl}`,
    `Detector Config:${result.detectorConfigUrl}`,
    `Upstream Site:  ${result.upstreamSite || "(unknown)"}`,
    `API Base:       ${result.apiBase}`,
    "",
    "Subscription URLs:",
    `  Universal:    ${result.clientUrls.universal}`,
    `  Clash:        ${result.clientUrls.clash}`,
    `  Shadowrocket: ${result.clientUrls.shadowrocket}`,
    `  Surge:        ${result.clientUrls.surge}`,
    `  QuantumultX:  ${result.clientUrls.quantumultx}`,
    `  Sing-box:     ${result.clientUrls["sing-box"]}`,
    "==================================================",
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const inviteCode = args.find((arg) => arg && !arg.startsWith("--")) || "";

  try {
    const result = await registerAndFetchSubscribe({
      inviteCode,
      verbose: !jsonOutput,
      logger: console,
    });

    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    console.log(renderHumanReadableResult(result));
  } catch (error) {
    if (jsonOutput) {
      process.stderr.write(`${JSON.stringify({ error: error.message }, null, 2)}\n`);
    } else {
      console.error(`Registration script failed: ${error.message}`);
    }

    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  URL_TYPES,
  buildClientUrls,
  ensureProxyConfigured,
  registerAndFetchSubscribe,
  resolveUpstreamConfig,
};
