"use strict";

const {
  fetchStandardGuestConfig,
  queryStandardV2Account,
  registerStandardV2Account,
} = require("./standardV2Api");
const {
  normalizeString,
  normalizeUrlBase,
  splitStringList,
  uniqueStrings,
} = require("./upstreamUtils");

const DEFAULT_BAOBEI_COOKIE = "auth_passed=yes";

function normalizeBaobeiApiBase(value) {
  const base = normalizeUrlBase(value, value);
  if (!base) {
    return "";
  }

  const url = new URL(base);
  if (!url.pathname || url.pathname === "/") {
    return `${url.origin}/api/v1`;
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function buildBaobeiHeaders(config) {
  return {
    Cookie: config.accessCookie,
    Origin: config.officialSiteUrl,
    Referer: `${config.officialSiteUrl}/`,
  };
}

function normalizeBaobeiApiHosts(value) {
  const hosts = splitStringList(value);
  return uniqueStrings(
    hosts.map((host) => normalizeBaobeiApiBase(host)),
  );
}

async function resolveBaobeiApiBase(config) {
  const candidates = [
    normalizeBaobeiApiBase(config.apiBase),
    ...normalizeBaobeiApiHosts(config.apiHosts),
  ].filter(Boolean);

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const guestConfig = await fetchStandardGuestConfig(
        {
          label: config.label,
          officialSiteUrl: config.officialSiteUrl,
          apiBase: candidate,
        },
        {
          headers: buildBaobeiHeaders(config),
        },
      );
      if (guestConfig && typeof guestConfig === "object") {
        return normalizeBaobeiApiBase(candidate);
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`${config.label} 没有找到可用的 API 入口。`);
}

async function registerBaobeiAccount(options = {}) {
  const config = {
    label: normalizeString(options.label) || "宝贝云",
    entryUrl: normalizeUrlBase(options.entryUrl, options.entryUrl),
    officialSiteUrl: normalizeUrlBase(options.officialSiteUrl, options.entryUrl),
    apiBase: normalizeUrlBase(options.apiBase, options.apiBase),
    apiHosts: options.apiHosts,
    accessCookie: normalizeString(options.accessCookie) || DEFAULT_BAOBEI_COOKIE,
    upstreamSource: normalizeString(options.upstreamSource),
  };

  return registerStandardV2Account({
    ...options,
    label: config.label,
    entryUrl: config.entryUrl,
    officialSiteUrl: config.officialSiteUrl,
    apiBase: await resolveBaobeiApiBase(config),
    requestHeaders: buildBaobeiHeaders(config),
    upstreamSource: config.upstreamSource,
  });
}

async function queryBaobeiAccount(options = {}) {
  const config = {
    label: normalizeString(options.label) || "宝贝云",
    entryUrl: normalizeUrlBase(options.entryUrl, options.entryUrl),
    officialSiteUrl: normalizeUrlBase(options.officialSiteUrl, options.entryUrl),
    apiBase: normalizeUrlBase(options.apiBase, options.apiBase),
    apiHosts: options.apiHosts,
    accessCookie: normalizeString(options.accessCookie) || DEFAULT_BAOBEI_COOKIE,
    upstreamSource: normalizeString(options.upstreamSource),
  };

  return queryStandardV2Account({
    ...options,
    label: config.label,
    entryUrl: config.entryUrl,
    officialSiteUrl: config.officialSiteUrl,
    apiBase: options.apiBase || await resolveBaobeiApiBase(config),
    requestHeaders: buildBaobeiHeaders(config),
    upstreamSource: config.upstreamSource,
  });
}

module.exports = {
  DEFAULT_BAOBEI_COOKIE,
  normalizeBaobeiApiBase,
  normalizeBaobeiApiHosts,
  queryBaobeiAccount,
  registerBaobeiAccount,
  resolveBaobeiApiBase,
};
