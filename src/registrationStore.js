"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const dataDir = path.join(__dirname, "..", "data");
const latestRegistrationFile = path.join(dataDir, "latest-registration.json");

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function saveLatestRegistration(record) {
  await ensureDataDir();
  await fs.writeFile(latestRegistrationFile, JSON.stringify(record, null, 2), "utf8");
}

async function loadLatestRegistration() {
  try {
    const content = await fs.readFile(latestRegistrationFile, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

module.exports = {
  dataDir,
  latestRegistrationFile,
  loadLatestRegistration,
  saveLatestRegistration,
};
