"use strict";

process.env.NODE_TLS_REJECT_UNAUTHORIZED =
  process.env.ALLOW_INSECURE_TLS === "0" ? process.env.NODE_TLS_REJECT_UNAUTHORIZED : "0";

const { ensureProxyConfigured } = require("../../httpClient");
const { buildClientUrls } = require("./snailApi");

const DEFAULT_SOONLINK_ENTRY_URL = "https://瞬连.com/";
const DEFAULT_SOONLINK_SITE_URL = "https://soonvpn.world";
const DEFAULT_SOONLINK_API_BASE = "https://ap.soonlinkmid.com/api/v1";
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10);
const THEME_HEADER_VALUE = "mala-pro";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const ENCODED_CHARSET = Buffer.from(
  "bnN6e2dBV3JrWGx4MDhKNkVxOlY0W2RlTzFEUVRDd20yb0IzdHk5alNZSV03Uk01YkhpVWFmLGN9S3VQR3BOaFpMdkY=",
  "base64",
).toString("utf8");
const DECODED_CHARSET = Buffer.from(
  "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY3ODksW117fTo=",
  "base64",
).toString("utf8");

function normalizeString(value) {
  return (value || "").toString().trim();
}

function normalizeUrlBase(input, fallback) {
  const value = normalizeString(input) || fallback;
  const url = new URL(value);
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

function buildUrl(base, pathName, fallback) {
  const normalizedBase = normalizeUrlBase(base, fallback);
  const normalizedPath = normalizeString(pathName).replace(/^\/+/, "");
  return new URL(normalizedPath, `${normalizedBase}/`).toString();
}

function toIsoDate(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "";
  }

  return new Date(value * 1000).toISOString();
}

function decodeSoonlinkString(input) {
  return input
    .split("")
    .map((character) => {
      const index = ENCODED_CHARSET.indexOf(character);
      return index >= 0 ? DECODED_CHARSET[index] : character;
    })
    .join("");
}

function decodeSoonlinkPayload(raw) {
  const content = normalizeString(raw);
  if (!content) {
    throw new Error("Soonlink returned an empty response body.");
  }

  let decoded = Buffer.from(content, "base64").toString("utf8");
  for (let index = 0; index < 10; index += 1) {
    decoded = decodeSoonlinkString(decoded);
  }

  try {
    return JSON.parse(decoded);
  } catch (error) {
    throw new Error("Soonlink returned an invalid encoded payload.");
  }
}

function buildHeaders(officialSiteUrl, extraHeaders = {}) {
  const normalizedSite = normalizeUrlBase(officialSiteUrl, DEFAULT_SOONLINK_SITE_URL);
  return {
    Accept: "application/json, text/plain, */*",
    Origin: normalizedSite,
    Referer: `${normalizedSite}/register`,
    "User-Agent": BROWSER_UA,
    "theme-ua": THEME_HEADER_VALUE,
    ...extraHeaders,
  };
}

async function requestSoonlink(apiBase, officialSiteUrl, endpoint, options = {}) {
  ensureProxyConfigured();

  const url = buildUrl(apiBase, endpoint, DEFAULT_SOONLINK_API_BASE);
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: buildHeaders(officialSiteUrl, options.headers),
    body: options.body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const raw = await response.text();
  const payload = decodeSoonlinkPayload(raw);

  if (!response.ok || payload?.status !== "success") {
    const message = normalizeString(payload?.message || payload?.error || response.statusText);
    throw new Error(message || `Soonlink request failed with status ${response.status}.`);
  }

  return payload;
}

function buildSoonlinkConfig(options = {}) {
  return {
    entryUrl: normalizeUrlBase(options.entryUrl, DEFAULT_SOONLINK_ENTRY_URL),
    officialSiteUrl: normalizeUrlBase(options.officialSiteUrl, DEFAULT_SOONLINK_SITE_URL),
    apiBase: normalizeUrlBase(options.apiBase, DEFAULT_SOONLINK_API_BASE),
  };
}

function generateRandomEmail() {
  const local = `soon-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${local}@gmail.com`;
}

function generateRandomPassword() {
  const random = Math.random().toString(36).slice(2, 10);
  return `Aa1!${random}`;
}

async function fetchGuestConfig(config) {
  const payload = await requestSoonlink(config.apiBase, config.officialSiteUrl, "/guest/comm/config");
  return payload.data || {};
}

