"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { dataDir } = require("./dataPaths");
const { getDefaultUpstreamId, getUpstreamModule, listUpstreamModules } = require("./upstreams/core/registry");

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

function normalizeUpstreamConfigs(rawUpstreams, legacyRuntimeMode) {
  const source = rawUpstreams && typeof rawUpstreams === "object" ? rawUpstreams : {};
  const result = {};

  listUpstreamModules().forEach((module) => {
    const current = source[module.manifest.id] && typeof source[module.manifest.id] === "object"
      ? source[module.manifest.id]
      : {};
    const withLegacyRuntime =
      current.runtimeMode === undefined && legacyRuntimeMode
        ? { ...current, runtimeMode: legacyRuntimeMode }
        : current;
    result[module.manifest.id] = module.normalizeSettings(withLegacyRuntime);
  });

  return result;
}

function resolveActiveUpstreamId(input, upstreams) {
  const candidate = (input || "").toString().trim();
  if (candidate && upstreams[candidate]?.enabled) {
    return candidate;
  }

  const firstEnabled = Object.entries(upstreams).find(([, config]) => config?.enabled !== false);
  if (firstEnabled) {
    return firstEnabled[0];
  }

  return getDefaultUpstreamId();
}

function createSecurityState(password, options = {}) {
  const salt = crypto.randomBytes(16).toString("hex");
  const upstreams = normalizeUpstreamConfigs(options.upstreams, options.runtimeMode);

  return {
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt),
    relayTokens: normalizeRelayTokens(options.relayTokens, options.legacyRelayToken),
    displayOrigin: normalizeDisplayOrigin(options.displayOrigin),
    activeUpstreamId: resolveActiveUpstreamId(options.activeUpstreamId, upstreams),
    upstreams,
    updatedAt: new Date().toISOString(),
  };
}

function normalizePanelState(rawState = {}) {
  if (!rawState.passwordSalt || !rawState.passwordHash) {
    throw new Error("Security file is invalid.");
  }

  const upstreams = normalizeUpstreamConfigs(rawState.upstreams, rawState.runtimeMode);

  return {
    passwordSalt: rawState.passwordSalt,
    passwordHash: rawState.passwordHash,
    relayTokens: normalizeRelayTokens(rawState.relayTokens, rawState.relayToken),
    displayOrigin: normalizeDisplayOrigin(rawState.displayOrigin),
    activeUpstreamId: resolveActiveUpstreamId(rawState.activeUpstreamId, upstreams),
    upstreams,
    updatedAt: rawState.updatedAt || new Date().toISOString(),
  };
}

async function saveSecurityState(state) {
  const normalizedState = normalizePanelState(state);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(accountFile, JSON.stringify(normalizedState, null, 2), "utf8");
}

