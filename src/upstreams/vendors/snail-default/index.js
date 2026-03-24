"use strict";

const { querySubscriptionStatus, registerAndFetchSubscribe } = require("../../shared/snailApi");

const MANIFEST = Object.freeze({
  id: "snail-default",
  label: "默认上游",
  description: "内置的 Snail / V2Board 兼容适配器。",
  settingFields: Object.freeze([
    {
      key: "entryUrl",
      label: "检测入口",
      placeholder: "可留空",
      description: "上游检测入口，留空则使用适配器默认值。",
    },
    {
      key: "officialSiteUrl",
      label: "官方站点",
      placeholder: "可留空",
      description: "指定官方站点后，将优先从该站点读取配置。",
    },
    {
      key: "apiBase",
      label: "API 地址",
      placeholder: "可留空",
      description: "手动指定 API 后，将优先跳过动态探测。",
    },
  ]),
  defaultConfig: Object.freeze({
    enabled: true,
    runtimeMode: "always_refresh",
    trafficThresholdPercent: 20,
    maxRegistrationAgeMinutes: 120,
    inviteCode: "",
    settings: {
      entryUrl: "",
      officialSiteUrl: "",
      apiBase: "",
    },
  }),
});

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function normalizePercentage(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, parsed));
}

function normalizeString(value) {
  return (value || "").toString().trim();
}

function normalizeSettings(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const defaults = MANIFEST.defaultConfig;

  return {
    enabled: source.enabled !== false,
    runtimeMode: source.runtimeMode === "smart_usage" ? "smart_usage" : "always_refresh",
    trafficThresholdPercent: normalizePercentage(
      source.trafficThresholdPercent,
      defaults.trafficThresholdPercent,
    ),
    maxRegistrationAgeMinutes: normalizePositiveInteger(
      source.maxRegistrationAgeMinutes,
      defaults.maxRegistrationAgeMinutes,
    ),
    inviteCode: normalizeString(source.inviteCode),
    settings: {
      entryUrl: normalizeString(source.settings?.entryUrl),
      officialSiteUrl: normalizeString(source.settings?.officialSiteUrl),
      apiBase: normalizeString(source.settings?.apiBase),
    },
  };
}

async function register(options = {}) {
  const upstreamConfig = normalizeSettings(options.upstreamConfig);
  const inviteCode = normalizeString(options.inviteCode || upstreamConfig.inviteCode);

  return registerAndFetchSubscribe({
    inviteCode,
    entryUrl: upstreamConfig.settings.entryUrl,
    officialSiteUrl: upstreamConfig.settings.officialSiteUrl,
    apiBase: upstreamConfig.settings.apiBase,
    verbose: options.verbose,
    logger: options.logger,
  });
}

async function query(options = {}) {
  const upstreamConfig = normalizeSettings(options.upstreamConfig);
  const record = options.record && typeof options.record === "object" ? options.record : null;

  if (!record?.token) {
    throw new Error("Missing upstream auth token.");
  }

  return querySubscriptionStatus({
    token: record.token,
    apiBase: record.apiBase || upstreamConfig.settings.apiBase,
    upstreamSite: record.upstreamSite || upstreamConfig.settings.officialSiteUrl,
    officialSiteUrl: upstreamConfig.settings.officialSiteUrl,
    entryUrl: record.entryUrl || upstreamConfig.settings.entryUrl,
    detectorConfigUrl: record.detectorConfigUrl,
    upstreamSource: record.upstreamSource,
    verbose: options.verbose,
    logger: options.logger,
  });
}

module.exports = {
  manifest: MANIFEST,
  normalizeSettings,
  query,
  register,
};
