"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { dataDir } = require("./registrationStore");

const accountFile = path.join(dataDir, "account.json");
const DEFAULT_PASSWORD = "admin";
const USER_KEYS = Object.freeze(["userA", "userB", "userC", "userD", "userE"]);
const USER_LABELS = Object.freeze({
  userA: "用户A",
  userB: "用户B",
  userC: "用户C",
  userD: "用户D",
  userE: "用户E",
});
const RELAY_USERS = Object.freeze(
  USER_KEYS.map((key) => ({
    key,
    label: USER_LABELS[key],
  })),
);
const DEFAULT_USER_KEY = USER_KEYS[0];
const RUNTIME_MODES = Object.freeze({
  ALWAYS_REFRESH: "always_refresh",
  SMART_USAGE: "smart_usage",
});
const DEFAULT_RUNTIME_MODE = RUNTIME_MODES.ALWAYS_REFRESH;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isUserKey(input) {
  return USER_KEYS.includes((input || "").toString().trim());
}

function normalizeUserKey(input, fallback = DEFAULT_USER_KEY) {
  const value = (input || "").toString().trim();
  return isUserKey(value) ? value : fallback;
}

function normalizeRuntimeMode(input) {
  return input === RUNTIME_MODES.SMART_USAGE
    ? RUNTIME_MODES.SMART_USAGE
    : RUNTIME_MODES.ALWAYS_REFRESH;
}

