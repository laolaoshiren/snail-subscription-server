"use strict";

process.env.NODE_TLS_REJECT_UNAUTHORIZED =
  process.env.ALLOW_INSECURE_TLS === "0" ? process.env.NODE_TLS_REJECT_UNAUTHORIZED : "0";

const { webcrypto } = require("node:crypto");

const { ensureProxyConfigured } = require("../../httpClient");
const { buildClientUrls } = require("./snailApi");
const {
  buildBrowserHeaders,
  buildUrl,
  generateRandomEmail,
  generateRandomPassword,
  normalizeString,
  normalizeUrlBase,
  parseBoolean,
  toIsoDate,
} = require("./upstreamUtils");

const cryptoApi = globalThis.crypto || webcrypto;
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10);

function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

async function deriveTopmanKey(password) {
  const encoder = new TextEncoder();
  const secret = encoder.encode(password);
  const keyMaterial = await cryptoApi.subtle.importKey(
    "raw",
    secret,
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );

  return cryptoApi.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: secret,
      iterations: 10_000,
      hash: "SHA-256",
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: 128,
    },
    true,
    ["encrypt", "decrypt"],
  );
}

async function encryptTopmanText(text, password, iv) {
  const encoder = new TextEncoder();
  const cipher = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      length: 128,
      iv,
    },
    await deriveTopmanKey(password),
    encoder.encode(text),
  );

  return bufferToBase64(new Uint8Array(cipher));
}

async function decryptTopmanText(encoded, ivBase64, password) {
  const plain = await cryptoApi.subtle.decrypt(
    {
      name: "AES-GCM",
      length: 128,
      iv: Buffer.from(ivBase64, "base64"),
    },
    await deriveTopmanKey(password),
    Buffer.from(encoded, "base64"),
  );

  return new TextDecoder().decode(plain);
}

async function buildTopmanHashedPath(pathname, password) {
  const digest = await cryptoApi.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(`${pathname}#${password}`),
  );
  return `/${Buffer.from(new Uint8Array(digest)).toString("hex")}`;
}

function normalizeTopmanResponse(payload, response) {
  const body = payload && typeof payload === "object" ? payload : {};
  const message = normalizeString(body.message || body.error || response.statusText);
  return {
    success: response.ok && (body.code === undefined || body.code === 200),
    message,
    data: body.data ?? body.payload ?? null,
    raw: body,
  };
}

