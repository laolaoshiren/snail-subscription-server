"use strict";

process.env.NODE_TLS_REJECT_UNAUTHORIZED =
  process.env.ALLOW_INSECURE_TLS === "0" ? process.env.NODE_TLS_REJECT_UNAUTHORIZED : "0";

const {
  URL_TYPES,
  buildClientUrls,
  buildUsageSnapshot,
  ensureProxyConfigured,
  querySubscriptionStatus,
  registerAndFetchSubscribe,
  resolveUpstreamConfig,
} = require("./src/upstreams/shared/snailApi");

function renderHumanReadableResult(result) {
  return [
    "==================================================",
    "  Registration Result",
    "==================================================",
    `Email:          ${result.email}`,
    `Password:       ${result.password}`,
    `Invite Code:    ${result.inviteCode || "(none)"}`,
    `Created At:     ${result.createdAt}`,
    `Mock Mode:      ${result.mock ? "yes" : "no"}`,
    `Entry URL:      ${result.entryUrl}`,
    `Detector Config:${result.detectorConfigUrl}`,
    `Upstream Site:  ${result.upstreamSite || "(unknown)"}`,
    `API Base:       ${result.apiBase}`,
    "",
    "Subscription URLs:",
    `  Universal:    ${result.clientUrls.universal}`,
    `  Clash:        ${result.clientUrls.clash}`,
    `  Shadowrocket: ${result.clientUrls.shadowrocket}`,
    `  Surge:        ${result.clientUrls.surge}`,
    `  QuantumultX:  ${result.clientUrls.quantumultx}`,
    `  Sing-box:     ${result.clientUrls["sing-box"]}`,
    "==================================================",
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const inviteCode = args.find((arg) => arg && !arg.startsWith("--")) || "";

  try {
    const result = await registerAndFetchSubscribe({
      inviteCode,
      verbose: !jsonOutput,
      logger: console,
    });

    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    console.log(renderHumanReadableResult(result));
  } catch (error) {
    if (jsonOutput) {
      process.stderr.write(`${JSON.stringify({ error: error.message }, null, 2)}\n`);
    } else {
      console.error(`Registration script failed: ${error.message}`);
    }

    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  URL_TYPES,
  buildClientUrls,
  buildUsageSnapshot,
  ensureProxyConfigured,
  querySubscriptionStatus,
  registerAndFetchSubscribe,
  resolveUpstreamConfig,
};
