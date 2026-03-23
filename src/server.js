"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const {
  URL_TYPES,
  ensureProxyConfigured,
  registerAndFetchSubscribe,
} = require("../auto_register");
const {
  DEFAULT_PASSWORD,
  getRelayToken,
  updatePassword,
  validateRelayToken,
  verifyPasswordLogin,
} = require("./authStore");
const {
  loadLatestRegistration,
  saveLatestRegistration,
} = require("./registrationStore");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const DEFAULT_INVITE_CODE = (process.env.INVITE_CODE || process.env.DEFAULT_INVITE_CODE || "").trim();
const PUBLIC_ORIGIN = normalizeConfiguredOrigin(process.env.PUBLIC_ORIGIN || "");
const SESSION_COOKIE_NAME = "snail_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const RELAY_FETCH_TIMEOUT_MS = Number.parseInt(process.env.RELAY_FETCH_TIMEOUT_MS || "30000", 10);
const publicDir = path.join(__dirname, "..", "public");
const sessions = new Map();

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

let registrationQueue = Promise.resolve();

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

function getRequestOrigin(request) {
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

function buildRelayUrls(origin, relayToken) {
  const encodedToken = encodeURIComponent(relayToken);
  return Object.fromEntries(
    RELAY_TYPES.map((type) => [
      type,
      `${origin}/subscribe/${encodeURIComponent(type)}?token=${encodedToken}`,
    ]),
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
  return {
    email: record.email,
    password: record.password,
    inviteCode: record.inviteCode,
    createdAt: record.createdAt,
    mock: record.mock,
    entryUrl: record.entryUrl,
    upstreamSite: record.upstreamSite,
    apiBase: record.apiBase,
  };
}

function shapeRegistrationResponse(record, type, relayUrls) {
  const subscriptionUrl = type === "full" ? relayUrls.universal : relayUrls[type];

  if (!record) {
    return {
      type,
      subscriptionUrl,
      relayUrls,
      registration: null,
    };
  }

  if (type === "full") {
    return {
      type,
      subscriptionUrl,
      relayUrls,
      registration: sanitizeRegistration(record),
    };
  }

  return {
    type,
    subscriptionUrl,
    relayUrls,
    registration: sanitizeRegistration(record),
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

function enqueueRegistration(job) {
  const nextJob = registrationQueue.then(job, job);
  registrationQueue = nextJob.catch(() => undefined);
  return nextJob;
}

function resolveInviteCode(inviteCode, record) {
  return (inviteCode || record?.inviteCode || DEFAULT_INVITE_CODE || "").toString().trim();
}

function shouldCreateRegistration(record) {
  if (!record) {
    return true;
  }

  if (record.mock && process.env.AUTO_REGISTER_MOCK !== "1") {
    return true;
  }

  if (!record.clientUrls?.universal) {
    return true;
  }

  return false;
}

async function createRegistration(inviteCode) {
  const result = await registerAndFetchSubscribe({
    inviteCode,
    verbose: false,
    logger: console,
  });
  await saveLatestRegistration(result);
  return result;
}

async function fetchUpstreamSubscription(upstreamUrl) {
  ensureProxyConfigured();

  return fetch(upstreamUrl, {
    signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS),
  });
}

async function ensureRelayRegistration(options = {}) {
  const cached =
    options.cachedRecord === undefined ? await loadLatestRegistration() : options.cachedRecord;
  const inviteCode = resolveInviteCode(options.inviteCode, cached);

  if (!options.forceRefresh && !shouldCreateRegistration(cached)) {
    return cached;
  }

  return enqueueRegistration(async () => {
    const latest = await loadLatestRegistration();

    if (!options.forceRefresh && !shouldCreateRegistration(latest)) {
      return latest;
    }

    return createRegistration(inviteCode);
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
  const relayToken = await getRelayToken();
  const origin = getRequestOrigin(request);
  const relayUrls = buildRelayUrls(origin, relayToken);

  sendJson(response, 200, {
    success: true,
    authenticated: Boolean(session),
    defaultPassword: DEFAULT_PASSWORD,
    relayUrls,
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

async function handleCreateSubscription(request, response) {
  const body = await readJsonBody(request);
  const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";
  const type = normalizeType(body.type);

  if (!SUPPORTED_TYPES.has(type)) {
    sendJson(response, 400, {
      success: false,
      error: `Unsupported type: ${type}`,
      supportedTypes: Array.from(SUPPORTED_TYPES),
    });
    return;
  }

  const registration = await ensureRelayRegistration({
    inviteCode,
    forceRefresh: true,
  });

  const relayToken = await getRelayToken();
  const relayUrls = buildRelayUrls(getRequestOrigin(request), relayToken);

  sendJson(response, 200, {
    success: true,
    message: "Registration completed.",
    ...shapeRegistrationResponse(registration, type, relayUrls),
  });
}

async function handleLatestSubscription(request, response, url) {
  const type = normalizeType(url.searchParams.get("type"));

  if (!SUPPORTED_TYPES.has(type)) {
    sendJson(response, 400, {
      success: false,
      error: `Unsupported type: ${type}`,
      supportedTypes: Array.from(SUPPORTED_TYPES),
    });
    return;
  }

  const latest = await loadLatestRegistration();

  const relayToken = await getRelayToken();
  const relayUrls = buildRelayUrls(getRequestOrigin(request), relayToken);

  sendJson(response, 200, {
    success: true,
    message: latest
      ? "Latest registration record returned."
      : "Relay URLs are ready. Upstream registration will be created on first client request.",
    ...shapeRegistrationResponse(latest, type, relayUrls),
  });
}

async function proxySubscription(response, request, type, url) {
  const token = (url.searchParams.get("token") || "").trim();
  const validToken = await validateRelayToken(token);

  if (!validToken) {
    sendText(response, 403, "Invalid subscription token.");
    return;
  }

  const previousLatest = await loadLatestRegistration();
  // The relay URL stays stable, but every client pull must mint a fresh upstream account.
  const latest = await ensureRelayRegistration({
    inviteCode: previousLatest?.inviteCode,
    cachedRecord: previousLatest,
    forceRefresh: true,
  });
  let upstreamUrl = latest.clientUrls?.[type];
  if (!upstreamUrl) {
    sendText(response, 400, `Unsupported relay type: ${type}`);
    return;
  }

  if (latest.mock) {
    sendText(
      response,
      200,
      [
        "# Mock relay subscription",
        `type=${type}`,
        `email=${latest.email}`,
        `inviteCode=${latest.inviteCode || ""}`,
        `upstream=${upstreamUrl}`,
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
    sendText(response, 502, `Upstream subscription request failed: ${error.message}`);
    return;
  }

  if (!upstreamResponse.ok) {
    sendText(
      response,
      upstreamResponse.status,
      `Upstream subscription request failed with status ${upstreamResponse.status}.`,
    );
    return;
  }

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
      const latest = await loadLatestRegistration();
      sendJson(response, 200, {
        success: true,
        status: "ok",
        latestRegistrationAvailable: Boolean(latest),
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