async function requestTopmanApi(config, endpoint, options = {}) {
  ensureProxyConfigured();

  const method = (options.method || "GET").toUpperCase();
  const url = new URL(buildUrl(config.apiBase, endpoint, config.apiBase));
  const headers = buildBrowserHeaders(config.officialSiteUrl, options.headers);
  const securityPassword = normalizeString(config.securityPassword);
  let body = options.body;

  if (securityPassword) {
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const saltBase64 = bufferToBase64(iv);
    const query = { ...(options.query && typeof options.query === "object" ? options.query : {}) };
    url.pathname = await buildTopmanHashedPath(url.pathname, securityPassword);
    if (Object.keys(query).length > 0) {
      url.searchParams.set(
        "q",
        await encryptTopmanText(JSON.stringify(query), securityPassword, iv),
      );
    }

    if (
      body
      && method !== "GET"
      && !(body instanceof FormData)
      && !(body instanceof URLSearchParams)
      && typeof body === "object"
    ) {
      body = await encryptTopmanText(JSON.stringify(body), securityPassword, iv);
      headers["x-origin-content-type"] = headers["Content-Type"] || "application/json";
      headers["Content-Type"] = "text/plain; charset=utf-8";
    }

    headers["x-salt"] = saltBase64;
    if (config.encryptResponse !== false) {
      headers["x-encrypt-response"] = "1";
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const raw = await response.text();
  let decoded = raw;

  if (
    securityPassword
    && response.headers.get("x-encrypt-response")
    && response.headers.get("x-salt")
  ) {
    decoded = await decryptTopmanText(raw, response.headers.get("x-salt"), securityPassword);
  }

  let payload = {};
  if (decoded) {
    try {
      payload = JSON.parse(decoded);
    } catch (error) {
      throw new Error(`${config.label} 返回了无法解析的 JSON 响应。`);
    }
  }

  const normalized = normalizeTopmanResponse(payload, response);
  if (!normalized.success) {
    throw new Error(normalized.message || `${config.label} 请求失败，状态码 ${response.status}。`);
  }

  return normalized;
}

async function fetchTopmanGuestConfig(config) {
  const result = await requestTopmanApi(config, "/api/v1/guest/comm/config");
  return result.data || {};
}

async function fetchTopmanQuickCaptcha(config, type = "register") {
  const result = await requestTopmanApi(config, "/api/v1/r8d/quick/captcha", {
    query: { type },
  });
  return result.data || null;
}

async function registerTopmanAccount(options = {}) {
  const config = {
    label: normalizeString(options.label) || "拓扑门",
    entryUrl: normalizeUrlBase(options.entryUrl, options.officialSiteUrl),
    officialSiteUrl: normalizeUrlBase(options.officialSiteUrl, options.entryUrl),
    apiBase: normalizeUrlBase(options.apiBase, options.apiBase),
    securityPassword: normalizeString(options.securityPassword),
    encryptResponse: parseBoolean(options.encryptResponse, true),
    upstreamSource: normalizeString(options.upstreamSource),
  };

  const guestConfig = await fetchTopmanGuestConfig(config);
  if (guestConfig?.is_email_verify) {
    throw new Error(`${config.label} 当前要求邮箱验证码，未接入邮箱收信能力前无法自动注册。`);
  }
  if (guestConfig?.is_recaptcha) {
    throw new Error(`${config.label} 当前要求验证码校验，未接入验证码求解前无法自动注册。`);
  }

  const quickCaptcha = await fetchTopmanQuickCaptcha(config).catch(() => null);
  if (quickCaptcha?.data && normalizeString(options.captchaText) === "") {
    throw new Error(`${config.label} 当前要求站内验证码，未接入验证码求解前无法自动注册。`);
  }

  const email = normalizeString(options.email)
    || generateRandomEmail({
      prefix: options.emailPrefix || config.upstreamSource || "topman",
      whitelist: Array.isArray(guestConfig.email_whitelist_suffix) ? guestConfig.email_whitelist_suffix : [],
      defaultDomain: "gmail.com",
    });
  const password = normalizeString(options.password) || generateRandomPassword();
  const inviteCode = normalizeString(options.inviteCode);
  const registerBody = {
    email,
    password,
    ...(inviteCode ? { invite_code: inviteCode } : {}),
    ...(normalizeString(options.captchaText) ? { captcha: normalizeString(options.captchaText) } : {}),
  };
  let registerPayload;
  try {
    registerPayload = await requestTopmanApi(config, "/api/v1/passport/auth/register", {
      method: "POST",
      body: registerBody,
    });
  } catch (error) {
    if ((error?.message || "").includes("验证码")) {
      throw new Error(`${config.label} 当前要求站内验证码，未接入验证码求解前无法自动注册。`);
    }
    throw error;
  }

  let authToken = normalizeString(registerPayload?.data?.auth_data || registerPayload?.data?.token);
  if (!authToken) {
    const loginPayload = await requestTopmanApi(config, "/api/v1/passport/auth/login", {
      method: "POST",
      body: {
        email,
        password,
      },
    });
    authToken = normalizeString(loginPayload?.data?.auth_data || loginPayload?.data?.token);
  }

  if (!authToken) {
    throw new Error(`${config.label} 未返回授权令牌。`);
  }

  const authHeaders = {
    Authorization: authToken,
  };
  const [subscribePayload, infoPayload] = await Promise.all([
    requestTopmanApi(config, "/api/v1/user/getSubscribe", { headers: authHeaders }),
    requestTopmanApi(config, "/api/v1/user/info", { headers: authHeaders }),
  ]);
  const subscribeData = subscribePayload.data || {};
  const infoData = infoPayload.data || {};
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
    accountCreatedAt: toIsoDate(infoData.created_at),
    expiredAt: toIsoDate(subscribeData.expired_at ?? infoData.expired_at),
    upstreamSite: config.officialSiteUrl,
    apiBase: config.apiBase,
    entryUrl: config.entryUrl,
    upstreamSource: config.upstreamSource,
  };
}

async function queryTopmanAccount(options = {}) {
  const config = {
    label: normalizeString(options.label) || "拓扑门",
    entryUrl: normalizeUrlBase(options.entryUrl, options.officialSiteUrl),
    officialSiteUrl: normalizeUrlBase(options.officialSiteUrl, options.entryUrl),
    apiBase: normalizeUrlBase(options.apiBase, options.apiBase),
    securityPassword: normalizeString(options.securityPassword),
    encryptResponse: parseBoolean(options.encryptResponse, true),
    upstreamSource: normalizeString(options.upstreamSource),
  };
  const authToken = normalizeString(options.token);
  if (!authToken) {
    throw new Error(`Missing ${config.label} auth token.`);
  }

  const authHeaders = {
    Authorization: authToken,
  };
  const [subscribePayload, infoPayload, trafficPayload] = await Promise.all([
    requestTopmanApi(config, "/api/v1/user/getSubscribe", { headers: authHeaders }),
    requestTopmanApi(config, "/api/v1/user/info", { headers: authHeaders }),
    requestTopmanApi(config, "/api/v1/user/stat/getTrafficLog", { headers: authHeaders }).catch(() => null),
  ]);

  const subscribeData = subscribePayload?.data || {};
  const infoData = infoPayload?.data || {};
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
  fetchTopmanGuestConfig,
  fetchTopmanQuickCaptcha,
  queryTopmanAccount,
  registerTopmanAccount,
  requestTopmanApi,
};
