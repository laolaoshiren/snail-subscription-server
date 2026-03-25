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

function normalizeApiResponse(payload, response) {
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

async function requestStandardV2Api(config, endpoint, options = {}) {
  ensureProxyConfigured();

  const url = buildUrl(config.apiBase, endpoint, config.apiBase);
  const headers = buildBrowserHeaders(config.officialSiteUrl, options.headers);
  let body = options.body;

  if (
    body
    && !(body instanceof FormData)
    && !(body instanceof URLSearchParams)
    && typeof body === "object"
  ) {
    body = JSON.stringify(body);
    if (!headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const raw = await response.text();

  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${config.label} returned invalid JSON.`);
    }
  }

  const normalized = normalizeApiResponse(payload, response);
  if (!normalized.success) {
    throw new Error(normalized.message || `${config.label} request failed with status ${response.status}.`);
  }

  return normalized;
}

async function fetchStandardGuestConfig(config, options = {}) {
  const result = await requestStandardV2Api(config, "/guest/comm/config", {
    headers: options.headers,
  });
  return result.data || {};
}

function assertStandardAutoRegisterSupported(config, guestConfig) {
  if (guestConfig?.is_email_verify) {
    throw new Error(`${config.label} 当前要求邮箱验证码，暂时无法自动注册。`);
  }

  if (guestConfig?.is_recaptcha) {
    throw new Error(`${config.label} 当前要求验证码校验，暂时无法自动注册。`);
  }
}

async function registerStandardV2Account(options = {}) {
  const config = {
    label: normalizeString(options.label) || "V2 upstream",
    entryUrl: normalizeUrlBase(options.entryUrl, options.officialSiteUrl),
    officialSiteUrl: normalizeUrlBase(options.officialSiteUrl, options.entryUrl),
    apiBase: normalizeUrlBase(options.apiBase, options.apiBase),
    upstreamSource: normalizeString(options.upstreamSource),
  };
  const requestHeaders = options.requestHeaders && typeof options.requestHeaders === "object"
    ? options.requestHeaders
    : {};
  const guestConfig = await fetchStandardGuestConfig(config, {
    headers: requestHeaders,
  });

  if (typeof options.beforeRegister === "function") {
    await options.beforeRegister({ config, guestConfig });
  }

  assertStandardAutoRegisterSupported(config, guestConfig);

  const email = normalizeString(options.email)
    || generateRandomEmail({
      prefix: options.emailPrefix || config.upstreamSource || "v2",
      whitelist: Array.isArray(guestConfig.email_whitelist_suffix) ? guestConfig.email_whitelist_suffix : [],
      defaultDomain: "gmail.com",
    });
  const password = normalizeString(options.password) || generateRandomPassword();
  const inviteCode = normalizeString(options.inviteCode);

  const registerPayload = await requestStandardV2Api(config, "/passport/auth/register", {
    method: "POST",
    headers: requestHeaders,
    body: {
      email,
      password,
      ...(inviteCode ? { invite_code: inviteCode } : {}),
    },
  });

  let authToken = normalizeString(registerPayload?.data?.auth_data || registerPayload?.data?.token);
  if (!authToken) {
    const loginPayload = await requestStandardV2Api(config, "/passport/auth/login", {
      method: "POST",
      headers: requestHeaders,
      body: {
        email,
        password,
      },
    });
    authToken = normalizeString(loginPayload?.data?.auth_data || loginPayload?.data?.token);
  }

  if (!authToken) {
    throw new Error(`${config.label} did not return an auth token.`);
  }

  const authHeaders = {
    ...requestHeaders,
    Authorization: authToken,
  };
  const subscribePayload = await requestStandardV2Api(config, "/user/getSubscribe", {
    headers: authHeaders,
  });
  const subscribeData = subscribePayload.data || {};
  const subscribeUrl = normalizeString(subscribeData.subscribe_url);
  if (!subscribeUrl) {
    throw new Error(`${config.label} did not return a subscription URL.`);
  }

  const infoPayload = await requestStandardV2Api(config, "/user/info", {
    headers: authHeaders,
  });
  const infoData = infoPayload.data || {};

  return {
    email,
    password,
    inviteCode,
    token: authToken,
    subscribeUrl,
    clientUrls: buildClientUrls(subscribeUrl),
    accountCreatedAt: toIsoDate(infoData.created_at),
    expiredAt: toIsoDate(subscribeData.expired_at ?? infoData.expired_at),
    upstreamSite: config.officialSiteUrl,
    apiBase: config.apiBase,
    entryUrl: config.entryUrl,
    upstreamSource: config.upstreamSource,
  };
}

async function queryStandardV2Account(options = {}) {
  const config = {
    label: normalizeString(options.label) || "V2 upstream",
    entryUrl: normalizeUrlBase(options.entryUrl, options.officialSiteUrl),
    officialSiteUrl: normalizeUrlBase(options.officialSiteUrl, options.entryUrl),
    apiBase: normalizeUrlBase(options.apiBase, options.apiBase),
    upstreamSource: normalizeString(options.upstreamSource),
  };
  const authToken = normalizeString(options.token);
  if (!authToken) {
    throw new Error(`Missing ${config.label} auth token.`);
  }
  const requestHeaders = options.requestHeaders && typeof options.requestHeaders === "object"
    ? options.requestHeaders
    : {};
  const headers = {
    ...requestHeaders,
    Authorization: authToken,
  };

  const [subscribePayload, infoPayload, trafficPayload] = await Promise.all([
    requestStandardV2Api(config, "/user/getSubscribe", { headers }),
    requestStandardV2Api(config, "/user/info", { headers }),
    requestStandardV2Api(config, "/user/stat/getTrafficLog", { headers }).catch(() => ({ data: null })),
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
  fetchStandardGuestConfig,
  queryStandardV2Account,
  registerStandardV2Account,
  requestStandardV2Api,
};
