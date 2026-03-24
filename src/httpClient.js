"use strict";

const DEFAULT_PROXY_URL = process.env.PROXY_URL || "http://127.0.0.1:7890";

let proxyConfigured = false;

function ensureProxyConfigured() {
  if (proxyConfigured) {
    return;
  }

  if (!DEFAULT_PROXY_URL || DEFAULT_PROXY_URL === "off") {
    proxyConfigured = true;
    return;
  }

  try {
    const { ProxyAgent, setGlobalDispatcher } = require("undici");
    const dispatcher = new ProxyAgent({
      uri: DEFAULT_PROXY_URL,
      requestTls: { rejectUnauthorized: false },
    });
    setGlobalDispatcher(dispatcher);
  } catch (error) {
    // Ignore and continue with direct connections.
  }

  proxyConfigured = true;
}

module.exports = {
  ensureProxyConfigured,
};
