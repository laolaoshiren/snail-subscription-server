"use strict";

const fs = require("node:fs");
const path = require("node:path");

const vendorsDir = path.join(__dirname, "..", "vendors");

let cachedState = null;

function createEmptyState() {
  return {
    modules: [],
    diagnostics: [],
  };
}

function validateModule(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Module export must be an object.");
  }

  if (!candidate.manifest || typeof candidate.manifest !== "object") {
    throw new Error("Module manifest is required.");
  }

  if (!candidate.manifest.apiVersion) {
    throw new Error("Module manifest.apiVersion is required.");
  }

  if (!candidate.manifest.id || typeof candidate.manifest.id !== "string") {
    throw new Error("Module manifest.id is required.");
  }

  if (!candidate.manifest.label || typeof candidate.manifest.label !== "string") {
    throw new Error("Module manifest.label is required.");
  }

  if (!Array.isArray(candidate.manifest.settingFields)) {
    throw new Error("Module manifest.settingFields must be an array.");
  }

  if (!Array.isArray(candidate.manifest.supportedTypes)) {
    throw new Error("Module manifest.supportedTypes must be an array.");
  }

  if (!candidate.manifest.capabilities || typeof candidate.manifest.capabilities !== "object") {
    throw new Error("Module manifest.capabilities is required.");
  }

  if (typeof candidate.register !== "function") {
    throw new Error("Module register() is required.");
  }

  if (typeof candidate.normalizeSettings !== "function") {
    throw new Error("Module normalizeSettings() is required.");
  }

  if (typeof candidate.applySettingsPatch !== "function") {
    throw new Error("Module applySettingsPatch() is required.");
  }

  if (
    candidate.manifest.capabilities.supportsStatusQuery !== false &&
    typeof candidate.query !== "function"
  ) {
    throw new Error("Module query() is required when supportsStatusQuery=true.");
  }

  return candidate;
}

function loadModules() {
  if (cachedState) {
    return cachedState;
  }

  const nextState = createEmptyState();
  const entries = fs.existsSync(vendorsDir) ? fs.readdirSync(vendorsDir, { withFileTypes: true }) : [];

  entries.forEach((entry) => {
    if (!entry.isDirectory()) {
      return;
    }

    const modulePath = path.join(vendorsDir, entry.name);

    try {
      const candidate = validateModule(require(modulePath));
      nextState.modules.push(candidate);
    } catch (error) {
      nextState.diagnostics.push({
        id: entry.name,
        modulePath,
        message: error.message,
      });
    }
  });

  nextState.modules.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  nextState.diagnostics.sort((left, right) => left.id.localeCompare(right.id));
  cachedState = nextState;
  return nextState;
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

  cachedState = null;
  return loadModules().modules;
}

function listUpstreamModules() {
  return loadModules().modules;
}

function listUpstreamModuleDiagnostics() {
  return loadModules().diagnostics;
}

function getUpstreamModule(upstreamId) {
  return loadModules().modules.find((item) => item.manifest.id === upstreamId) || null;
}

function getDefaultUpstreamId() {
  const modules = loadModules().modules;
  return modules.find((item) => item.manifest.id === "snail-default")?.manifest.id || modules[0]?.manifest.id || "";
}

module.exports = {
  getDefaultUpstreamId,
  getUpstreamModule,
  listUpstreamModuleDiagnostics,
  listUpstreamModules,
  reloadUpstreamModules,
  validateModule,
};
