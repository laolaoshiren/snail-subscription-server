"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const dataDir = path.join(__dirname, "..", "data");
const relayStateFile = path.join(dataDir, "relay-state.json");
const latestRegistrationFile = path.join(dataDir, "latest-registration.json");
const DEFAULT_USER_KEYS = ["userA", "userB", "userC", "userD", "userE"];
const MAX_HISTORY_ITEMS = 120;

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

function createEmptyUserState() {
  return {
    latestRegistration: null,
    latestUsage: null,
    history: [],
    updatedAt: null,
  };
}

function createBaseState() {
  const users = {};
  DEFAULT_USER_KEYS.forEach((userKey) => {
    users[userKey] = createEmptyUserState();
  });

  return {
    users,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  return {
    id: typeof entry.id === "string" && entry.id.trim()
      ? entry.id.trim()
      : crypto.randomBytes(8).toString("hex"),
    timestamp: typeof entry.timestamp === "string" && entry.timestamp.trim()
      ? entry.timestamp.trim()
      : new Date().toISOString(),
    action: (entry.action || "info").toString(),
    title: (entry.title || "").toString(),
    message: (entry.message || "").toString(),
    mode: entry.mode ? entry.mode.toString() : "",
    decision: entry.decision ? entry.decision.toString() : "",
    relayType: entry.relayType ? entry.relayType.toString() : "",
    requestSource: entry.requestSource ? entry.requestSource.toString() : "",
    usage: entry.usage && typeof entry.usage === "object" ? entry.usage : null,
    registration:
      entry.registration && typeof entry.registration === "object" ? entry.registration : null,
    details: entry.details && typeof entry.details === "object" ? entry.details : null,
  };
}

function normalizeUserState(userState) {
  const state = userState && typeof userState === "object" ? userState : {};
  const history = Array.isArray(state.history)
    ? state.history
        .map(normalizeHistoryEntry)
        .filter(Boolean)
        .sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp))
        .slice(0, MAX_HISTORY_ITEMS)
    : [];

  return {
    latestRegistration:
      state.latestRegistration && typeof state.latestRegistration === "object"
        ? state.latestRegistration
        : null,
    latestUsage:
      state.latestUsage && typeof state.latestUsage === "object" ? state.latestUsage : null,
    history,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
  };
}

function normalizeRelayState(parsed) {
  const baseState = createBaseState();
  const sourceUsers =
    parsed && typeof parsed === "object" && parsed.users && typeof parsed.users === "object"
      ? parsed.users
      : {};

  const normalizedUsers = {};
  const userKeys = Array.from(new Set([...DEFAULT_USER_KEYS, ...Object.keys(sourceUsers)]));

  userKeys.forEach((userKey) => {
    normalizedUsers[userKey] = normalizeUserState(sourceUsers[userKey]);
  });

  return {
    users: normalizedUsers,
    updatedAt:
      parsed && typeof parsed.updatedAt === "string" ? parsed.updatedAt : baseState.updatedAt,
  };
}

async function writeRelayState(state) {
  await ensureDataDir();
  const normalizedState = normalizeRelayState(state);
  await fs.writeFile(relayStateFile, JSON.stringify(normalizedState, null, 2), "utf8");
  return normalizedState;
}

async function migrateLegacyState() {
  const state = createBaseState();

  try {
    const content = await fs.readFile(latestRegistrationFile, "utf8");
    const legacyRecord = JSON.parse(content);
    state.users.userA = {
      latestRegistration: legacyRecord,
      latestUsage: null,
      history: [
        normalizeHistoryEntry({
          action: "migration",
          title: "已迁移旧版记录",
          message: "检测到旧版单用户记录，已自动迁移到 用户A。",
          registration: legacyRecord,
        }),
      ],
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
    return normalizeRelayState(JSON.parse(content));
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

  return state.users[userKey];
}

async function updateRelayState(mutator) {
  const currentState = await loadRelayState();
  const draft = cloneState(currentState);
  await mutator(draft);
  draft.updatedAt = new Date().toISOString();
  return writeRelayState(draft);
}

async function getUserState(userKey) {
  const state = await loadRelayState();
  return state.users[userKey] ? normalizeUserState(state.users[userKey]) : createEmptyUserState();
}

async function loadLatestRegistration(userKey = "userA") {
  const userState = await getUserState(userKey);
  return userState.latestRegistration;
}

async function saveLatestRegistration(userKey, record) {
  let normalizedUserKey = userKey;
  let normalizedRecord = record;

  if (record === undefined && userKey && typeof userKey === "object") {
    normalizedUserKey = "userA";
    normalizedRecord = userKey;
  }

  await updateRelayState(async (state) => {
    const userState = ensureUserState(state, normalizedUserKey || "userA");
    userState.latestRegistration = normalizedRecord && typeof normalizedRecord === "object"
      ? normalizedRecord
      : null;
    userState.updatedAt = new Date().toISOString();
  });
}

async function saveLatestUsage(userKey, usage) {
  await updateRelayState(async (state) => {
    const userState = ensureUserState(state, userKey || "userA");
    userState.latestUsage = usage && typeof usage === "object" ? usage : null;
    userState.updatedAt = new Date().toISOString();
  });
}

async function appendUserHistory(userKey, entry) {
  const normalizedEntry = normalizeHistoryEntry(entry);
  if (!normalizedEntry) {
    return;
  }

  await updateRelayState(async (state) => {
    const userState = ensureUserState(state, userKey || "userA");
    userState.history = [normalizedEntry, ...(Array.isArray(userState.history) ? userState.history : [])]
      .map(normalizeHistoryEntry)
      .filter(Boolean)
      .slice(0, MAX_HISTORY_ITEMS);
    userState.updatedAt = new Date().toISOString();
  });
}

async function replaceUserState(userKey, nextUserState) {
  await updateRelayState(async (state) => {
    state.users[userKey] = normalizeUserState(nextUserState);
    state.users[userKey].updatedAt = new Date().toISOString();
  });
}

async function updateUserState(userKey, mutator) {
  await updateRelayState(async (state) => {
    const currentUserState = ensureUserState(state, userKey);
    const draftUserState = cloneState(currentUserState);
    await mutator(draftUserState);
    state.users[userKey] = normalizeUserState(draftUserState);
    state.users[userKey].updatedAt = new Date().toISOString();
  });
}

async function listUserStates() {
  const state = await loadRelayState();

  return Object.entries(state.users).map(([userKey, userState]) => ({
    userKey,
    ...normalizeUserState(userState),
  }));
}

module.exports = {
  dataDir,
  latestRegistrationFile,
  loadLatestRegistration,
  loadRelayState,
  relayStateFile,
  replaceUserState,
  saveLatestRegistration,
  saveLatestUsage,
  appendUserHistory,
  getUserState,
  listUserStates,
  updateUserState,
};
