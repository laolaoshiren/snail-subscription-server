"use strict";

const fs = require("node:fs/promises");

const { dataDir, systemStateFile } = require("./dataPaths");

const DEFAULT_APP_UPDATE_STATE = Object.freeze({
  supported: false,
  mode: "readonly",
  currentVersion: "",
  currentCommitSha: "",
  latestVersion: "",
  latestCommitSha: "",
  updateAvailable: false,
  checking: false,
  updating: false,
  lastCheckedAt: "",
  lastUpdatedAt: "",
  lastError: "",
});

const DEFAULT_UPSTREAM_CLOUD_STATE = Object.freeze({
  checking: false,
  syncing: false,
  lastCheckedAt: "",
  lastSyncedAt: "",
  latestCommitSha: "",
  lastSyncedCommitSha: "",
  lastSyncedSourceKey: "",
  updateAvailable: false,
  lastError: "",
  installedModules: [],
});

function normalizeAppUpdateState(rawState = {}) {
  return {
    supported: Boolean(rawState.supported),
    mode: (rawState.mode || DEFAULT_APP_UPDATE_STATE.mode).toString(),
    currentVersion: (rawState.currentVersion || "").toString(),
    currentCommitSha: (rawState.currentCommitSha || "").toString(),
    latestVersion: (rawState.latestVersion || "").toString(),
    latestCommitSha: (rawState.latestCommitSha || "").toString(),
    updateAvailable: Boolean(rawState.updateAvailable),
    checking: Boolean(rawState.checking),
    updating: Boolean(rawState.updating),
    lastCheckedAt: (rawState.lastCheckedAt || "").toString(),
    lastUpdatedAt: (rawState.lastUpdatedAt || "").toString(),
    lastError: (rawState.lastError || "").toString(),
  };
}

function normalizeUpstreamCloudState(rawState = {}) {
  return {
    checking: Boolean(rawState.checking),
    syncing: Boolean(rawState.syncing),
    lastCheckedAt: (rawState.lastCheckedAt || "").toString(),
    lastSyncedAt: (rawState.lastSyncedAt || "").toString(),
    latestCommitSha: (rawState.latestCommitSha || "").toString(),
    lastSyncedCommitSha: (rawState.lastSyncedCommitSha || "").toString(),
    lastSyncedSourceKey: (rawState.lastSyncedSourceKey || "").toString(),
    updateAvailable: Boolean(rawState.updateAvailable),
    lastError: (rawState.lastError || "").toString(),
    installedModules: Array.isArray(rawState.installedModules)
      ? rawState.installedModules.map((item) => item.toString())
      : [],
  };
}

function normalizeSystemState(rawState = {}) {
  return {
    appUpdate: normalizeAppUpdateState(rawState.appUpdate),
    upstreamCloud: normalizeUpstreamCloudState(rawState.upstreamCloud),
  };
}

async function saveSystemState(state = {}) {
  const normalizedState = normalizeSystemState(state);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(systemStateFile, JSON.stringify(normalizedState, null, 2), "utf8");
  return normalizedState;
}

async function loadSystemState() {
  try {
    const content = await fs.readFile(systemStateFile, "utf8");
    const parsed = JSON.parse(content);
    const normalizedState = normalizeSystemState(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(normalizedState)) {
      await saveSystemState(normalizedState);
    }
    return normalizedState;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    const defaultState = normalizeSystemState();
    await saveSystemState(defaultState);
    return defaultState;
  }
}

async function updateSystemState(patch = {}) {
  const currentState = await loadSystemState();
  const nextState = normalizeSystemState({
    ...currentState,
    ...patch,
    appUpdate: {
      ...currentState.appUpdate,
      ...(patch.appUpdate || {}),
    },
    upstreamCloud: {
      ...currentState.upstreamCloud,
      ...(patch.upstreamCloud || {}),
    },
  });
  await saveSystemState(nextState);
  return nextState;
}

module.exports = {
  DEFAULT_APP_UPDATE_STATE,
  DEFAULT_UPSTREAM_CLOUD_STATE,
  loadSystemState,
  normalizeSystemState,
  saveSystemState,
  updateSystemState,
};
