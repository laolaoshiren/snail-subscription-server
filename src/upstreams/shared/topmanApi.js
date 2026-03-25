"use strict";

process.env.NODE_TLS_REJECT_UNAUTHORIZED =
  process.env.ALLOW_INSECURE_TLS === "0" ? process.env.NODE_TLS_REJECT_UNAUTHORIZED : "0";

const { webcrypto } = require("node:crypto");

const { ensureProxyConfigured } = require("../../httpClient");
const { buildClientUrls } = require("./snailApi");
const { buildNumericCaptchaCandidatesFromDataUrl } = require("./numericCaptchaSolver");
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
const TOPMAN_CAPTCHA_MAX_ATTEMPTS = Number.parseInt(
  process.env.TOPMAN_CAPTCHA_MAX_ATTEMPTS || "6",
  10,
);
const TOPMAN_CAPTCHA_TYPE = "register";

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
  const code = Number(body.code);
  const explicitSuccess = Number.isFinite(code) ? code === 200 : true;

  return {
    success: response.ok && explicitSuccess,
    message,
    data: body.data ?? body.payload ?? null,
    raw: body,
  };
}

function normalizeTopmanCaptchaImage(captchaPayload) {
  if (typeof captchaPayload === "string") {
    return normalizeString(captchaPayload);
  }

  if (!captchaPayload || typeof captchaPayload !== "object") {
    return "";
  }

  return normalizeString(
    captchaPayload.data
      || captchaPayload.image
      || captchaPayload.captcha
      || captchaPayload.base64,
  );
}

function normalizeTopmanCaptchaPayload(captchaPayload, type = TOPMAN_CAPTCHA_TYPE) {
  if (typeof captchaPayload === "string") {
    return {
      data: normalizeString(captchaPayload),
      type,
      timestamp: null,
      hash: "",
    };
  }

  if (!captchaPayload || typeof captchaPayload !== "object") {
    return {
      data: "",
      type,
      timestamp: null,
      hash: "",
    };
  }

  return {
    data: normalizeTopmanCaptchaImage(captchaPayload),
    type: normalizeString(captchaPayload.type) || type,
    timestamp: Number(captchaPayload.timestamp ?? captchaPayload.ts ?? 0) || null,
    hash: normalizeString(captchaPayload.hash || captchaPayload.sign || captchaPayload.signature),
  };
}

function buildTopmanCaptchaChallenge(captchaPayload, code) {
  const normalizedCode = normalizeString(code);
  if (!normalizedCode) {
    return null;
  }

  return {
    code: normalizedCode,
    type: captchaPayload.type || TOPMAN_CAPTCHA_TYPE,
    ...(captchaPayload.timestamp ? { timestamp: captchaPayload.timestamp } : {}),
    ...(captchaPayload.hash ? { hash: captchaPayload.hash } : {}),
  };
}

function isTopmanCaptchaErrorMessage(message) {
  const normalized = normalizeString(message).toLowerCase();
  return normalized.includes("captcha")
    || normalized.includes("验证码")
    || normalized.includes("缺少验证码")
    || normalized.includes("verify");
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
      throw new Error(`${config.label} returned invalid JSON.`);
    }
  }

  const normalized = normalizeTopmanResponse(payload, response);
  if (!normalized.success) {
    throw new Error(normalized.message || `${config.label} request failed with status ${response.status}.`);
  }

  return normalized;
}

async function fetchTopmanGuestConfig(config) {
  const result = await requestTopmanApi(config, "/api/v1/guest/comm/config");
  return result.data || {};
}

async function fetchTopmanQuickCaptcha(config, type = TOPMAN_CAPTCHA_TYPE) {
  const result = await requestTopmanApi(config, "/api/v1/r8d/quick/captcha", {
    query: { type },
  });
  return normalizeTopmanCaptchaPayload(result.raw, type);
}