function normalizeDisplayOrigin(input) {
  const value = (input || "").toString().trim();
  if (!value) {
    return "";
  }

  const candidate = /^https?:\/\//i.test(value) ? value : `http://${value}`;

  try {
    const url = new URL(candidate);
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}`;
  } catch (error) {
    return "";
  }
}

function generateRelayToken() {
  return crypto.randomBytes(24).toString("hex");
}

function normalizeRelayTokens(tokens, legacyRelayToken = "") {
  const nextTokens = {};
  const source = tokens && typeof tokens === "object" ? tokens : {};

  USER_KEYS.forEach((userKey, index) => {
    const value = typeof source[userKey] === "string" ? source[userKey].trim() : "";
    if (value) {
      nextTokens[userKey] = value;
      return;
    }

    if (index === 0 && legacyRelayToken) {
      nextTokens[userKey] = legacyRelayToken;
      return;
    }

    nextTokens[userKey] = generateRelayToken();
  });

  return nextTokens;
}

function createSecurityState(password, options = {}) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt),
    relayTokens: normalizeRelayTokens(options.relayTokens, options.legacyRelayToken),
    runtimeMode: normalizeRuntimeMode(options.runtimeMode),
    displayOrigin: normalizeDisplayOrigin(options.displayOrigin),
    updatedAt: new Date().toISOString(),
  };
}

async function saveSecurityState(state) {
  const normalizedState = {
    passwordSalt: state.passwordSalt,
    passwordHash: state.passwordHash,
    relayTokens: normalizeRelayTokens(state.relayTokens),
    runtimeMode: normalizeRuntimeMode(state.runtimeMode),
    displayOrigin: normalizeDisplayOrigin(state.displayOrigin),
    updatedAt: state.updatedAt || new Date().toISOString(),
  };

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(accountFile, JSON.stringify(normalizedState, null, 2), "utf8");
}

async function loadSecurityState() {
  try {
    const content = await fs.readFile(accountFile, "utf8");
    const state = JSON.parse(content);

    if (!state.passwordSalt || !state.passwordHash) {
      throw new Error("Security file is invalid.");
    }

    const normalizedState = {
      passwordSalt: state.passwordSalt,
      passwordHash: state.passwordHash,
      relayTokens: normalizeRelayTokens(state.relayTokens, state.relayToken),
      runtimeMode: normalizeRuntimeMode(state.runtimeMode),
      displayOrigin: normalizeDisplayOrigin(state.displayOrigin),
      updatedAt: state.updatedAt || new Date().toISOString(),
    };

    const changed =
      !state.relayTokens ||
      state.displayOrigin !== normalizedState.displayOrigin ||
      state.runtimeMode !== normalizedState.runtimeMode ||
      JSON.stringify(state.relayTokens || {}) !== JSON.stringify(normalizedState.relayTokens);

    if (changed) {
      await saveSecurityState(normalizedState);
    }

    return normalizedState;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    const defaultState = createSecurityState(DEFAULT_PASSWORD);
    await saveSecurityState(defaultState);
    return defaultState;
  }
}

async function verifyPasswordLogin(password) {
  const state = await loadSecurityState();
  const valid = safeCompare(hashPassword(password, state.passwordSalt), state.passwordHash);

  return {
    valid,
    state,
  };
}

async function updatePassword({ currentPassword, newPassword }) {
  const state = await loadSecurityState();
  const valid = safeCompare(
    hashPassword(currentPassword, state.passwordSalt),
    state.passwordHash,
  );

  if (!valid) {
    throw new Error("Current password is incorrect.");
  }

  const password = (newPassword || "").trim();

  if (!password) {
    throw new Error("New password cannot be empty.");
  }

  if (password.length < 4) {
    throw new Error("New password must be at least 4 characters.");
  }

  const nextState = createSecurityState(password, {
    relayTokens: state.relayTokens,
    runtimeMode: state.runtimeMode,
    displayOrigin: state.displayOrigin,
  });
  await saveSecurityState(nextState);
  return {
    updatedAt: nextState.updatedAt,
  };
}

async function listRelayUsers() {
  const state = await loadSecurityState();

  return RELAY_USERS.map((user) => ({
    ...user,
    relayToken: state.relayTokens[user.key],
  }));
}

async function getRelayToken(userKey = DEFAULT_USER_KEY) {
  const state = await loadSecurityState();
  const normalizedUserKey = normalizeUserKey(userKey);
  return state.relayTokens[normalizedUserKey];
}

async function resolveRelayUserByToken(token) {
  const candidate = (token || "").trim();
  if (!candidate) {
    return null;
  }

  const state = await loadSecurityState();
  const user = RELAY_USERS.find((item) => safeCompare(candidate, state.relayTokens[item.key]));
  return user || null;
}

async function validateRelayToken(token) {
  return Boolean(await resolveRelayUserByToken(token));
}

async function getRuntimeMode() {
  const state = await loadSecurityState();
  return state.runtimeMode;
}

async function getDisplayOrigin() {
  const state = await loadSecurityState();
  return state.displayOrigin || "";
}

async function updateRuntimeMode(runtimeMode) {
  return updatePanelSettings({ runtimeMode });
}

async function updatePanelSettings(settings = {}) {
  const state = await loadSecurityState();
  const nextMode = normalizeRuntimeMode(
    settings.runtimeMode === undefined ? state.runtimeMode : settings.runtimeMode,
  );
  const rawDisplayOrigin =
    settings.displayOrigin === undefined ? state.displayOrigin : settings.displayOrigin;
  const nextDisplayOrigin = normalizeDisplayOrigin(rawDisplayOrigin);

  if ((rawDisplayOrigin || "").toString().trim() && !nextDisplayOrigin) {
    throw new Error("Display origin is invalid.");
  }

  if (state.runtimeMode === nextMode && state.displayOrigin === nextDisplayOrigin) {
    return {
      runtimeMode: nextMode,
      displayOrigin: nextDisplayOrigin,
      updatedAt: state.updatedAt,
    };
  }

  const nextState = {
    ...state,
    runtimeMode: nextMode,
    displayOrigin: nextDisplayOrigin,
    updatedAt: new Date().toISOString(),
  };
  await saveSecurityState(nextState);
  return {
    runtimeMode: nextState.runtimeMode,
    displayOrigin: nextState.displayOrigin,
    updatedAt: nextState.updatedAt,
  };
}

module.exports = {
  DEFAULT_PASSWORD,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_USER_KEY,
  RELAY_USERS,
  RUNTIME_MODES,
  USER_KEYS,
  accountFile,
  getDisplayOrigin,
  getRelayToken,
  getRuntimeMode,
  isUserKey,
  listRelayUsers,
  loadSecurityState,
  normalizeDisplayOrigin,
  normalizeRuntimeMode,
  normalizeUserKey,
  resolveRelayUserByToken,
  updatePanelSettings,
  updatePassword,
  updateRuntimeMode,
  validateRelayToken,
  verifyPasswordLogin,
};
