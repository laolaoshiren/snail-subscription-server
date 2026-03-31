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
const STATE_VERSION = 1;
let aggregateCacheMutationQueue = Promise.resolve();
let aggregateCacheStatePromise = null;

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
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

function createBaseState() {
  const users = {};
  USER_KEYS.forEach((userKey) => {
    users[userKey] = {};
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

function normalizePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
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

function normalizeUserCache(userCache = {}) {
  const source = userCache && typeof userCache === "object" ? userCache : {};
  const result = {};

  Object.entries(source).forEach(([type, entry]) => {
    const normalized = normalizeCacheEntry(type, entry);
    if (normalized) {
      result[type] = normalized;
    }
  });

  return result;
}

function normalizeSchedulerState(scheduler = {}) {
  const source = scheduler && typeof scheduler === "object" ? scheduler : {};
  const fallback = createEmptySchedulerState();

  return {
    enabled: Boolean(source.enabled),
    intervalMinutes: normalizePositiveInteger(source.intervalMinutes, fallback.intervalMinutes) || fallback.intervalMinutes,
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
    users[userKey] = normalizeUserCache(sourceUsers[userKey]);
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
  return state.users?.[userKey]?.[type] || null;
}

async function mergeAggregateCacheEntries(userKey, entries = {}) {
  return updateAggregateCacheState(async (state) => {
    if (!state.users[userKey] || typeof state.users[userKey] !== "object") {
      state.users[userKey] = {};
    }

    Object.entries(entries).forEach(([type, entry]) => {
      const normalized = normalizeCacheEntry(type, entry);
      if (normalized) {
        state.users[userKey][type] = normalized;
        return;
      }

      delete state.users[userKey][type];
    });
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
  loadAggregateCacheState,
  mergeAggregateCacheEntries,
  updateAggregateCacheScheduler,
};
