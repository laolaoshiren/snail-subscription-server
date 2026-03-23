"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const {
  URL_TYPES,
  ensureProxyConfigured,
  querySubscriptionStatus,
  registerAndFetchSubscribe,
} = require("../auto_register");
const {
  DEFAULT_PASSWORD,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_USER_KEY,
  RELAY_USERS,
  RUNTIME_MODES,
  getDisplayOrigin,
  getRelayToken,
  getRuntimeMode,
  listRelayUsers,
  normalizeUserKey,
  resolveRelayUserByToken,
  updatePanelSettings,
  updatePassword,
  verifyPasswordLogin,
} = require("./authStore");
const {
  appendUserHistory,
  getUserState,
  listUserStates,
  loadRelayState,
  updateUserState,
} = require("./registrationStore");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const DEFAULT_INVITE_CODE = (process.env.INVITE_CODE || process.env.DEFAULT_INVITE_CODE || "").trim();
const PUBLIC_ORIGIN = normalizeConfiguredOrigin(process.env.PUBLIC_ORIGIN || "");
const SESSION_COOKIE_NAME = "snail_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const RELAY_FETCH_TIMEOUT_MS = Number.parseInt(process.env.RELAY_FETCH_TIMEOUT_MS || "30000", 10);
const SMART_REMAINING_THRESHOLD_PERCENT = 20;
const publicDir = path.join(__dirname, "..", "public");
const sessions = new Map();
const registrationQueues = new Map();

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
    ...headers,
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function sendText(response, statusCode, text, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(`${text}\n`);
}

