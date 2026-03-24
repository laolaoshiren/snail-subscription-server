"use strict";

const path = require("node:path");

const {
  listUpstreamModuleDiagnostics,
  listUpstreamModules,
  validateModule,
} = require("../src/upstreams/core/registry");

function printDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    console.log("No upstream module diagnostics.");
    return;
  }

  diagnostics.forEach((item) => {
    console.log(`- ${item.id}: ${item.message}`);
    if (item.modulePath) {
      console.log(`  path: ${item.modulePath}`);
    }
  });
}

function printModules(modules) {
  if (!Array.isArray(modules) || modules.length === 0) {
    console.log("No upstream modules loaded.");
    return;
  }

  modules.forEach((module) => {
    const supportedTypes = Array.isArray(module.manifest.supportedTypes)
      ? module.manifest.supportedTypes.join(", ")
      : "";
    console.log(
      `- ${module.manifest.id} | ${module.manifest.label} | api=${module.manifest.apiVersion} | types=${supportedTypes}`,
    );
  });
}

function validateSingleTarget(targetPath) {
  const resolvedPath = path.resolve(process.cwd(), targetPath);
  const candidate = require(resolvedPath);
  const module = validateModule(candidate);

  console.log(`Validated module: ${module.manifest.id}`);
  console.log(`Label: ${module.manifest.label}`);
  console.log(`API version: ${module.manifest.apiVersion}`);
  console.log(`Supported types: ${module.manifest.supportedTypes.join(", ")}`);
  console.log(
    `Capabilities: query=${module.manifest.capabilities.supportsStatusQuery}, inviteCode=${module.manifest.capabilities.supportsInviteCode}`,
  );
}

function main() {
  const targetPath = process.argv[2];

  if (targetPath) {
    validateSingleTarget(targetPath);
    return;
  }

  const modules = listUpstreamModules();
  const diagnostics = listUpstreamModuleDiagnostics();

  printModules(modules);
  printDiagnostics(diagnostics);

  if (diagnostics.length > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
