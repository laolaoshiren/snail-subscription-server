"use strict";

const { defineUpstreamModule } = require("../../core/moduleContract");
const {
  queryCloud52Account,
  registerCloud52Account,
} = require("../../shared/cloud52Api");

const DEFAULT_ENTRY_URL = "https://v1.v52x.cc/#/register?code=EjHD";
const DEFAULT_SITE_URL = "https://v1.v52x.cc";
const DEFAULT_API_BASE = "https://admin.52admin.top";

module.exports = defineUpstreamModule({
  manifest: {
    id: "cloud52",
    label: "52Cloud",
    description: "加密面板，当前注册页启用了 GeeTest 滑块验证。",
    website: "https://v1.v52x.cc",
    capabilities: {
      supportsStatusQuery: true,
      supportsInviteCode: true,
    },
    settingFields: [
      {
        key: "entryUrl",
        label: "入口地址",
        type: "url",
        placeholder: DEFAULT_ENTRY_URL,
        description: "52Cloud 注册入口地址。",
      },
      {
        key: "officialSiteUrl",
        label: "站点地址",
        type: "url",
        placeholder: DEFAULT_SITE_URL,
        description: "用于 Origin / Referer 的前端地址。",
      },
      {
        key: "apiBase",
        label: "API 地址",
        type: "url",
        placeholder: DEFAULT_API_BASE,
        description: "52Cloud 加密 API 根地址。",
      },
    ],
  },
  defaultConfig: {
    name: "52Cloud",
    remark: "兑换码 52one，当前有 GeeTest",
    runtimeMode: "always_refresh",
    trafficThresholdPercent: 20,
    maxRegistrationAgeMinutes: 120,
    subscriptionUpdateIntervalMinutes: 30,
    inviteCode: "EjHD",
    settings: {
      entryUrl: DEFAULT_ENTRY_URL,
      officialSiteUrl: DEFAULT_SITE_URL,
      apiBase: DEFAULT_API_BASE,
    },
  },
  normalizeProviderSettings(settings = {}, { helpers }) {
    return {
      entryUrl: helpers.normalizeString(settings.entryUrl) || DEFAULT_ENTRY_URL,
      officialSiteUrl: helpers.normalizeString(settings.officialSiteUrl) || DEFAULT_SITE_URL,
      apiBase: helpers.normalizeString(settings.apiBase) || DEFAULT_API_BASE,
    };
  },
  async register(context = {}) {
    const upstreamConfig = context.upstreamConfig;
    return registerCloud52Account({
      label: "52Cloud",
      inviteCode: context.inviteCode || upstreamConfig.inviteCode,
      entryUrl: upstreamConfig.settings.entryUrl,
      officialSiteUrl: upstreamConfig.settings.officialSiteUrl,
      apiBase: upstreamConfig.settings.apiBase,
      upstreamSource: "cloud52",
    });
  },
  async query(context = {}) {
    const upstreamConfig = context.upstreamConfig;
    const record = context.record || {};
    return queryCloud52Account({
      label: "52Cloud",
      token: record.token,
      email: record.email,
      entryUrl: record.entryUrl || upstreamConfig.settings.entryUrl,
      officialSiteUrl: record.upstreamSite || upstreamConfig.settings.officialSiteUrl,
      apiBase: record.apiBase || upstreamConfig.settings.apiBase,
      upstreamSource: "cloud52",
    });
  },
});
