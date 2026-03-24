"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { USER_KEYS } = require("./authStore");
const { dataDir } = require("./dataPaths");
const { getDefaultUpstreamId } = require("./upstreams/core/registry");

const relayStateFile = path.join(dataDir, "relay-state.json");
const latestRegistrationFile = path.join(dataDir, "latest-registration.json");
const STATE_VERSION = 2;
const MAX_HISTORY_ITEMS = 120;

function createEmptyRegistrationState() {
  return {
    latestRegistration: null,
    latestUsage: null,
    history: [],
    updatedAt: null,
  };
}

function createEmptyUserState() {
  return {
    upstreams: {},
    updatedAt: null,
  };
}

function createBaseState() {
  const users = {};
  USER_KEYS.forEach((userKey) => {
    users[userKey] = createEmptyUserState();
  });

  return {
    version: STATE_VERSION,
    users,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const normalized = {
    id:
      typeof entry.id === "string" && entry.id.trim()
        ? entry.id.trim()
        : crypto.randomBytes(8).toString("hex"),
    timestamp:
      typeof entry.timestamp === "string" && entry.timestamp.trim()
        ? entry.timestamp.trim()
        : new Date().toISOString(),
    action: (entry.action || "info").toString(),
    title: (entry.title || "").toString(),
    message: (entry.message || "").toString(),
    mode: entry.mode ? entry.mode.toString() : "",
    decision: entry.decision ? entry.decision.toString() : "",
    relayType: entry.relayType ? entry.relayType.toString() : "",
    requestSource: entry.requestSource ? entry.requestSource.toString() : "",
    upstreamId: entry.upstreamId ? entry.upstreamId.toString() : "",
    usage: entry.usage && typeof entry.usage === "object" ? entry.usage : null,
    registration:
      entry.registration && typeof entry.registration === "object" ? entry.registration : null,
    details: entry.details && typeof entry.details === "object" ? entry.details : null,
  };

  if (normalized.action === "migration") {
    normalized.title = "已迁移旧版记录";
    normalized.message = "检测到旧版单用户数据，已自动迁移到当前默认上游。";
  }

  return normalized;
}

function normalizeRegistrationState(registrationState) {
  const source = registrationState && typeof registrationState === "object" ? registrationState : {};

  const history = Array.isArray(source.history)
    ? source.history
        .map(normalizeHistoryEntry)
        .filter(Boolean)
        .sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp))
        .slice(0, MAX_HISTORY_ITEMS)
    : [];

  return {
    latestRegistration:
      source.latestRegistration && typeof source.latestRegistration === "object"
        ? source.latestRegistration
        : null,
    latestUsage: source.latestUsage && typeof source.latestUsage === "object" ? source.latestUsage : null,
    history,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
  };
}

function isNestedUserState(userState) {
  return Boolean(userState && typeof userState === "object" && userState.upstreams && typeof userState.upstreams === "object");
}

function normalizeLegacyUserState(userState, upstreamId) {
  const normalized = normalizeRegistrationState(userState);
  if (!normalized.latestRegistration && !normalized.latestUsage && normalized.history.length === 0) {
    return createEmptyUserState();
  }

  return {
    upstreams: {
      [upstreamId]: normalized,
    },
    updatedAt: normalized.updatedAt,
  };
}

function normalizeUserState(userState, defaultUpstreamId) {
  if (!isNestedUserState(userState)) {
    return normalizeLegacyUserState(userState, defaultUpstreamId);
  }

  const source = userState && typeof userState === "object" ? userState : {};
  const upstreams = {};
  const sourceUpstreams = source.upstreams && typeof source.upstreams === "object" ? source.upstreams : {};

  Object.entries(sourceUpstreams).forEach(([upstreamId, registrationState]) => {
    if (!upstreamId) {
      return;
    }

    upstreams[upstreamId] = normalizeRegistrationState(registrationState);
  });

  return {
    upstreams,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
  };
}

