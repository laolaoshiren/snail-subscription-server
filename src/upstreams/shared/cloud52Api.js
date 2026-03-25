"use strict";

process.env.NODE_TLS_REJECT_UNAUTHORIZED =
  process.env.ALLOW_INSECURE_TLS === "0" ? process.env.NODE_TLS_REJECT_UNAUTHORIZED : "0";

const crypto = require("node:crypto");

const { ensureProxyConfigured } = require("../../httpClient");
const { URL_TYPES } = require("./snailApi");
const {
  buildBrowserHeaders,
  buildUrl,
  generateRandomEmail,
  generateRandomPassword,
  normalizeString,
  normalizeUrlBase,
} = require("./upstreamUtils");

const FETCH_TIMEOUT_MS = Number.parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10);
const CLOUD52_SECRET_KEY = Buffer.from("52vpn_api_secret_key_2024_v1_ok!", "utf8");
const CLOUD52_DEFAULT_ORIGIN = "https://v1.v52x.cc";

function decodeCloud52EncryptedData(encoded) {
  const payloadBuffer = Buffer.from(encoded, "base64");
  const iv = payloadBuffer.subarray(0, 16);
  const cipherText = payloadBuffer.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", CLOUD52_SECRET_KEY, iv);
  const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString("utf8");
  return JSON.parse(plainText);
}

function normalizeCloud52Payload(rawText) {
  let payload = {};

  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch (error) {
      throw new Error("52Cloud returned invalid JSON.");
    }
  }

  if (payload?.encrypted === true && typeof payload.data === "string") {
    payload = {
      ...payload,
      data: decodeCloud52EncryptedData(payload.data),
    };
  }

  return payload;
}

function getCloud52SuccessCode(payload) {
  const candidates = [
    payload?.ret,
    payload?.code,
    payload?.data?.ret,
    payload?.info?.ret,
  ];

  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function getCloud52Message(payload, response) {
  return normalizeString(
    payload?.msg
      || payload?.message
      || payload?.error
      || payload?.data?.msg
      || response.statusText,
  );
}

function normalizeCloud52Date(value) {
  const raw = normalizeString(value);
  if (!raw) {
    return "";
  }

  const direct = new Date(raw);
  if (Number.isFinite(direct.getTime())) {
    return direct.toISOString();
  }

  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const localDate = new Date(`${normalized}+08:00`);
  return Number.isFinite(localDate.getTime()) ? localDate.toISOString() : "";
}

function createCloud52DataUrl(lines) {
  const content = Array.from(new Set(lines.map((line) => normalizeString(line)).filter(Boolean))).join("\n");
  if (!content) {
    return "";
  }

  return `data:text/plain;base64,${Buffer.from(content, "utf8").toString("base64")}`;
}

function buildCloud52ClientUrls(subscriptionDataUrl) {
  const clientUrls = {};
  Object.keys(URL_TYPES).forEach((type) => {
    clientUrls[type] = subscriptionDataUrl;
  });
  return clientUrls;
}

function getCloud52RequestHeaders(config, token = "") {
  const headers = buildBrowserHeaders(config.officialSiteUrl || CLOUD52_DEFAULT_ORIGIN, {
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
  });

  if (token) {
    headers.Authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  }

  return headers;
}

async function requestCloud52Api(config, endpoint, options = {}) {
  ensureProxyConfigured();

  const url = buildUrl(config.apiBase, endpoint, config.apiBase);
  const headers = {
    ...getCloud52RequestHeaders(config, options.token || ""),
    ...(options.headers && typeof options.headers === "object" ? options.headers : {}),
  };
  let body = options.body;

  if (
    body
    && !(body instanceof FormData)
    && !(body instanceof URLSearchParams)
    && typeof body === "object"
  ) {
    const formData = new URLSearchParams();
    Object.entries(body).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        formData.append(key, `${value}`);
      }
    });
    body = formData.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const rawText = await response.text();
  const payload = normalizeCloud52Payload(rawText);
  const successCode = getCloud52SuccessCode(payload);
  const success = response.ok && (successCode === null || successCode === 1 || successCode === 200);

  if (!success) {
    throw new Error(getCloud52Message(payload, response) || `${config.label} request failed.`);
  }

  return {
    payload,
    nextToken: normalizeString(response.headers.get("x-new-token") || payload.token || payload?.data?.token),
  };
}

async function fetchCloud52GuestConfig(config) {
  const [authConfig, globalConfig] = await Promise.all([
    requestCloud52Api(config, "/auth/config").then((result) => result.payload).catch(() => null),
    requestCloud52Api(config, "/globalconfig").then((result) => result.payload).catch(() => null),
  ]);

  return {
    authConfig,
    globalConfig,
  };
}

