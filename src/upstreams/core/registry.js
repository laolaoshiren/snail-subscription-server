"use strict";

const fs = require("node:fs");
const path = require("node:path");

const vendorsDir = path.join(__dirname, "..", "vendors");

let cachedModules = null;

function validateModule(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  if (!candidate.manifest || typeof candidate.manifest !== "object") {
    return null;
  }

  if (!candidate.manifest.id || typeof candidate.manifest.id !== "string") {
    return null;
  }

  if (typeof candidate.register !== "function" || typeof candidate.query !== "function") {
    return null;
  }

  if (typeof candidate.normalizeSettings !== "function") {
    return null;
  }

  return candidate;
}

function loadModules() {
  if (cachedModules) {
    return cachedModules;
  }

  const modules = [];
  const entries = fs.existsSync(vendorsDir) ? fs.readdirSync(vendorsDir, { withFileTypes: true }) : [];

  entries.forEach((entry) => {
    if (!entry.isDirectory()) {
      return;
    }

    const modulePath = path.join(vendorsDir, entry.name);
    const candidate = validateModule(require(modulePath));
    if (candidate) {
      modules.push(candidate);
    }
  });

  modules.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  cachedModules = modules;
  return modules;
}

function reloadUpstreamModules() {
  if (fs.existsSync(vendorsDir)) {
    const entries = fs.readdirSync(vendorsDir, { withFileTypes: true });
    entries.forEach((entry) => {
      if (!entry.isDirectory()) {
        return;
      }

      const modulePath = path.join(vendorsDir, entry.name);
      try {
        delete require.cache[require.resolve(modulePath)];
      } catch (error) {
        // Ignore cache misses.
      }
    });
  }

  cachedModules = null;
  return loadModules();
}

function listUpstreamModules() {
  return loadModules();
}

function getUpstreamModule(upstreamId) {
  return loadModules().find((item) => item.manifest.id === upstreamId) || null;
}

function getDefaultUpstreamId() {
  return loadModules()[0]?.manifest.id || "";
}

module.exports = {
  getDefaultUpstreamId,
  getUpstreamModule,
  listUpstreamModules,
  reloadUpstreamModules,
};
