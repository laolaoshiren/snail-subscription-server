"use strict";

process.env.NODE_TLS_REJECT_UNAUTHORIZED =
  process.env.ALLOW_INSECURE_TLS === "0" ? process.env.NODE_TLS_REJECT_UNAUTHORIZED : "0";

const { ensureProxyConfigured } = require("../../httpClient");
const { buildClientUrls } = require("./snailApi");
const {
  buildBrowserHeaders,
  buildUrl,
  generateRandomEmail,
  generateRandomPassword,
  normalizeString,
  normalizeUrlBase,
  toIsoDate,
} = require("./upstreamUtils");

const FETCH_TIMEOUT_MS = Number.parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10);
const THEME_HEADER_VALUE = "mala-pro";
const ENCODED_CHARSET = Buffer.from(
  "bnN6e2dBV3JrWGx4MDhKNkVxOlY0W2RlTzFEUVRDd20yb0IzdHk5alNZSV03Uk01YkhpVWFmLGN9S3VQR3BOaFpMdkY=",
  "base64",
).toString("utf8");
const DECODED_CHARSET = Buffer.from(
  "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY3ODksW117fTo=",
  "base64",
).toString("utf8");

function decodeMalaString(input) {
  return input
    .split("")
    .map((character) => {
      const index = ENCODED_CHARSET.indexOf(character);
      return index >= 0 ? DECODED_CHARSET[index] : character;
    })
    .join("");
}

function decodeMalaPayload(raw) {
  const content = normalizeString(raw);
  if (!content) {
    throw new Error("Mala-Pro upstream returned an empty response body.");
  }

  let decoded = Buffer.from(content, "base64").toString("utf8");
  for (let index = 0; index < 10; index += 1) {
    decoded = decodeMalaString(decoded);
  }

  try {
    return JSON.parse(decoded);
  } catch (error) {
    throw new Error("Mala-Pro upstream returned an invalid encoded payload.");
  }
}

function normalizeMalaResponse(payload, response) {
  const body = payload && typeof payload === "object" ? payload : {};
  const message = normalizeString(body.message || body.error || response.statusText);
  const explicitSuccess =
    body.status === "success"
    || body.success === true
    || body.code === 200
    || body.code === 0;
  const explicitFailure =
    body.status === "error"
    || body.success === false
    || (typeof body.code === "number" && ![0, 200].includes(body.code));

  return {
    success: explicitSuccess || (response.ok && !explicitFailure),
    message,
    data: body.data ?? body.payload ?? body.result ?? null,
    raw: body,
  };
}

function buildMalaHeaders(officialSiteUrl, extraHeaders = {}) {
  return buildBrowserHeaders(officialSiteUrl, {
    "theme-ua": THEME_HEADER_VALUE,
    ...extraHeaders,
  });
}

async function requestMalaApi(config, endpoint, options = {}) {
  ensureProxyConfigured();

  const url = buildUrl(config.apiBase, endpoint, config.apiBase);
  const headers = buildMalaHeaders(config.officialSiteUrl, options.headers);
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const raw = await response.text();
  const payload = normalizeMalaResponse(decodeMalaPayload(raw), response);
  if (!payload.success) {
    throw new Error(payload.message || `Mala-Pro request failed with status ${response.status}.`);
  }

  return payload;
}

async function fetchMalaGuestConfig(config) {
  const payload = await requestMalaApi(config, "/guest/comm/config");
  return payload.data || {};
}

function assertMalaAutoRegisterSupported(config, guestConfig) {
  if (guestConfig?.is_email_verify) {
    throw new Error(`${config.label} 当前要求邮箱验证码，未接入邮箱收信能力前无法自动注册。`);
  }

  if (guestConfig?.is_recaptcha) {
    throw new Error(`${config.label} 当前要求验证码校验，未接入验证码求解前无法自动注册。`);
  }
}