function extractCloud52RegisterConfig(guestConfig) {
  const authConfig = guestConfig?.authConfig?.data?.data || {};
  const globalConfig = guestConfig?.globalConfig?.data?.globalConfig || {};
  return {
    captchaProvider: normalizeString(authConfig.captcha_provider || globalConfig.captcha_provider),
    enableRegCaptcha: Boolean(
      authConfig.enable_reg_captcha
        ?? authConfig.enableRegCaptcha
        ?? globalConfig.enable_regcaptcha
        ?? globalConfig.enableRegCaptcha,
    ),
    enableEmailVerify: Boolean(
      authConfig.enable_email_verify
        ?? authConfig.enableEmailVerify
        ?? globalConfig.enable_email_verify
        ?? globalConfig.enableEmailVerify,
    ),
    emailWhitelist: Array.isArray(authConfig.register_email_white_list)
      ? authConfig.register_email_white_list
      : [],
  };
}

function extractCloud52UserInfo(payload) {
  return payload?.info || payload?.data?.info || payload?.data?.userInfo?.user || {};
}

function extractCloud52User(payload) {
  const info = extractCloud52UserInfo(payload);
  return info?.user || info;
}

function extractCloud52NodeList(payload) {
  const fromNodeInfo = payload?.data?.nodeinfo?.nodes;
  if (Array.isArray(fromNodeInfo)) {
    return fromNodeInfo;
  }

  const fromAllNode = payload?.data?.allNode;
  if (Array.isArray(fromAllNode)) {
    return fromAllNode;
  }

  return [];
}