function normalizeRelayState(parsed) {
  const baseState = createBaseState();
  const source = parsed && typeof parsed === "object" ? parsed : {};
  const defaultUpstreamId = getDefaultUpstreamId();
  const sourceUsers = source.users && typeof source.users === "object" ? source.users : {};
  const normalizedUsers = {};
  const userKeys = Array.from(new Set([...USER_KEYS, ...Object.keys(sourceUsers)]));

  userKeys.forEach((userKey) => {
    normalizedUsers[userKey] = normalizeUserState(sourceUsers[userKey], defaultUpstreamId);
  });

  return {
    version: STATE_VERSION,
    users: normalizedUsers,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : baseState.updatedAt,
  };
}

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function writeRelayState(state) {
  const normalized = normalizeRelayState(state);
  await ensureDataDir();
  await fs.writeFile(relayStateFile, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

async function migrateLegacyState() {
  const state = createBaseState();
  const defaultUpstreamId = getDefaultUpstreamId();

  try {
    const content = await fs.readFile(latestRegistrationFile, "utf8");
    const legacyRecord = JSON.parse(content);
    state.users.userA = {
      upstreams: {
        [defaultUpstreamId]: {
          latestRegistration: legacyRecord,
          latestUsage: null,
          history: [
            normalizeHistoryEntry({
              action: "migration",
              title: "已迁移旧版记录",
              message: "检测到旧版单用户记录，已自动迁移到 用户A / 默认上游。",
              registration: legacyRecord,
              upstreamId: defaultUpstreamId,
            }),
          ],
          updatedAt: legacyRecord.createdAt || new Date().toISOString(),
        },
      },
      updatedAt: legacyRecord.createdAt || new Date().toISOString(),
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  return writeRelayState(state);
}

async function loadRelayState() {
  try {
    const content = await fs.readFile(relayStateFile, "utf8");
    const parsed = JSON.parse(content);
    const normalized = normalizeRelayState(parsed);

    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      await writeRelayState(normalized);
    }

    return normalized;
  } catch (error) {
    if (error.code === "ENOENT") {
      return migrateLegacyState();
    }

    throw error;
  }
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function ensureUserState(state, userKey) {
  if (!state.users[userKey]) {
    state.users[userKey] = createEmptyUserState();
  }

  if (!state.users[userKey].upstreams || typeof state.users[userKey].upstreams !== "object") {
    state.users[userKey].upstreams = {};
  }

  return state.users[userKey];
}

function ensureUserUpstreamState(state, userKey, upstreamId) {
  const userState = ensureUserState(state, userKey);
  if (!userState.upstreams[upstreamId]) {
    userState.upstreams[upstreamId] = createEmptyRegistrationState();
  }

  return userState.upstreams[upstreamId];
}

async function updateRelayState(mutator) {
  const currentState = await loadRelayState();
  const draft = cloneState(currentState);
  await mutator(draft);
  draft.updatedAt = new Date().toISOString();
  return writeRelayState(draft);
}

async function getUserState(userKey, upstreamId = getDefaultUpstreamId()) {
  const state = await loadRelayState();
  const userState = ensureUserState(state, userKey);
  return normalizeRegistrationState(userState.upstreams[upstreamId]);
}

async function listUserStates(upstreamId = getDefaultUpstreamId()) {
  const state = await loadRelayState();

  return Object.entries(state.users).map(([userKey, userState]) => ({
    userKey,
    ...normalizeRegistrationState(userState.upstreams?.[upstreamId]),
  }));
}

async function appendUserHistory(userKey, upstreamId, entry) {
  const normalizedEntry = normalizeHistoryEntry({
    ...entry,
    upstreamId,
  });
  if (!normalizedEntry) {
    return;
  }

  await updateRelayState(async (state) => {
    const registrationState = ensureUserUpstreamState(state, userKey, upstreamId);
    registrationState.history = [
      normalizedEntry,
      ...(Array.isArray(registrationState.history) ? registrationState.history : []),
    ]
      .map(normalizeHistoryEntry)
      .filter(Boolean)
      .slice(0, MAX_HISTORY_ITEMS);
    registrationState.updatedAt = new Date().toISOString();
    ensureUserState(state, userKey).updatedAt = registrationState.updatedAt;
  });
}

async function updateUserState(userKey, upstreamId, mutator) {
  await updateRelayState(async (state) => {
    const registrationState = ensureUserUpstreamState(state, userKey, upstreamId);
    const draftRegistrationState = cloneState(registrationState);
    await mutator(draftRegistrationState);
    const normalized = normalizeRegistrationState(draftRegistrationState);
    normalized.updatedAt = new Date().toISOString();
    ensureUserState(state, userKey).upstreams[upstreamId] = normalized;
    ensureUserState(state, userKey).updatedAt = normalized.updatedAt;
  });
}

module.exports = {
  appendUserHistory,
  getUserState,
  listUserStates,
  loadRelayState,
  relayStateFile,
  updateUserState,
};