async function registerSoonlinkAccount(options = {}) {
  const config = buildSoonlinkConfig(options);
  const guestConfig = await fetchGuestConfig(config);

  if (guestConfig.is_email_verify) {
    throw new Error("Soonlink currently requires email verification and cannot auto-register.");
  }

  if (guestConfig.is_recaptcha) {
    throw new Error("Soonlink currently requires captcha verification and cannot auto-register.");
  }

  const email = generateRandomEmail();
  const password = generateRandomPassword();
  const inviteCode = normalizeString(options.inviteCode);
  const registerForm = new FormData();
  registerForm.append("email", email);
  registerForm.append("password", password);
  if (inviteCode) {
    registerForm.append("invite_code", inviteCode);
  }

  const registerPayload = await requestSoonlink(
    config.apiBase,
    config.officialSiteUrl,
    "/passport/auth/register",
    {
      method: "POST",
      body: registerForm,
    },
  );

  let authToken = normalizeString(registerPayload?.data?.auth_data);
  if (!authToken) {
    const loginForm = new FormData();
    loginForm.append("email", email);
    loginForm.append("password", password);
    const loginPayload = await requestSoonlink(
      config.apiBase,
      config.officialSiteUrl,
      "/passport/auth/login",
      {
        method: "POST",
        body: loginForm,
      },
    );
    authToken = normalizeString(loginPayload?.data?.auth_data);
  }

  if (!authToken) {
    throw new Error("Soonlink did not return auth_data.");
  }

  const subscribePayload = await requestSoonlink(
    config.apiBase,
    config.officialSiteUrl,
    "/user/getSubscribe",
    {
      headers: {
        Authorization: authToken,
      },
    },
  );
  const subscribeUrl = normalizeString(subscribePayload?.data?.subscribe_url);
  if (!subscribeUrl) {
    throw new Error("Soonlink did not return a subscription URL.");
  }

  return {
    email,
    password,
    inviteCode,
    token: authToken,
    subscribeUrl,
    clientUrls: buildClientUrls(subscribeUrl),
    upstreamSite: config.officialSiteUrl,
    apiBase: config.apiBase,
    entryUrl: config.entryUrl,
    upstreamSource: "soonlink",
    expiredAt: toIsoDate(subscribePayload?.data?.expired_at),
  };
}

async function querySoonlinkAccount(options = {}) {
  const config = buildSoonlinkConfig(options);
  const authToken = normalizeString(options.token);
  if (!authToken) {
    throw new Error("Missing Soonlink auth token.");
  }

  const headers = {
    Authorization: authToken,
  };

  const [subscribePayload, infoPayload, statPayload] = await Promise.all([
    requestSoonlink(config.apiBase, config.officialSiteUrl, "/user/getSubscribe", { headers }),
    requestSoonlink(config.apiBase, config.officialSiteUrl, "/user/info", { headers }),
    requestSoonlink(config.apiBase, config.officialSiteUrl, "/user/getStat", { headers }),
  ]);

  const subscribeData = subscribePayload.data || {};
  const infoData = infoPayload.data || {};
  const statData = statPayload.data || null;
  const usedUpload = Number(subscribeData.u || 0) || 0;
  const usedDownload = Number(subscribeData.d || 0) || 0;
  const transferEnable = Number(subscribeData.transfer_enable ?? infoData.transfer_enable ?? 0) || 0;
  const usedTotal = usedUpload + usedDownload;
  const remainingTraffic = Math.max(transferEnable - usedTotal, 0);

  return {
    queriedAt: new Date().toISOString(),
    email: normalizeString(subscribeData.email || infoData.email || options.email),
    subscribeUrl: normalizeString(subscribeData.subscribe_url),
    clientUrls: buildClientUrls(normalizeString(subscribeData.subscribe_url)),
    planId: subscribeData.plan_id ?? infoData.plan_id ?? null,
    planName: normalizeString(subscribeData.plan?.name),
    resetDay: subscribeData.reset_day ?? null,
    expiredAt: toIsoDate(subscribeData.expired_at ?? infoData.expired_at),
    accountCreatedAt: toIsoDate(infoData.created_at),
    lastLoginAt: toIsoDate(infoData.last_login_at),
    transferEnable,
    usedUpload,
    usedDownload,
    usedTotal,
    remainingTraffic,
    remainingPercent: transferEnable > 0 ? Number(((remainingTraffic / transferEnable) * 100).toFixed(2)) : 0,
    usagePercent: transferEnable > 0 ? Number(((usedTotal / transferEnable) * 100).toFixed(2)) : 0,
    stat: statData,
    upstreamSite: config.officialSiteUrl,
    apiBase: config.apiBase,
    entryUrl: config.entryUrl,
    upstreamSource: "soonlink",
  };
}

module.exports = {
  DEFAULT_SOONLINK_API_BASE,
  DEFAULT_SOONLINK_ENTRY_URL,
  DEFAULT_SOONLINK_SITE_URL,
  buildSoonlinkConfig,
  decodeSoonlinkPayload,
  querySoonlinkAccount,
  registerSoonlinkAccount,
  requestSoonlink,
};