function getCloud52NodeClass(node) {
  const candidates = [
    node?.class,
    node?.nodeClass,
    node?.node_class,
    node?.raw_node?.node_class,
  ];

  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function getCloud52UserClass(user) {
  const parsed = Number(user?.class);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getCloud52NodeRelayRule(node) {
  const candidates = [
    node?.relay_rule,
    node?.group,
    node?.node_group,
    node?.raw_node?.node_group,
  ];

  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function getCloud52NodeMuOnly(node) {
  const parsed = Number(node?.mu_only ?? node?.raw_node?.mu_only ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function resolveCloud52NodeUrls(config, token, userClass = 0) {
  const nodesPayload = await requestCloud52Api(config, "/api/vue/nodes", { token });
  const nodes = extractCloud52NodeList(nodesPayload.payload)
    .filter((node) => getCloud52NodeClass(node) <= userClass)
    .sort((left, right) => {
      const leftClass = getCloud52NodeClass(left);
      const rightClass = getCloud52NodeClass(right);
      if (leftClass !== rightClass) {
        return leftClass - rightClass;
      }

      const leftId = Number(left?.id) || 0;
      const rightId = Number(right?.id) || 0;
      return leftId - rightId;
    });

  const nodeUrls = [];
  for (const node of nodes) {
    try {
      const detail = await requestCloud52Api(
        config,
        `/nodeinfo/${node.id}?ismu=${getCloud52NodeMuOnly(node)}&relay_rule=${getCloud52NodeRelayRule(node)}`,
        { token },
      );
      const nodeUrl = normalizeString(detail.payload?.nodeInfo?.nodeUrl || detail.payload?.data?.nodeInfo?.nodeUrl);
      if (nodeUrl) {
        nodeUrls.push(nodeUrl);
      }
    } catch (error) {
      // Ignore inaccessible nodes and keep collecting nodes that actually resolve to URLs.
    }
  }

  return Array.from(new Set(nodeUrls));
}

function buildCloud52PlanName(user) {
  const userClass = getCloud52UserClass(user);
  return Number.isFinite(userClass) ? `Class ${userClass}` : "";
}

async function registerCloud52Account(options = {}) {
  const config = {
    label: normalizeString(options.label) || "52Cloud",
    entryUrl: normalizeUrlBase(options.entryUrl, options.officialSiteUrl),
    officialSiteUrl: normalizeUrlBase(options.officialSiteUrl, options.entryUrl) || CLOUD52_DEFAULT_ORIGIN,
    apiBase: normalizeUrlBase(options.apiBase, options.apiBase),
    upstreamSource: normalizeString(options.upstreamSource),
  };

  const guestConfig = await fetchCloud52GuestConfig(config).catch(() => null);
  const registerConfig = extractCloud52RegisterConfig(guestConfig);
  if (registerConfig.enableEmailVerify) {
    throw new Error(`${config.label} 当前要求邮箱验证码，暂时无法自动注册。`);
  }
  if (registerConfig.enableRegCaptcha) {
    const provider = registerConfig.captchaProvider || "captcha";
    throw new Error(`${config.label} 当前启用了 ${provider} 注册验证，暂时无法自动注册。`);
  }

  const email = normalizeString(options.email)
    || generateRandomEmail({
      prefix: options.emailPrefix || config.upstreamSource || "cloud52",
      whitelist: registerConfig.emailWhitelist,
      defaultDomain: "gmail.com",
    });
  const password = normalizeString(options.password) || generateRandomPassword();
  const inviteCode = normalizeString(options.inviteCode);

  let registerResult;
  try {
    registerResult = await requestCloud52Api(config, "/auth/register", {
      method: "POST",
      body: {
        email,
        passwd: password,
        repasswd: password,
        ...(inviteCode ? { code: inviteCode } : {}),
      },
    });
  } catch (error) {
    throw new Error(`${config.label} 注册失败：${error.message}`);
  }

  let authToken = normalizeString(registerResult.nextToken || registerResult.payload?.token);
  if (!authToken) {
    const loginResult = await requestCloud52Api(config, "/auth/login", {
      method: "POST",
      body: {
        email,
        passwd: password,
      },
    });
    authToken = normalizeString(loginResult.nextToken || loginResult.payload?.token);
  }

  if (!authToken) {
    throw new Error(`${config.label} did not return an auth token.`);
  }

  const userInfoResult = await requestCloud52Api(config, "/getuserinfo", {
    token: authToken,
  });
  const userInfoPayload = userInfoResult.payload;
  const user = extractCloud52User(userInfoPayload);
  const nodeUrls = await resolveCloud52NodeUrls(config, authToken, getCloud52UserClass(user));
  if (nodeUrls.length === 0) {
    throw new Error(`${config.label} 注册成功，但没有拿到可用节点。`);
  }

  const subscriptionDataUrl = createCloud52DataUrl(nodeUrls);
  const clientUrls = buildCloud52ClientUrls(subscriptionDataUrl);

  return {
    email,
    password,
    inviteCode,
    token: authToken,
    subscribeUrl: subscriptionDataUrl,
    clientUrls,
    accountCreatedAt: normalizeCloud52Date(user?.reg_date),
    expiredAt: normalizeCloud52Date(user?.expire_in || user?.class_expire),
    upstreamSite: config.officialSiteUrl,
    apiBase: config.apiBase,
    entryUrl: config.entryUrl,
    upstreamSource: config.upstreamSource,
  };
}

async function queryCloud52Account(options = {}) {
  const config = {
    label: normalizeString(options.label) || "52Cloud",
    entryUrl: normalizeUrlBase(options.entryUrl, options.officialSiteUrl),
    officialSiteUrl: normalizeUrlBase(options.officialSiteUrl, options.entryUrl) || CLOUD52_DEFAULT_ORIGIN,
    apiBase: normalizeUrlBase(options.apiBase, options.apiBase),
    upstreamSource: normalizeString(options.upstreamSource),
  };
  const authToken = normalizeString(options.token);
  if (!authToken) {
    throw new Error(`Missing ${config.label} auth token.`);
  }

  const [userInfoResult, transferResult] = await Promise.all([
    requestCloud52Api(config, "/getuserinfo", { token: authToken }),
    requestCloud52Api(config, "/gettransfer", { token: authToken }).catch(() => null),
  ]);

  const userInfoPayload = userInfoResult.payload;
  const user = extractCloud52User(userInfoPayload);
  const nodeUrls = await resolveCloud52NodeUrls(config, authToken, getCloud52UserClass(user));
  if (nodeUrls.length === 0) {
    throw new Error(`${config.label} 当前账号没有可用节点。`);
  }

  const subscriptionDataUrl = createCloud52DataUrl(nodeUrls);
  const clientUrls = buildCloud52ClientUrls(subscriptionDataUrl);
  const usedUpload = Number(user?.u || 0) || 0;
  const usedDownload = Number(user?.d || 0) || 0;
  const usedTotal = usedUpload + usedDownload;
  const transferEnable = Number(user?.transfer_enable || 0) || 0;
  const remainingTraffic = transferEnable > 0 ? Math.max(transferEnable - usedTotal, 0) : 0;
  const remainingPercent =
    transferEnable > 0 ? Number(((remainingTraffic / transferEnable) * 100).toFixed(2)) : 100;
  const usagePercent =
    transferEnable > 0 ? Number(((usedTotal / transferEnable) * 100).toFixed(2)) : 0;

  return {
    queriedAt: new Date().toISOString(),
    email: normalizeString(user?.email || options.email),
    subscribeUrl: subscriptionDataUrl,
    clientUrls,
    planId: getCloud52UserClass(user),
    planName: buildCloud52PlanName(user),
    expiredAt: normalizeCloud52Date(user?.expire_in || user?.class_expire),
    accountCreatedAt: normalizeCloud52Date(user?.reg_date),
    transferEnable,
    usedUpload,
    usedDownload,
    usedTotal,
    remainingTraffic,
    remainingPercent,
    usagePercent,
    stat: transferResult?.payload?.data?.arr || transferResult?.payload?.arr || null,
    upstreamSite: config.officialSiteUrl,
    apiBase: config.apiBase,
    entryUrl: config.entryUrl,
    upstreamSource: config.upstreamSource,
  };
}

module.exports = {
  extractCloud52RegisterConfig,
  fetchCloud52GuestConfig,
  queryCloud52Account,
  registerCloud52Account,
  requestCloud52Api,
};
