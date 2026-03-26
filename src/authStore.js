"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { dataDir } = require("./dataPaths");
const {
  backupCorruptedJsonFile,
  parseJsonWithRecovery,
  writeJsonFileAtomic,
} = require("./jsonStateFile");
const { getDefaultUpstreamId, getUpstreamModule, listUpstreamModules } = require("./upstreams/core/registry");

const accountFile = path.join(dataDir, "account.json");
const relayTokensFile = path.join(dataDir, "relay-tokens.json");
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
const ACTIVE_UPSTREAM_MODES = Object.freeze({
  SINGLE: "single",
  POLLING: "polling",
  AGGREGATE: "aggregate",
});
const MAX_AGGREGATE_COPIES = 10;
const DEFAULT_AGGREGATE_TIMEOUT_SECONDS = 15;
const MAX_AGGREGATE_TIMEOUT_SECONDS = 120;
let securityStateMutationQueue = Promise.resolve();
const DEFAULT_UPSTREAM_CLOUD = Object.freeze({
  enabled: true,
  autoSync: true,
  repoOwner: "laolaoshiren",
  repoName: "snail-subscription-server",
  branch: "main",
  directory: "src/upstreams/vendors",
});
const DEFAULT_UPSTREAM_AGGREGATION = Object.freeze({
  counts: {},
  timeoutSeconds: DEFAULT_AGGREGATE_TIMEOUT_SECONDS,
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

function normalizeGitHubSegment(value, fallback = "") {
  return (value || fallback).toString().trim().replace(/^\/+|\/+$/g, "");
}

function normalizeRepoDirectory(value, fallback = DEFAULT_UPSTREAM_CLOUD.directory) {
  const normalized = (value || fallback)
    .toString()
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return normalized || DEFAULT_UPSTREAM_CLOUD.directory;
}

function normalizeUpstreamCloudSettings(input = {}) {
  const source = input && typeof input === "object" ? input : {};

  return {
    enabled: source.enabled !== false,
    autoSync: Boolean(source.autoSync),
    repoOwner: normalizeGitHubSegment(source.repoOwner, DEFAULT_UPSTREAM_CLOUD.repoOwner),
    repoName: normalizeGitHubSegment(source.repoName, DEFAULT_UPSTREAM_CLOUD.repoName),
    branch: normalizeGitHubSegment(source.branch, DEFAULT_UPSTREAM_CLOUD.branch) || DEFAULT_UPSTREAM_CLOUD.branch,
    directory: normalizeRepoDirectory(source.directory, DEFAULT_UPSTREAM_CLOUD.directory),
  };
}

function normalizeAggregateCopyCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.min(MAX_AGGREGATE_COPIES, parsed);
}

function normalizeAggregateTimeoutSeconds(value, fallback = DEFAULT_AGGREGATE_TIMEOUT_SECONDS) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(MAX_AGGREGATE_TIMEOUT_SECONDS, parsed);
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

function getUpstreamSortLabel(upstreamId, upstreams) {
  const module = getUpstreamModule(upstreamId);
  return (
    upstreams?.[upstreamId]?.name ||
    module?.manifest?.label ||
    upstreamId ||
    ""
  ).toString();
}

function normalizeActiveUpstreamMode(input) {
  const value = (input || "").toString().trim();
  if (value === ACTIVE_UPSTREAM_MODES.POLLING) {
    return ACTIVE_UPSTREAM_MODES.POLLING;
  }
  if (value === ACTIVE_UPSTREAM_MODES.AGGREGATE) {
    return ACTIVE_UPSTREAM_MODES.AGGREGATE;
  }
  return ACTIVE_UPSTREAM_MODES.SINGLE;
}

function normalizeUpstreamOrder(rawOrder, upstreams) {
  const knownIds = listUpstreamModules().map((module) => module.manifest.id);
  const seen = new Set();
  const orderedIds = [];

  if (Array.isArray(rawOrder)) {
    rawOrder.forEach((value) => {
      const upstreamId = (value || "").toString().trim();
      if (!upstreamId || seen.has(upstreamId) || !knownIds.includes(upstreamId)) {
        return;
      }

      seen.add(upstreamId);
      orderedIds.push(upstreamId);
    });
  }

  const missingIds = knownIds
    .filter((upstreamId) => !seen.has(upstreamId))
    .sort((left, right) =>
      getUpstreamSortLabel(left, upstreams).localeCompare(
        getUpstreamSortLabel(right, upstreams),
        "zh-CN",
        { numeric: true, sensitivity: "base" },
      ),
    );

  return [...orderedIds, ...missingIds];
}

function resolveActiveUpstreamId(input, upstreams, upstreamOrder = []) {
  const candidate = (input || "").toString().trim();
  if (candidate && upstreams[candidate]?.enabled) {
    return candidate;
  }

  const firstEnabledId = normalizeUpstreamOrder(upstreamOrder, upstreams).find(
    (upstreamId) => upstreams[upstreamId]?.enabled !== false,
  );
  if (firstEnabledId) {
    return firstEnabledId;
  }

  return getDefaultUpstreamId();
}

function normalizeUpstreamAggregation(input = {}, upstreams = {}, upstreamOrder = [], fallbackUpstreamId = "") {
  const source = input && typeof input === "object" ? input : {};
  const sourceCounts = source.counts && typeof source.counts === "object" ? source.counts : {};
  const timeoutSeconds = normalizeAggregateTimeoutSeconds(
    source.timeoutSeconds,
    DEFAULT_UPSTREAM_AGGREGATION.timeoutSeconds,
  );
  const orderedIds = normalizeUpstreamOrder(upstreamOrder, upstreams);
  const counts = {};

  orderedIds.forEach((upstreamId) => {
    counts[upstreamId] = normalizeAggregateCopyCount(sourceCounts[upstreamId]);
  });

  if (Object.values(counts).some((value) => value > 0)) {
    return {
      counts,
      timeoutSeconds,
    };
  }

  const fallbackId = resolveActiveUpstreamId(fallbackUpstreamId, upstreams, upstreamOrder);
  const seedId =
    (fallbackId && upstreams[fallbackId]?.enabled !== false && fallbackId) ||
    orderedIds.find((upstreamId) => upstreams[upstreamId]?.enabled !== false) ||
    orderedIds[0] ||
    "";

  if (seedId) {
    counts[seedId] = 1;
  }

  return {
    counts,
    timeoutSeconds,
  };
}

function createSecurityState(password, options = {}) {
  const salt = crypto.randomBytes(16).toString("hex");
  const upstreams = normalizeUpstreamConfigs(options.upstreams, options.runtimeMode);
  const upstreamOrder = normalizeUpstreamOrder(options.upstreamOrder, upstreams);
  const activeUpstreamMode = normalizeActiveUpstreamMode(options.activeUpstreamMode);
  const upstreamCloud = normalizeUpstreamCloudSettings(options.upstreamCloud);
  const activeUpstreamId = resolveActiveUpstreamId(options.activeUpstreamId, upstreams, upstreamOrder);
  const upstreamAggregation = normalizeUpstreamAggregation(
    options.upstreamAggregation,
    upstreams,
    upstreamOrder,
    activeUpstreamId,
  );

  return {
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt),
    relayTokens: normalizeRelayTokens(options.relayTokens, options.legacyRelayToken),
    displayOrigin: normalizeDisplayOrigin(options.displayOrigin),
    activeUpstreamId,
    activeUpstreamMode,
    upstreamOrder,
    upstreams,
    upstreamCloud,
    upstreamAggregation,
    updatedAt: new Date().toISOString(),
  };
}

