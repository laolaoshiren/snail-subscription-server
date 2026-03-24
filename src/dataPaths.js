"use strict";

const path = require("node:path");

const repoRoot = process.env.SNAIL_REPO_ROOT
  ? path.resolve(process.env.SNAIL_REPO_ROOT)
  : path.join(__dirname, "..");
const configuredDataDir = process.env.SNAIL_DATA_DIR || process.env.ACCOUNT_DATA_DIR || "";
const dataDir = configuredDataDir
  ? path.resolve(configuredDataDir)
  : path.join(repoRoot, "data");
const syncedUpstreamsDir = path.join(repoRoot, "src", "upstreams", "synced-vendors");
const tempDir = path.join(dataDir, ".tmp");
const systemStateFile = path.join(dataDir, "system-state.json");

module.exports = {
  dataDir,
  repoRoot,
  syncedUpstreamsDir,
  tempDir,
  systemStateFile,
};
