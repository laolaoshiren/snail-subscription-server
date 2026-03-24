"use strict";

const { querySubscriptionStatus, registerAndFetchSubscribe } = require("./snailApi");

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

function createSnailVendor(options = {}) {
  const manifest = Object.freeze({
    id: options.id,
    label: options.label,
    description: options.description || "",
    settingFields: Object.freeze([
      {
        key: "entryUrl",
        label: "入口域名",
        placeholder: "可留空",
        description: "上游入口域名，留空则使用适配器默认入口。",
      },
      {
        key: "officialSiteUrl",
        label: "官方站点",
        placeholder: "可留空",
        description: "优先从该站点读取配置，留空则继续走自动探测。",
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
      name: options.label,
      remark: options.description || "",
      runtimeMode: "always_refresh",
      trafficThresholdPercent: 20,
      maxRegistrationAgeMinutes: 120,
      subscriptionUpdateIntervalMinutes: 30,
      inviteCode: "",
      settings: {
        entryUrl: "",
        officialSiteUrl: "",
        apiBase: "",
      },
    }),
  });

  function normalizeSettings(raw = {}) {
    const source = raw && typeof raw === "object" ? raw : {};
    const defaults = manifest.defaultConfig;

    return {
      enabled: source.enabled !== false,
      name: normalizeString(source.name) || defaults.name,
      remark: normalizeString(source.remark),
      runtimeMode: source.runtimeMode === "smart_usage" ? "smart_usage" : "always_refresh",
      trafficThresholdPercent: normalizePercentage(
        source.trafficThresholdPercent,
        defaults.trafficThresholdPercent,
      ),
      maxRegistrationAgeMinutes: normalizePositiveInteger(
        source.maxRegistrationAgeMinutes,
        defaults.maxRegistrationAgeMinutes,
      ),
      subscriptionUpdateIntervalMinutes: Math.max(
        1,
        normalizePositiveInteger(
          source.subscriptionUpdateIntervalMinutes,
          defaults.subscriptionUpdateIntervalMinutes,
        ),
      ),
      inviteCode: normalizeString(source.inviteCode),
      settings: {
        entryUrl: normalizeString(source.settings?.entryUrl),
        officialSiteUrl: normalizeString(source.settings?.officialSiteUrl),
        apiBase: normalizeString(source.settings?.apiBase),
      },
    };
  }

  async function register(vendorOptions = {}) {
    const upstreamConfig = normalizeSettings(vendorOptions.upstreamConfig);
    const inviteCode = normalizeString(vendorOptions.inviteCode || upstreamConfig.inviteCode);

    return registerAndFetchSubscribe({
      inviteCode,
      entryUrl: upstreamConfig.settings.entryUrl,
      officialSiteUrl: upstreamConfig.settings.officialSiteUrl,
      apiBase: upstreamConfig.settings.apiBase,
      verbose: vendorOptions.verbose,
      logger: vendorOptions.logger,
    });
  }

  async function query(vendorOptions = {}) {
    const upstreamConfig = normalizeSettings(vendorOptions.upstreamConfig);
    const record =
      vendorOptions.record && typeof vendorOptions.record === "object" ? vendorOptions.record : null;

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
      verbose: vendorOptions.verbose,
      logger: vendorOptions.logger,
    });
  }

  return {
    manifest,
    normalizeSettings,
    query,
    register,
  };
}

module.exports = {
  createSnailVendor,
};
