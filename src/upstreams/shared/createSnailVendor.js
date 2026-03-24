"use strict";

const { defineUpstreamModule } = require("../core/moduleContract");
const { querySubscriptionStatus, registerAndFetchSubscribe } = require("./snailApi");

function normalizeString(value) {
  return (value || "").toString().trim();
}

function createSnailVendor(options = {}) {
  return defineUpstreamModule({
    manifest: {
      id: options.id,
      label: options.label,
      description: options.description || "",
      author: options.author || "Snail",
      website: options.website || "",
      docsUrl: options.docsUrl || "",
      capabilities: options.capabilities,
      supportedTypes: options.supportedTypes,
      settingFields: [
        {
          key: "entryUrl",
          label: "入口域名",
          type: "url",
          placeholder: "可留空",
          description: "上游入口域名，留空则使用适配器默认入口。",
        },
        {
          key: "officialSiteUrl",
          label: "官方站点",
          type: "url",
          placeholder: "可留空",
          description: "优先从该站点读取配置，留空则继续走自动探测。",
        },
        {
          key: "apiBase",
          label: "API 地址",
          type: "url",
          placeholder: "可留空",
          description: "手动指定 API 后，将优先跳过动态探测。",
        },
      ],
    },
    defaultConfig: {
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
    },
    normalizeProviderSettings(settings = {}) {
      return {
        entryUrl: normalizeString(settings.entryUrl),
        officialSiteUrl: normalizeString(settings.officialSiteUrl),
        apiBase: normalizeString(settings.apiBase),
      };
    },
    async register(vendorOptions = {}) {
      const upstreamConfig = vendorOptions.upstreamConfig;
      const inviteCode = normalizeString(vendorOptions.inviteCode || upstreamConfig.inviteCode);

      return registerAndFetchSubscribe({
        inviteCode,
        entryUrl: upstreamConfig.settings.entryUrl,
        officialSiteUrl: upstreamConfig.settings.officialSiteUrl,
        apiBase: upstreamConfig.settings.apiBase,
        verbose: vendorOptions.verbose,
        logger: vendorOptions.logger,
      });
    },
    async query(vendorOptions = {}) {
      const upstreamConfig = vendorOptions.upstreamConfig;
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
    },
  });
}

module.exports = {
  createSnailVendor,
};