function normalizePanelState(rawState = {}) {
  if (!rawState.passwordSalt || !rawState.passwordHash) {
    throw new Error("Security file is invalid.");
  }

  const upstreams = normalizeUpstreamConfigs(rawState.upstreams, rawState.runtimeMode);
  const upstreamOrder = normalizeUpstreamOrder(rawState.upstreamOrder, upstreams);
  const activeUpstreamMode = normalizeActiveUpstreamMode(rawState.activeUpstreamMode);
  const upstreamCloud = normalizeUpstreamCloudSettings(rawState.upstreamCloud);
  const activeUpstreamId = resolveActiveUpstreamId(rawState.activeUpstreamId, upstreams, upstreamOrder);
  const upstreamAggregation = normalizeUpstreamAggregation(
    rawState.upstreamAggregation,
    upstreams,
    upstreamOrder,
    activeUpstreamId,
  );

  return {
    passwordSalt: rawState.passwordSalt,
    passwordHash: rawState.passwordHash,
    relayTokens: normalizeRelayTokens(rawState.relayTokens, rawState.relayToken),
    displayOrigin: normalizeDisplayOrigin(rawState.displayOrigin),
    activeUpstreamId,
    activeUpstreamMode,
    upstreamOrder,
    upstreams,
    upstreamCloud,
    upstreamAggregation,
    updatedAt: rawState.updatedAt || new Date().toISOString(),
  };
}

async function saveSecurityState(state) {
  const normalizedState = normalizePanelState(state);
  await fs.mkdir(dataDir, { recursive: true });
  await writeJsonFileAtomic(accountFile, normalizedState);
  await writeJsonFileAtomic(relayTokensFile, normalizedState.relayTokens);
}

