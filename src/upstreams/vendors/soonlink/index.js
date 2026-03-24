"use strict";

const { defineUpstreamModule } = require("../../core/moduleContract");
const {
  DEFAULT_SOONLINK_API_BASE,
  DEFAULT_SOONLINK_ENTRY_URL,
  DEFAULT_SOONLINK_SITE_URL,
  querySoonlinkAccount,
  registerSoonlinkAccount,
} = require("../../shared/soonlinkApi");

module.exports = defineUpstreamModule({
  manifest: {
    id: "soonlink",
    label: "瞬连",
    description: "瞬连上游，默认使用瞬连官网与 API 入口。",
    website: "https://瞬连.com",
    capabilities: {
      supportsStatusQuery: true,
      supportsInviteCode: true,
    },
    supportedTypes: ["universal", "clash", "shadowrocket", "surge", "quantumultx", "sing-box"],
    settingFields: [
      {
        key: "entryUrl",
        label: "入口域名",
        type: "url",
        placeholder: DEFAULT_SOONLINK_ENTRY_URL,
        description: "瞬连导航入口，默认会使用官网域名。",
      },
      {
        key: "officialSiteUrl",
        label: "官方站点",
        type: "url",
        placeholder: DEFAULT_SOONLINK_SITE_URL,
        description: "面板站点，用于发送注册来源和 Referer。",
      },
      {
        key: "apiBase",
        label: "API 地址",
        type: "url",
        placeholder: DEFAULT_SOONLINK_API_BASE,
        description: "瞬连 API 根地址，默认使用当前已验证可用的官方 API。",
      },
    ],
  },
  defaultConfig: {
    name: "瞬连",
    remark: "瞬连.com",
    runtimeMode: "always_refresh",
    trafficThresholdPercent: 20,
    maxRegistrationAgeMinutes: 120,
    subscriptionUpdateIntervalMinutes: 30,
    inviteCode: "",
    settings: {
      entryUrl: DEFAULT_SOONLINK_ENTRY_URL,
      officialSiteUrl: DEFAULT_SOONLINK_SITE_URL,
      apiBase: DEFAULT_SOONLINK_API_BASE,
    },
  },
  normalizeProviderSettings(settings = {}, { helpers }) {
    return {
      entryUrl: helpers.normalizeString(settings.entryUrl) || DEFAULT_SOONLINK_ENTRY_URL,
      officialSiteUrl: helpers.normalizeString(settings.officialSiteUrl) || DEFAULT_SOONLINK_SITE_URL,
      apiBase: helpers.normalizeString(settings.apiBase) || DEFAULT_SOONLINK_API_BASE,
    };
  },
  async register(context = {}) {
    const upstreamConfig = context.upstreamConfig;
    return registerSoonlinkAccount({
      inviteCode: context.inviteCode || upstreamConfig.inviteCode,
      entryUrl: upstreamConfig.settings.entryUrl,
      officialSiteUrl: upstreamConfig.settings.officialSiteUrl,
      apiBase: upstreamConfig.settings.apiBase,
    });
  },
  async query(context = {}) {
    const upstreamConfig = context.upstreamConfig;
    const record = context.record || {};
    return querySoonlinkAccount({
      token: record.token,
      email: record.email,
      entryUrl: record.entryUrl || upstreamConfig.settings.entryUrl,
      officialSiteUrl: record.upstreamSite || upstreamConfig.settings.officialSiteUrl,
      apiBase: record.apiBase || upstreamConfig.settings.apiBase,
    });
  },
});