async function serveStaticFile(response, fileName, contentType) {
  const filePath = path.join(publicDir, fileName);
  const content = await fs.readFile(filePath);
  response.writeHead(200, { "Content-Type": contentType });
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

function sanitizeRegistration(record) {
  if (!record) {
    return null;
  }

  return {
    email: record.email || "",
    password: record.password || "",
    inviteCode: record.inviteCode || "",
    createdAt: record.createdAt || "",
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

function shapeRegistrationResponse(user, userState, type, relayUrls, runtimeMode, warning = "") {
  const subscriptionUrl = type === "full" ? relayUrls.universal : relayUrls[type];

  return {
    user: {
      key: user.key,
      label: user.label,
    },
    runtimeMode,
    trafficThresholdPercent: SMART_REMAINING_THRESHOLD_PERCENT,
    type,
    subscriptionUrl,
    relayUrls,
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

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("Request body must be valid JSON.");
  }
}

function enqueueRegistration(userKey, job) {
  const currentQueue = registrationQueues.get(userKey) || Promise.resolve();
  const nextJob = currentQueue.then(job, job);
  registrationQueues.set(userKey, nextJob.catch(() => undefined));
  return nextJob;
}

function resolveInviteCode(inviteCode, record) {
  return (inviteCode || record?.inviteCode || DEFAULT_INVITE_CODE || "").toString().trim();
}

function mergeRegistrationWithUsage(record, usage) {
  if (!record) {
    return null;
  }

  const nextRecord = {
    ...record,
    email: usage?.email || record.email,
    subscribeUrl: usage?.subscribeUrl || record.subscribeUrl,
    clientUrls:
      usage?.clientUrls && Object.keys(usage.clientUrls).length > 0
        ? usage.clientUrls
        : record.clientUrls,
    upstreamSite: usage?.upstreamSite || record.upstreamSite,
    apiBase: usage?.apiBase || record.apiBase,
    entryUrl: usage?.entryUrl || record.entryUrl,
    detectorConfigUrl: usage?.detectorConfigUrl || record.detectorConfigUrl,
    upstreamSource: usage?.upstreamSource || record.upstreamSource,
    lastUsageCheckAt: usage?.queriedAt || record.lastUsageCheckAt || "",
  };

  return nextRecord;
}

async function createRegistration(userKey, inviteCode, context = {}) {
  const result = await registerAndFetchSubscribe({
    inviteCode,
    verbose: false,
    logger: console,
  });

  await updateUserState(userKey, async (userState) => {
    userState.latestRegistration = result;
    userState.latestUsage = null;
    userState.history = [
      {
        action: "register",
        title: context.title || "已注册新的上游账号",
        message: context.message || "服务端已创建新的上游订阅账号。",
        mode: context.mode || "",
        decision: context.decision || "register",
        relayType: context.relayType || "",
        requestSource: context.requestSource || "",
        registration: result,
        details: context.details || null,
      },
      ...(Array.isArray(userState.history) ? userState.history : []),
    ];
  });

  return result;
}

async function saveUsageSnapshot(userKey, record, usage, context = {}) {
  const mergedRecord = mergeRegistrationWithUsage(record, usage);

  await updateUserState(userKey, async (userState) => {
    userState.latestRegistration = mergedRecord;
    userState.latestUsage = usage;
    userState.history = [
      {
        action: "usage_check",
        title: context.title || "已查询上游流量状态",
        message: context.message || "服务端已刷新当前上游账号的流量和到期信息。",
        mode: context.mode || "",
        decision: context.decision || "",
        relayType: context.relayType || "",
        requestSource: context.requestSource || "",
        usage,
        registration: mergedRecord,
        details: context.details || null,
      },
      ...(Array.isArray(userState.history) ? userState.history : []),
    ];
  });

  return {
    latestRegistration: mergedRecord,
    latestUsage: usage,
  };
}

async function queryCurrentUsage(record) {
  if (!record || record.mock) {
    return null;
  }

  return querySubscriptionStatus({
    token: record.token,
    apiBase: record.apiBase,
    upstreamSite: record.upstreamSite,
    entryUrl: record.entryUrl,
    detectorConfigUrl: record.detectorConfigUrl,
    upstreamSource: record.upstreamSource,
    verbose: false,
    logger: console,
  });
}

async function resolveViewState(userKey, runtimeMode) {
  const currentState = await getUserState(userKey);

  if (runtimeMode !== RUNTIME_MODES.SMART_USAGE) {
    return {
      userState: currentState,
      warning: "",
    };
  }

  if (!currentState.latestRegistration) {
    const inviteCode = resolveInviteCode("", currentState.latestRegistration);
    await enqueueRegistration(userKey, async () =>
      createRegistration(userKey, inviteCode, {
        mode: runtimeMode,
        requestSource: "view",
        title: "查看时已初始化用户",
        message: "管理页查看该用户时发现没有可用记录，已自动注册新的上游账号。",
        decision: "register",
      }),
    );

    return {
      userState: await getUserState(userKey),
      warning: "",
    };
  }

  try {
    const usage = await queryCurrentUsage(currentState.latestRegistration);
    if (!usage) {
      return {
        userState: currentState,
        warning: "",
      };
    }

    await saveUsageSnapshot(userKey, currentState.latestRegistration, usage, {
      mode: runtimeMode,
      requestSource: "view",
      title: "查看时已刷新上游流量状态",
      message: "管理页查看请求触发了一次上游状态查询。",
      decision:
        usage.remainingPercent < SMART_REMAINING_THRESHOLD_PERCENT ? "low-traffic" : "reuse",
      details: {
        thresholdPercent: SMART_REMAINING_THRESHOLD_PERCENT,
      },
    });

    return {
      userState: await getUserState(userKey),
      warning: "",
    };
  } catch (error) {
    await appendUserHistory(userKey, {
      action: "usage_check_failed",
      title: "查看时查询上游失败",
      message: error.message,
      mode: runtimeMode,
      requestSource: "view",
      registration: currentState.latestRegistration,
    });

    return {
      userState: await getUserState(userKey),
      warning: `上游查询失败，已返回本地缓存：${error.message}`,
    };
  }
}

async function resolveRelayState(userKey, type) {
  return enqueueRegistration(userKey, async () => {
    const runtimeMode = await getRuntimeMode();
    const initialState = await getUserState(userKey);
    const inviteCode = resolveInviteCode("", initialState.latestRegistration);

    if (runtimeMode === RUNTIME_MODES.ALWAYS_REFRESH) {
      const registration = await createRegistration(userKey, inviteCode, {
        mode: runtimeMode,
        requestSource: "relay",
        relayType: type,
        title: "兼容模式已重新注册",
        message: "客户端拉取订阅时按兼容模式重新注册上游账号。",
        decision: "register",
      });

      return {
        runtimeMode,
        userState: {
          ...(await getUserState(userKey)),
          latestRegistration: registration,
        },
      };
    }

    if (!initialState.latestRegistration) {
      const registration = await createRegistration(userKey, inviteCode, {
        mode: runtimeMode,
        requestSource: "relay",
        relayType: type,
        title: "无可用记录，已注册新账号",
        message: "客户端首次拉取该用户订阅，已自动注册新的上游账号。",
        decision: "register",
      });

      return {
        runtimeMode,
        userState: {
          ...(await getUserState(userKey)),
          latestRegistration: registration,
        },
      };
    }

    let usage = null;

    try {
      usage = await queryCurrentUsage(initialState.latestRegistration);
    } catch (error) {
      await appendUserHistory(userKey, {
        action: "usage_check_failed",
        title: "客户端拉取前查询上游失败",
        message: error.message,
        mode: runtimeMode,
        requestSource: "relay",
        relayType: type,
        registration: initialState.latestRegistration,
      });
    }

    if (!usage) {
      const registration = await createRegistration(userKey, inviteCode, {
        mode: runtimeMode,
        requestSource: "relay",
        relayType: type,
        title: "查询失败，已重新注册",
        message: "当前上游账号查询失败，服务端已回退为重新注册。",
        decision: "register",
      });

      return {
        runtimeMode,
        userState: {
          ...(await getUserState(userKey)),
          latestRegistration: registration,
        },
      };
    }

    await saveUsageSnapshot(userKey, initialState.latestRegistration, usage, {
      mode: runtimeMode,
      requestSource: "relay",
      relayType: type,
      title: "客户端拉取前已查询流量",
      message: "服务端已先查询当前上游账号的剩余流量。",
      decision:
        usage.remainingPercent < SMART_REMAINING_THRESHOLD_PERCENT ? "low-traffic" : "reuse",
      details: {
        thresholdPercent: SMART_REMAINING_THRESHOLD_PERCENT,
      },
    });

    if (usage.remainingPercent < SMART_REMAINING_THRESHOLD_PERCENT) {
      const registration = await createRegistration(userKey, inviteCode, {
        mode: runtimeMode,
        requestSource: "relay",
        relayType: type,
        title: "剩余流量不足，已重新注册",
        message: `检测到剩余流量低于 ${SMART_REMAINING_THRESHOLD_PERCENT}% ，已更换新的上游账号。`,
        decision: "register",
        details: {
          remainingPercent: usage.remainingPercent,
          thresholdPercent: SMART_REMAINING_THRESHOLD_PERCENT,
        },
      });

      return {
        runtimeMode,
        userState: {
          ...(await getUserState(userKey)),
          latestRegistration: registration,
        },
      };
    }

    await appendUserHistory(userKey, {
      action: "reuse_registration",
      title: "剩余流量充足，继续复用",
      message: `当前剩余流量 ${usage.remainingPercent}% ，继续返回现有上游订阅内容。`,
      mode: runtimeMode,
      decision: "reuse",
      relayType: type,
      requestSource: "relay",
      usage,
      registration: mergeRegistrationWithUsage(initialState.latestRegistration, usage),
      details: {
        thresholdPercent: SMART_REMAINING_THRESHOLD_PERCENT,
      },
    });

    return {
      runtimeMode,
      userState: await getUserState(userKey),
    };
  });
}

async function fetchUpstreamSubscription(upstreamUrl) {
  ensureProxyConfigured();

  return fetch(upstreamUrl, {
    signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS),
  });
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

  if (!session) {
    sendJson(response, 200, {
      success: true,
      authenticated: false,
      defaultPassword: DEFAULT_PASSWORD,
    });
    return;
  }

  const origin = await getRequestOrigin(request);
  const runtimeMode = await getRuntimeMode();
  const displayOrigin = await getDisplayOrigin();
  const relayUsers = await listRelayUsers();
  const userStates = await listUserStates();
  const stateByUser = Object.fromEntries(userStates.map((item) => [item.userKey, item]));
  const relayUrlsByUser = await buildRelayUrlsByUser(origin);
  const userSummaries = relayUsers.map((user) =>
    buildUserSummary(user, stateByUser[user.key] || { latestRegistration: null, latestUsage: null, history: [], updatedAt: null }),
  );

  sendJson(response, 200, {
    success: true,
    authenticated: true,
    defaultPassword: DEFAULT_PASSWORD,
    runtimeMode,
    displayOrigin,
    runtimeModes: {
      alwaysRefresh: RUNTIME_MODES.ALWAYS_REFRESH,
      smartUsage: RUNTIME_MODES.SMART_USAGE,
    },
    trafficThresholdPercent: SMART_REMAINING_THRESHOLD_PERCENT,
    users: relayUsers.map((user) => ({
      key: user.key,
      label: user.label,
    })),
    relayUrlsByUser,
    userSummaries,
    defaultUserKey: DEFAULT_USER_KEY,
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
    runtimeMode: body.runtimeMode,
    displayOrigin: body.displayOrigin,
  });

  sendJson(response, 200, {
    success: true,
    message: "Settings updated.",
    runtimeMode: result.runtimeMode,
    displayOrigin: result.displayOrigin,
    updatedAt: result.updatedAt,
    trafficThresholdPercent: SMART_REMAINING_THRESHOLD_PERCENT,
  });
}

async function handleCreateSubscription(request, response) {
  const body = await readJsonBody(request);
  const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";
  const type = normalizeType(body.type);
  const userKey = normalizeUserKey(body.userKey);

  if (!SUPPORTED_TYPES.has(type)) {
    sendJson(response, 400, {
      success: false,
      error: `Unsupported type: ${type}`,
      supportedTypes: Array.from(SUPPORTED_TYPES),
    });
    return;
  }

  const runtimeMode = await getRuntimeMode();
  const registration = await enqueueRegistration(userKey, async () =>
    createRegistration(userKey, inviteCode, {
      mode: runtimeMode,
      requestSource: "manual",
      relayType: type === "full" ? "universal" : type,
      title: "管理页手动重新注册",
      message: "已根据管理页请求生成新的上游账号。",
      decision: "register",
    }),
  );
  const relayToken = await getRelayToken(userKey);
  const relayUrls = buildRelayUrls(await getRequestOrigin(request), relayToken);
  const user = RELAY_USERS.find((item) => item.key === userKey) || RELAY_USERS[0];
  const userState = await getUserState(userKey);

  sendJson(response, 200, {
    success: true,
    message: "Registration completed.",
    ...shapeRegistrationResponse(
      user,
      {
        ...userState,
        latestRegistration: registration,
      },
      type,
      relayUrls,
      runtimeMode,
    ),
  });
}

async function handleLatestSubscription(request, response, url) {
  const type = normalizeType(url.searchParams.get("type"));
  const userKey = normalizeUserKey(url.searchParams.get("user"));

  if (!SUPPORTED_TYPES.has(type)) {
    sendJson(response, 400, {
      success: false,
      error: `Unsupported type: ${type}`,
      supportedTypes: Array.from(SUPPORTED_TYPES),
    });
    return;
  }

  const runtimeMode = await getRuntimeMode();
  const { userState, warning } = await resolveViewState(userKey, runtimeMode);
  const relayToken = await getRelayToken(userKey);
  const relayUrls = buildRelayUrls(await getRequestOrigin(request), relayToken);
  const user = RELAY_USERS.find((item) => item.key === userKey) || RELAY_USERS[0];

  sendJson(response, 200, {
    success: true,
    message: userState.latestRegistration
      ? "Latest user state returned."
      : runtimeMode === DEFAULT_RUNTIME_MODE
        ? "Current user has no registration yet."
        : "Current user has no registration yet. A client pull or manual refresh will initialize it.",
    ...shapeRegistrationResponse(user, userState, type, relayUrls, runtimeMode, warning),
  });
}

async function proxySubscription(response, request, type, url) {
  const token = (url.searchParams.get("token") || "").trim();
  const relayUser = await resolveRelayUserByToken(token);

  if (!relayUser) {
    sendText(response, 403, "Invalid subscription token.");
    return;
  }

  const { runtimeMode, userState } = await resolveRelayState(relayUser.key, type);
  const latest = userState.latestRegistration;
  const upstreamUrl = latest?.clientUrls?.[type];

  if (!upstreamUrl) {
    sendText(response, 400, `Unsupported relay type: ${type}`);
    return;
  }

  if (latest.mock) {
    await appendUserHistory(relayUser.key, {
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
        "profile-title": `Snail Mock ${type}`,
      },
    );
    return;
  }

  let upstreamResponse;

  try {
    upstreamResponse = await fetchUpstreamSubscription(upstreamUrl);
  } catch (error) {
    await appendUserHistory(relayUser.key, {
      action: "relay_failed",
      title: "中转拉取上游失败",
      message: error.message,
      mode: runtimeMode,
      relayType: type,
      requestSource: "relay",
      registration: latest,
      usage: userState.latestUsage,
    });
    sendText(response, 502, `Upstream subscription request failed: ${error.message}`);
    return;
  }

  if (!upstreamResponse.ok) {
    await appendUserHistory(relayUser.key, {
      action: "relay_failed",
      title: "上游返回异常状态码",
      message: `上游状态码 ${upstreamResponse.status}`,
      mode: runtimeMode,
      relayType: type,
      requestSource: "relay",
      registration: latest,
      usage: userState.latestUsage,
      details: {
        status: upstreamResponse.status,
      },
    });

    sendText(
      response,
      upstreamResponse.status,
      `Upstream subscription request failed with status ${upstreamResponse.status}.`,
    );
    return;
  }

  await appendUserHistory(relayUser.key, {
    action: "relay_success",
    title: "已成功中转客户端订阅",
    message: `客户端成功拉取 ${type} 订阅。`,
    mode: runtimeMode,
    relayType: type,
    requestSource: "relay",
    registration: latest,
    usage: userState.latestUsage,
  });

  const headers = {};
  upstreamResponse.headers.forEach((value, key) => {
    if (FORWARDED_HEADERS.has(key.toLowerCase())) {
      headers[key] = value;
    }
  });

  const body = Buffer.from(await upstreamResponse.arrayBuffer());
  response.writeHead(200, headers);

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  response.end(body);
}

async function requestListener(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method === "GET" && url.pathname === "/") {
      const html = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
      sendHtml(response, 200, html);
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
      const relayState = await loadRelayState();
      const latestRegistrationAvailable = Object.values(relayState.users || {}).some(
        (userState) => Boolean(userState?.latestRegistration),
      );
      sendJson(response, 200, {
        success: true,
        status: "ok",
        latestRegistrationAvailable,
      });
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