async function loadRelayTokenBackup() {
  try {
    const content = await fs.readFile(relayTokensFile, "utf8");
    const { value: parsed, recovered } = parseJsonWithRecovery(content);
    if (recovered) {
      await backupCorruptedJsonFile(relayTokensFile, content);
      await writeJsonFileAtomic(relayTokensFile, parsed);
    }
    return normalizeRelayTokens(parsed);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function hasStoredRelayTokens(rawState = {}) {
  if (rawState.relayToken) {
    return true;
  }

  if (!rawState.relayTokens || typeof rawState.relayTokens !== "object") {
    return false;
  }

  return Object.values(rawState.relayTokens).some((value) => typeof value === "string" && value.trim());
}

function mergeRelayTokens(state, backupTokens, options = {}) {
  if (!backupTokens) {
    return state;
  }

  const mergedSource = options.preferBackup
    ? {
        ...(state?.relayTokens || {}),
        ...backupTokens,
      }
    : {
        ...backupTokens,
        ...(state?.relayTokens || {}),
      };

  const nextRelayTokens = normalizeRelayTokens({
    ...mergedSource,
  });

  return {
    ...state,
    relayTokens: nextRelayTokens,
  };
}

async function loadSecurityState() {
  const relayTokenBackup = await loadRelayTokenBackup();

  try {
    const content = await fs.readFile(accountFile, "utf8");
    const { value: parsed, recovered } = parseJsonWithRecovery(content);
    const normalizedState = mergeRelayTokens(normalizePanelState(parsed), relayTokenBackup, {
      preferBackup: !hasStoredRelayTokens(parsed),
    });

    if (recovered) {
      await backupCorruptedJsonFile(accountFile, content);
    }

    if (recovered || JSON.stringify(parsed) !== JSON.stringify(normalizedState) || !relayTokenBackup) {
      await saveSecurityState(normalizedState);
    }

    return normalizedState;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    const defaultState = createSecurityState(DEFAULT_PASSWORD, {
      activeUpstreamId: getDefaultUpstreamId(),
      relayTokens: relayTokenBackup || undefined,
    });
    await saveSecurityState(defaultState);
    return defaultState;
  }
}

function enqueueSecurityStateMutation(task) {
  const nextTask = securityStateMutationQueue.then(task, task);
  securityStateMutationQueue = nextTask.catch(() => undefined);
  return nextTask;
}

async function verifyPasswordLogin(password) {
  const state = await loadSecurityState();
  const valid = safeCompare(hashPassword(password, state.passwordSalt), state.passwordHash);

  return {
    valid,
    state,
  };
}

async function isDefaultPasswordActive() {
  const state = await loadSecurityState();
  return safeCompare(hashPassword(DEFAULT_PASSWORD, state.passwordSalt), state.passwordHash);
}

async function updatePassword({ currentPassword, newPassword }) {
  return enqueueSecurityStateMutation(async () => {
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
      activeUpstreamMode: state.activeUpstreamMode,
      upstreamOrder: state.upstreamOrder,
      upstreams: state.upstreams,
      upstreamCloud: state.upstreamCloud,
      upstreamAggregation: state.upstreamAggregation,
    });
    await saveSecurityState(nextState);
    return {
      updatedAt: nextState.updatedAt,
    };
  });
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

async function getActiveUpstreamRuntime() {
  const state = await loadSecurityState();
  return {
    activeUpstreamId: state.activeUpstreamId,
    activeUpstreamMode: state.activeUpstreamMode,
    upstreamOrder: Array.isArray(state.upstreamOrder) ? [...state.upstreamOrder] : [],
    upstreamAggregation: state.upstreamAggregation || DEFAULT_UPSTREAM_AGGREGATION,
  };
}

async function getUpstreamConfig(upstreamId) {
  const state = await loadSecurityState();
  const resolvedUpstreamId = upstreamId || state.activeUpstreamId;
  return state.upstreams[resolvedUpstreamId] || null;
}

async function getUpstreamCloudConfig() {
  const state = await loadSecurityState();
  return normalizeUpstreamCloudSettings(state.upstreamCloud);
}

async function listUpstreamConfigs() {
  const state = await loadSecurityState();
  const orderedIds = normalizeUpstreamOrder(state.upstreamOrder, state.upstreams);

  return orderedIds
    .map((upstreamId, index) => {
      const module = getUpstreamModule(upstreamId);
      if (!module) {
        return null;
      }

      return {
        id: module.manifest.id,
        apiVersion: module.manifest.apiVersion,
        label: state.upstreams[module.manifest.id]?.name || module.manifest.label,
        moduleLabel: module.manifest.label,
        description: module.manifest.description || "",
        website: module.manifest.website || "",
        docsUrl: module.manifest.docsUrl || "",
        author: module.manifest.author || "",
        capabilities: module.manifest.capabilities || {},
        supportedTypes: Array.isArray(module.manifest.supportedTypes)
          ? module.manifest.supportedTypes
          : [],
        remark: state.upstreams[module.manifest.id]?.remark || "",
        settingFields: Array.isArray(module.manifest.settingFields) ? module.manifest.settingFields : [],
        sourceType: module.__source?.type || "bundled",
        config: state.upstreams[module.manifest.id],
        aggregateCopies: state.upstreamAggregation?.counts?.[module.manifest.id] || 0,
        orderIndex: index,
        active:
          state.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.SINGLE &&
          state.activeUpstreamId === module.manifest.id,
      };
    })
    .filter(Boolean);
}

async function updatePanelSettings(settings = {}) {
  return enqueueSecurityStateMutation(async () => {
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

    if (settings.activeUpstreamMode !== undefined) {
      nextState.activeUpstreamMode = normalizeActiveUpstreamMode(settings.activeUpstreamMode);
    }

    if (settings.upstreamOrder !== undefined) {
      if (!Array.isArray(settings.upstreamOrder)) {
        throw new Error("Upstream order must be an array.");
      }
      nextState.upstreamOrder = normalizeUpstreamOrder(settings.upstreamOrder, nextState.upstreams);
    }

    if (settings.upstreamCloud !== undefined) {
      nextState.upstreamCloud = normalizeUpstreamCloudSettings({
        ...nextState.upstreamCloud,
        ...settings.upstreamCloud,
      });
    }

    if (settings.upstreamAggregation !== undefined) {
      nextState.upstreamAggregation = normalizeUpstreamAggregation(
        {
          ...nextState.upstreamAggregation,
          ...settings.upstreamAggregation,
          counts:
            settings.upstreamAggregation && Object.prototype.hasOwnProperty.call(settings.upstreamAggregation, "counts")
              ? settings.upstreamAggregation.counts
              : nextState.upstreamAggregation?.counts,
        },
        nextState.upstreams,
        nextState.upstreamOrder,
        nextState.activeUpstreamId,
      );
    }

    const targetUpstreamId = settings.upstreamId || nextState.activeUpstreamId;
    if (targetUpstreamId) {
      const module = getUpstreamModule(targetUpstreamId);
      if (!module) {
        throw new Error("Upstream is invalid.");
      }

      const currentConfig = nextState.upstreams[targetUpstreamId] || module.normalizeSettings({});
      nextState.upstreams[targetUpstreamId] = module.applySettingsPatch(currentConfig, {
        name: settings.name,
        remark: settings.remark,
        enabled: settings.enabled,
        inviteCode: settings.inviteCode,
        runtimeMode: settings.runtimeMode,
        trafficThresholdPercent: settings.trafficThresholdPercent,
        maxRegistrationAgeMinutes: settings.maxRegistrationAgeMinutes,
        subscriptionUpdateIntervalMinutes: settings.subscriptionUpdateIntervalMinutes,
        providerSettings: settings.providerSettings,
      });
    }

    nextState.upstreamOrder = normalizeUpstreamOrder(nextState.upstreamOrder, nextState.upstreams);
    nextState.activeUpstreamId = resolveActiveUpstreamId(
      nextState.activeUpstreamId,
      nextState.upstreams,
      nextState.upstreamOrder,
    );
    nextState.upstreamAggregation = normalizeUpstreamAggregation(
      nextState.upstreamAggregation,
      nextState.upstreams,
      nextState.upstreamOrder,
      nextState.activeUpstreamId,
    );
    nextState.updatedAt = new Date().toISOString();

    await saveSecurityState(nextState);
    return {
      activeUpstreamId: nextState.activeUpstreamId,
      activeUpstreamMode: nextState.activeUpstreamMode,
      displayOrigin: nextState.displayOrigin,
      upstreamOrder: nextState.upstreamOrder,
      upstreamCloud: nextState.upstreamCloud,
      upstreamAggregation: nextState.upstreamAggregation,
      updatedAt: nextState.updatedAt,
      upstreamConfig: nextState.upstreams[nextState.activeUpstreamId],
    };
  });
}

module.exports = {
  ACTIVE_UPSTREAM_MODES,
  DEFAULT_AGGREGATE_TIMEOUT_SECONDS,
  DEFAULT_PASSWORD,
  DEFAULT_USER_KEY,
  MAX_AGGREGATE_COPIES,
  RELAY_USERS,
  RUNTIME_MODES,
  USER_KEYS,
  accountFile,
  getActiveUpstreamId,
  getActiveUpstreamRuntime,
  getDisplayOrigin,
  getRelayToken,
  getUpstreamConfig,
  getUpstreamCloudConfig,
  isUserKey,
  listRelayUsers,
  listUpstreamConfigs,
  loadSecurityState,
  normalizeAggregateTimeoutSeconds,
  normalizeDisplayOrigin,
  normalizeUserKey,
  resolveRelayUserByToken,
  relayTokensFile,
  isDefaultPasswordActive,
  updatePanelSettings,
  updatePassword,
  verifyPasswordLogin,
};