async function registerMalaAccount(options = {}) {
  const config = {
    label: normalizeString(options.label) || "Mala-Pro upstream",
    entryUrl: normalizeUrlBase(options.entryUrl, options.officialSiteUrl),
    officialSiteUrl: normalizeUrlBase(options.officialSiteUrl, options.entryUrl),
    apiBase: normalizeUrlBase(options.apiBase, options.apiBase),
    upstreamSource: normalizeString(options.upstreamSource),
  };
  const guestConfig = await fetchMalaGuestConfig(config);
  assertMalaAutoRegisterSupported(config, guestConfig);

  const email = normalizeString(options.email)
    || generateRandomEmail({
      prefix: options.emailPrefix || config.upstreamSource || "mala",
      whitelist: Array.isArray(guestConfig.email_whitelist_suffix) ? guestConfig.email_whitelist_suffix : [],
      defaultDomain: "gmail.com",
    });
  const password = normalizeString(options.password) || generateRandomPassword();
  const inviteCode = normalizeString(options.inviteCode);

  const registerForm = new FormData();
  registerForm.append("email", email);
  registerForm.append("password", password);
  if (inviteCode) {
    registerForm.append("invite_code", inviteCode);
  }

  const registerPayload = await requestMalaApi(config, "/passport/auth/register", {
    method: "POST",
    body: registerForm,
  });

  let authToken = normalizeString(registerPayload?.data?.auth_data || registerPayload?.data?.token);
  if (!authToken) {
    const loginForm = new FormData();
    loginForm.append("email", email);
    loginForm.append("password", password);
    const loginPayload = await requestMalaApi(config, "/passport/auth/login", {
      method: "POST",
      body: loginForm,
    });
    authToken = normalizeString(loginPayload?.data?.auth_data || loginPayload?.data?.token);
  }

  if (!authToken) {
    throw new Error(`${config.label} 未返回授权令牌。`);
  }

  const subscribePayload = await requestMalaApi(config, "/user/getSubscribe", {
    headers: {
      Authorization: authToken,
    },
  });
  const subscribeData = subscribePayload.data || {};
  const subscribeUrl = normalizeString(subscribeData.subscribe_url);
  if (!subscribeUrl) {
    throw new Error(`${config.label} 未返回订阅地址。`);
  }

  return {
    email,
    password,
    inviteCode,
    token: authToken,
    subscribeUrl,
    clientUrls: buildClientUrls(subscribeUrl),
    accountCreatedAt: toIsoDate(subscribeData.created_at),
    expiredAt: toIsoDate(subscribeData.expired_at),
    upstreamSite: config.officialSiteUrl,
    apiBase: config.apiBase,
    entryUrl: config.entryUrl,
    upstreamSource: config.upstreamSource,
  };
}

async function queryMalaAccount(options = {}) {
  const config = {
    label: normalizeString(options.label) || "Mala-Pro upstream",
    entryUrl: normalizeUrlBase(options.entryUrl, options.officialSiteUrl),
    officialSiteUrl: normalizeUrlBase(options.officialSiteUrl, options.entryUrl),
    apiBase: normalizeUrlBase(options.apiBase, options.apiBase),
    upstreamSource: normalizeString(options.upstreamSource),
  };
  const authToken = normalizeString(options.token);
  if (!authToken) {
    throw new Error(`Missing ${config.label} auth token.`);
  }

  const headers = {
    Authorization: authToken,
  };
  const [subscribePayload, infoPayload, trafficPayload] = await Promise.all([
    requestMalaApi(config, "/user/getSubscribe", { headers }),
    requestMalaApi(config, "/user/info", { headers }),
    requestMalaApi(config, "/user/stat/getTrafficLog", { headers }).catch(() => ({ data: null })),
  ]);

  const subscribeData = subscribePayload.data || {};
  const infoData = infoPayload.data || {};
  const usedUpload = Number(subscribeData.u || 0) || 0;
  const usedDownload = Number(subscribeData.d || 0) || 0;
  const transferEnable = Number(subscribeData.transfer_enable ?? infoData.transfer_enable ?? 0) || 0;
  const usedTotal = usedUpload + usedDownload;
  const remainingTraffic = Math.max(transferEnable - usedTotal, 0);
  const subscribeUrl = normalizeString(subscribeData.subscribe_url);

  return {
    queriedAt: new Date().toISOString(),
    email: normalizeString(subscribeData.email || infoData.email || options.email),
    subscribeUrl,
    clientUrls: subscribeUrl ? buildClientUrls(subscribeUrl) : {},
    planId: subscribeData.plan_id ?? infoData.plan_id ?? null,
    planName: normalizeString(subscribeData.plan?.name || infoData.plan?.name),
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
    stat: trafficPayload?.data ?? null,
    upstreamSite: config.officialSiteUrl,
    apiBase: config.apiBase,
    entryUrl: config.entryUrl,
    upstreamSource: config.upstreamSource,
  };
}

module.exports = {
  decodeMalaPayload,
  fetchMalaGuestConfig,
  queryMalaAccount,
  registerMalaAccount,
  requestMalaApi,
};
