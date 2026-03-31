"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { USER_KEYS } = require("./authStore");
const { dataDir } = require("./dataPaths");
const {
  backupCorruptedJsonFile,
  parseJsonWithRecovery,
  writeJsonFileAtomic,
} = require("./jsonStateFile");

const aggregateCacheFile = path.join(dataDir, "aggregate-cache.json");
const STATE_VERSION = 2;
let aggregateCacheMutationQueue = Promise.resolve();
let aggregateCacheStatePromise = null;

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function toTimestamp(value) {
  const timestamp = new Date(value || "").getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function createEmptySchedulerState() {
  return {
    enabled: false,
    intervalMinutes: 60,
    running: false,
    nextRunAt: "",
    lastStartedAt: "",
    lastCompletedAt: "",
    lastSuccessfulAt: "",
    lastError: "",
    lastDurationMs: 0,
    lastRun: {
      userCount: 0,
      cacheCount: 0,
      sourceCount: 0,
      failureCount: 0,
    },
  };
}

function createEmptyUserCacheState() {
  return {
    cacheEntries: {},
    sourcePool: [],
  };
}

function createBaseState() {
  const users = {};
  USER_KEYS.forEach((userKey) => {
    users[userKey] = createEmptyUserCacheState();
  });

  return {
    version: STATE_VERSION,
    users,
    scheduler: createEmptySchedulerState(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeHeaders(headers = {}) {
  const source = headers && typeof headers === "object" ? headers : {};
  const result = {};

  Object.entries(source).forEach(([key, value]) => {
    const normalizedKey = (key || "").toString().trim().toLowerCase();
    if (!normalizedKey || value === undefined || value === null) {
      return;
    }

    result[normalizedKey] = value.toString();
  });

  return result;
}

function normalizeSourceLabels(labels = []) {
  if (!Array.isArray(labels)) {
    return [];
  }

  return labels
    .map((value) => (value || "").toString().trim())
    .filter(Boolean);
}

function normalizeClientUrls(clientUrls = {}) {
  const source = clientUrls && typeof clientUrls === "object" ? clientUrls : {};
  const result = {};

  Object.entries(source).forEach(([key, value]) => {
    const normalizedKey = (key || "").toString().trim();
    const normalizedValue = (value || "").toString().trim();
    if (!normalizedKey || !normalizedValue) {
      return;
    }

    result[normalizedKey] = normalizedValue;
  });

  return result;
}

function normalizeSerializableRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  return cloneState(record);
}

function normalizeRegistrationRecord(record) {
  const normalized = normalizeSerializableRecord(record);
  if (!normalized) {
    return null;
  }

  normalized.clientUrls = normalizeClientUrls(normalized.clientUrls);
  return normalized;
}

function normalizeUsageRecord(record) {
  return normalizeSerializableRecord(record);
}

function normalizeCacheEntry(type, entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const bodyBase64 =
    typeof entry.bodyBase64 === "string"
      ? entry.bodyBase64.trim()
      : typeof entry.body === "string"
        ? Buffer.from(entry.body, "utf8").toString("base64")
        : "";

  if (!bodyBase64) {
    return null;
  }

  return {
    type: (type || entry.type || "").toString().trim(),
    signature: (entry.signature || "").toString().trim(),
    headers: normalizeHeaders(entry.headers),
    bodyBase64,
    generatedAt: (entry.generatedAt || "").toString().trim(),
    sourceCount: normalizePositiveInteger(entry.sourceCount),
    failureCount: normalizePositiveInteger(entry.failureCount),
    warning: (entry.warning || "").toString(),
    sourceLabels: normalizeSourceLabels(entry.sourceLabels),
  };
}

function normalizeCacheEntriesMap(entries = {}) {
  const source = entries && typeof entries === "object" ? entries : {};
  const result = {};

  Object.entries(source).forEach(([type, entry]) => {
    const normalized = normalizeCacheEntry(type, entry);
    if (normalized) {
      result[type] = normalized;
    }
  });

  return result;
}

function normalizeSourcePoolEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const upstreamId = (entry.upstreamId || entry.storageKey || "").toString().trim();
  if (!upstreamId) {
    return null;
  }

  const registration = normalizeRegistrationRecord(
    entry.registration || entry.record || entry.latestRegistration,
  );
  if (!registration) {
    return null;
  }

  const storageKey = (entry.storageKey || upstreamId).toString().trim() || upstreamId;
  const savedAt =
    (entry.savedAt || entry.createdAt || registration.createdAt || "").toString().trim();
  const id = (entry.id || `${storageKey}:${savedAt || registration.email || ""}`).toString().trim();

  return {
    id: id || `${storageKey}:${registration.email || ""}`,
    upstreamId,
    storageKey,
    instanceNumber: Math.max(1, normalizePositiveInteger(entry.instanceNumber, 1) || 1),
    instanceLabel: (entry.instanceLabel || storageKey).toString().trim() || storageKey,
    savedAt,
    lastValidatedAt: (entry.lastValidatedAt || "").toString().trim(),
    lastValidationError: (entry.lastValidationError || "").toString(),
    registration,
    latestUsage: normalizeUsageRecord(entry.latestUsage || entry.usage),
  };
}

function normalizeSourcePool(entries = []) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .map(normalizeSourcePoolEntry)
    .filter(Boolean)
    .sort((left, right) => {
      const rightTime = toTimestamp(right.savedAt || right.registration?.createdAt || "");
      const leftTime = toTimestamp(left.savedAt || left.registration?.createdAt || "");
      return rightTime - leftTime;
    });
}

function normalizeUserCacheState(userCache = {}) {
  const source = userCache && typeof userCache === "object" ? userCache : {};
  const hasStructuredShape =
    Object.prototype.hasOwnProperty.call(source, "cacheEntries")
    || Object.prototype.hasOwnProperty.call(source, "sourcePool");

  return {
    cacheEntries: normalizeCacheEntriesMap(hasStructuredShape ? source.cacheEntries : source),
    sourcePool: normalizeSourcePool(source.sourcePool),
  };
}

function normalizeSchedulerState(scheduler = {}) {
  const source = scheduler && typeof scheduler === "object" ? scheduler : {};
  const fallback = createEmptySchedulerState();

  return {
    enabled: Boolean(source.enabled),
    intervalMinutes:
      normalizePositiveInteger(source.intervalMinutes, fallback.intervalMinutes) || fallback.intervalMinutes,
    running: Boolean(source.running),
    nextRunAt: (source.nextRunAt || "").toString().trim(),
    lastStartedAt: (source.lastStartedAt || "").toString().trim(),
    lastCompletedAt: (source.lastCompletedAt || "").toString().trim(),
    lastSuccessfulAt: (source.lastSuccessfulAt || "").toString().trim(),
    lastError: (source.lastError || "").toString(),
    lastDurationMs: normalizePositiveInteger(source.lastDurationMs),
    lastRun: {
      userCount: normalizePositiveInteger(source.lastRun?.userCount),
      cacheCount: normalizePositiveInteger(source.lastRun?.cacheCount),
      sourceCount: normalizePositiveInteger(source.lastRun?.sourceCount),
      failureCount: normalizePositiveInteger(source.lastRun?.failureCount),
    },
  };
}

function normalizeAggregateCacheState(parsed = {}) {
  const baseState = createBaseState();
  const source = parsed && typeof parsed === "object" ? parsed : {};
  const sourceUsers = source.users && typeof source.users === "object" ? source.users : {};
  const users = {};
  const userKeys = Array.from(new Set([...USER_KEYS, ...Object.keys(sourceUsers)]));

  userKeys.forEach((userKey) => {
    users[userKey] = normalizeUserCacheState(sourceUsers[userKey]);
  });

  return {
    version: STATE_VERSION,
    users,
    scheduler: normalizeSchedulerState(source.scheduler),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : baseState.updatedAt,
  };
}

async function writeAggregateCacheState(state) {
  const normalizedState = normalizeAggregateCacheState(state);
  await fs.mkdir(dataDir, { recursive: true });
  await writeJsonFileAtomic(aggregateCacheFile, normalizedState);
  aggregateCacheStatePromise = Promise.resolve(normalizedState);
  return cloneState(normalizedState);
}

async function readAggregateCacheStateFromDisk() {
  try {
    const content = await fs.readFile(aggregateCacheFile, "utf8");
    const { value: parsed, recovered } = parseJsonWithRecovery(content);
    const normalizedState = normalizeAggregateCacheState(parsed);

    if (recovered) {
      await backupCorruptedJsonFile(aggregateCacheFile, content);
    }

    if (recovered || JSON.stringify(parsed) !== JSON.stringify(normalizedState)) {
      await writeAggregateCacheState(normalizedState);
    }

    return normalizedState;
  } catch (error) {
    if (error.code === "ENOENT") {
      const baseState = createBaseState();
      await writeAggregateCacheState(baseState);
      return normalizeAggregateCacheState(baseState);
    }

    throw error;
  }
}

async function loadAggregateCacheState() {
  if (!aggregateCacheStatePromise) {
    aggregateCacheStatePromise = readAggregateCacheStateFromDisk();
  }

  return cloneState(await aggregateCacheStatePromise);
}

function enqueueAggregateCacheMutation(task) {
  const nextTask = aggregateCacheMutationQueue.then(task, task);
  aggregateCacheMutationQueue = nextTask.catch(() => undefined);
  return nextTask;
}

async function updateAggregateCacheState(mutator) {
  return enqueueAggregateCacheMutation(async () => {
    const currentState = await loadAggregateCacheState();
    const draftState = cloneState(currentState);
    await mutator(draftState);
    draftState.updatedAt = new Date().toISOString();
    return writeAggregateCacheState(draftState);
  });
}

async function getAggregateCacheEntry(userKey, type) {
  const state = await loadAggregateCacheState();
  return state.users?.[userKey]?.cacheEntries?.[type] || null;
}

async function getAggregateCacheUserState(userKey) {
  const state = await loadAggregateCacheState();
  return state.users?.[userKey] || createEmptyUserCacheState();
}

async function replaceAggregateCacheUserState(userKey, userState = {}) {
  return updateAggregateCacheState(async (state) => {
    state.users[userKey] = normalizeUserCacheState(userState);
  });
}

async function mergeAggregateCacheEntries(userKey, entries = {}) {
  return updateAggregateCacheState(async (state) => {
    const currentUserState = normalizeUserCacheState(state.users[userKey]);
    currentUserState.cacheEntries = {
      ...currentUserState.cacheEntries,
      ...normalizeCacheEntriesMap(entries),
    };
    state.users[userKey] = currentUserState;
  });
}

async function getAggregateCacheScheduler() {
  const state = await loadAggregateCacheState();
  return state.scheduler || createEmptySchedulerState();
}

async function updateAggregateCacheScheduler(patch = {}) {
  return updateAggregateCacheState(async (state) => {
    const currentScheduler = normalizeSchedulerState(state.scheduler);
    const nextScheduler = {
      ...currentScheduler,
      ...Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ),
      lastRun:
        patch.lastRun && typeof patch.lastRun === "object"
          ? {
              ...currentScheduler.lastRun,
              ...Object.fromEntries(
                Object.entries(patch.lastRun).filter(([, value]) => value !== undefined),
              ),
            }
          : currentScheduler.lastRun,
    };

    state.scheduler = normalizeSchedulerState(nextScheduler);
  });
}

module.exports = {
  aggregateCacheFile,
  getAggregateCacheEntry,
  getAggregateCacheScheduler,
  getAggregateCacheUserState,
  loadAggregateCacheState,
  mergeAggregateCacheEntries,
  replaceAggregateCacheUserState,
  updateAggregateCacheScheduler,
};