async function loadSecurityState() {
  try {
    const content = await fs.readFile(accountFile, "utf8");
    const parsed = JSON.parse(content);
    const normalizedState = normalizePanelState(parsed);

    if (JSON.stringify(parsed) !== JSON.stringify(normalizedState)) {
      await saveSecurityState(normalizedState);
    }

    return normalizedState;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    const defaultState = createSecurityState(DEFAULT_PASSWORD, {
      activeUpstreamId: getDefaultUpstreamId(),
    });
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
  const valid = safeCompare(hashPassword(currentPassword, state.passwordSalt), state.passwordHash);

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
    displayOrigin: state.displayOrigin,
    activeUpstreamId: state.activeUpstreamId,
    upstreams: state.upstreams,
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
  return state.relayTokens[normalizeUserKey(userKey)];
}

async function resolveRelayUserByToken(token) {
  const candidate = (token || "").trim();
  if (!candidate) {
    return null;
  }

  const state = await loadSecurityState();
  return RELAY_USERS.find((item) => safeCompare(candidate, state.relayTokens[item.key])) || null;
}

async function getDisplayOrigin() {
  const state = await loadSecurityState();
  return state.displayOrigin || "";
}

async function getActiveUpstreamId() {
  const state = await loadSecurityState();
  return state.activeUpstreamId;
}

async function getUpstreamConfig(upstreamId) {
  const state = await loadSecurityState();
  const resolvedUpstreamId = upstreamId || state.activeUpstreamId;
  return state.upstreams[resolvedUpstreamId] || null;
}

async function listUpstreamConfigs() {
  const state = await loadSecurityState();

  return listUpstreamModules().map((module) => ({
    id: module.manifest.id,
    label: state.upstreams[module.manifest.id]?.name || module.manifest.label,
    moduleLabel: module.manifest.label,
    description: module.manifest.description || "",
    remark: state.upstreams[module.manifest.id]?.remark || "",
    settingFields: Array.isArray(module.manifest.settingFields) ? module.manifest.settingFields : [],
    config: state.upstreams[module.manifest.id],
    active: state.activeUpstreamId === module.manifest.id,
  }));
}

async function updatePanelSettings(settings = {}) {
  const state = await loadSecurityState();
  const nextState = {
    ...state,
    relayTokens: normalizeRelayTokens(state.relayTokens),
    upstreams: { ...state.upstreams },
  };

  if (settings.displayOrigin !== undefined) {
    const normalizedDisplayOrigin = normalizeDisplayOrigin(settings.displayOrigin);
    if ((settings.displayOrigin || "").toString().trim() && !normalizedDisplayOrigin) {
      throw new Error("Display origin is invalid.");
    }
    nextState.displayOrigin = normalizedDisplayOrigin;
  }

  if (settings.activeUpstreamId !== undefined) {
    const module = getUpstreamModule(settings.activeUpstreamId);
    if (!module) {
      throw new Error("Active upstream is invalid.");
    }
    nextState.activeUpstreamId = module.manifest.id;
  }

  const targetUpstreamId = settings.upstreamId || nextState.activeUpstreamId;
  if (targetUpstreamId) {
    const module = getUpstreamModule(targetUpstreamId);
    if (!module) {
      throw new Error("Upstream is invalid.");
    }

    const currentConfig = nextState.upstreams[targetUpstreamId] || module.normalizeSettings({});
    const mergedConfig = {
      ...currentConfig,
      runtimeMode:
        settings.runtimeMode === undefined ? currentConfig.runtimeMode : settings.runtimeMode,
      trafficThresholdPercent:
        settings.trafficThresholdPercent === undefined
          ? currentConfig.trafficThresholdPercent
          : settings.trafficThresholdPercent,
      maxRegistrationAgeMinutes:
        settings.maxRegistrationAgeMinutes === undefined
          ? currentConfig.maxRegistrationAgeMinutes
          : settings.maxRegistrationAgeMinutes,
      inviteCode:
        settings.inviteCode === undefined ? currentConfig.inviteCode : settings.inviteCode,
      name: settings.name === undefined ? currentConfig.name : settings.name,
      remark: settings.remark === undefined ? currentConfig.remark : settings.remark,
      settings: {
        ...(currentConfig.settings || {}),
        ...(settings.providerSettings && typeof settings.providerSettings === "object"
          ? settings.providerSettings
          : {}),
      },
      enabled: settings.enabled === undefined ? currentConfig.enabled : Boolean(settings.enabled),
    };

    nextState.upstreams[targetUpstreamId] = module.normalizeSettings(mergedConfig);
  }

  nextState.activeUpstreamId = resolveActiveUpstreamId(nextState.activeUpstreamId, nextState.upstreams);
  nextState.updatedAt = new Date().toISOString();

  await saveSecurityState(nextState);
  return {
    activeUpstreamId: nextState.activeUpstreamId,
    displayOrigin: nextState.displayOrigin,
    updatedAt: nextState.updatedAt,
    upstreamConfig: nextState.upstreams[nextState.activeUpstreamId],
  };
}

module.exports = {
  DEFAULT_PASSWORD,
  DEFAULT_USER_KEY,
  RELAY_USERS,
  RUNTIME_MODES,
  USER_KEYS,
  accountFile,
  getActiveUpstreamId,
  getDisplayOrigin,
  getRelayToken,
  getUpstreamConfig,
  isUserKey,
  listRelayUsers,
  listUpstreamConfigs,
  loadSecurityState,
  normalizeDisplayOrigin,
  normalizeUserKey,
  resolveRelayUserByToken,
  updatePanelSettings,
  updatePassword,
  verifyPasswordLogin,
};