async function resolveTopmanCaptchaChallenges(config, explicitCaptchaText = "") {
  const normalizedCaptchaText = normalizeString(explicitCaptchaText);
  const quickCaptcha = await fetchTopmanQuickCaptcha(config).catch(() => null);
  const captchaPayload = normalizeTopmanCaptchaPayload(quickCaptcha);
  const candidateCodes = [];

  if (normalizedCaptchaText) {
    candidateCodes.push(normalizedCaptchaText);
  } else if (captchaPayload.data) {
    const solved = await buildNumericCaptchaCandidatesFromDataUrl(captchaPayload.data).catch(() => null);
    if (Array.isArray(solved?.candidates) && solved.candidates.length > 0) {
      candidateCodes.push(...solved.candidates);
    } else if (solved?.primary) {
      candidateCodes.push(solved.primary);
    }
  }

  return Array.from(new Set(candidateCodes
    .map((candidate) => normalizeString(candidate))
    .filter(Boolean)))
    .map((candidate) => buildTopmanCaptchaChallenge(captchaPayload, candidate))
    .filter(Boolean);
}

async function performTopmanRegister(config, payload) {
  return requestTopmanApi(config, "/api/v1/passport/auth/register", {
    method: "POST",
    body: payload,
  });
}

async function loginTopmanAccount(config, email, password) {
  const loginPayload = await requestTopmanApi(config, "/api/v1/passport/auth/login", {
    method: "POST",
    body: {
      email,
      password,
    },
  });

  return normalizeString(loginPayload?.data?.auth_data || loginPayload?.data?.token);
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
    throw new Error(`${config.label} 当前要求邮箱验证码，暂时无法自动注册。`);
  }
  if (guestConfig?.is_recaptcha) {
    throw new Error(`${config.label} 当前要求 reCAPTCHA，暂时无法自动注册。`);
  }

  const email = normalizeString(options.email)
    || generateRandomEmail({
      prefix: options.emailPrefix || config.upstreamSource || "topman",
      whitelist: Array.isArray(guestConfig.email_whitelist_suffix) ? guestConfig.email_whitelist_suffix : [],
      defaultDomain: "gmail.com",
    });
  const password = normalizeString(options.password) || generateRandomPassword();
  const inviteCode = normalizeString(options.inviteCode);
  const explicitCaptchaText = normalizeString(options.captchaText);

  let registerPayload = null;
  let rounds = 0;
  let lastCaptchaError = null;

  while (!registerPayload && rounds < (explicitCaptchaText ? 1 : TOPMAN_CAPTCHA_MAX_ATTEMPTS)) {
    const challenges = (await resolveTopmanCaptchaChallenges(config, explicitCaptchaText)).slice(0, 36);
    rounds += 1;
    if (challenges.length === 0) {
      break;
    }

    for (const captchaChallenge of challenges) {
      try {
        registerPayload = await performTopmanRegister(config, {
          email,
          email_code: "",
          password,
          ...(inviteCode ? { invite_code: inviteCode } : {}),
          captcha: captchaChallenge,
        });
        break;
      } catch (error) {
        if (!isTopmanCaptchaErrorMessage(error?.message || "")) {
          throw error;
        }

        lastCaptchaError = error;
        if (explicitCaptchaText) {
          throw new Error(`${config.label} 验证码不正确。`);
        }
      }
    }

    if (explicitCaptchaText) {
      break;
    }
  }

  if (!registerPayload) {
    throw new Error(
      lastCaptchaError?.message
        ? `${config.label} 验证码多次重试后仍然失败：${lastCaptchaError.message}`
        : `${config.label} 未能完成注册。`,
    );
  }

  let authToken = normalizeString(registerPayload?.data?.auth_data || registerPayload?.data?.token);
  if (!authToken) {
    authToken = await loginTopmanAccount(config, email, password);
  }
  if (!authToken) {
    throw new Error(`${config.label} did not return an auth token.`);
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
    throw new Error(`${config.label} did not return a subscription URL.`);
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
