"use strict";

const { defineUpstreamModule } = require("../../core/moduleContract");
const {
  queryStandardV2Account,
  registerStandardV2Account,
} = require("../../shared/standardV2Api");

const DEFAULT_ENTRY_URL = "https://pumpkin369.cc/#/register";
const DEFAULT_SITE_URL = "https://pumpkin369.cc";
const DEFAULT_API_BASE = "https://api.tomato258.cc/api/v1";

module.exports = defineUpstreamModule({
  manifest: {
    id: "pumpkin",
    label: "Pumpkin",
    description: "标准 API 面板，当前注册页要求 Google reCAPTCHA。",
    website: "https://pumpkin369.cc",
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
        description: "注册入口地址。",
      },
      {
        key: "officialSiteUrl",
        label: "站点地址",
        type: "url",
        placeholder: DEFAULT_SITE_URL,
        description: "用于 Origin / Referer 的面板地址。",
      },
      {
        key: "apiBase",
        label: "API 地址",
        type: "url",
        placeholder: DEFAULT_API_BASE,
        description: "Pumpkin API 根地址。",
      },
    ],
  },
  defaultConfig: {
    name: "Pumpkin",
    remark: "新用户 7 天试用，当前有 reCAPTCHA",
    runtimeMode: "always_refresh",
    trafficThresholdPercent: 20,
    maxRegistrationAgeMinutes: 120,
    subscriptionUpdateIntervalMinutes: 30,
    inviteCode: "",
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
    return registerStandardV2Account({
      label: "Pumpkin",
      inviteCode: context.inviteCode || upstreamConfig.inviteCode,
      entryUrl: upstreamConfig.settings.entryUrl,
      officialSiteUrl: upstreamConfig.settings.officialSiteUrl,
      apiBase: upstreamConfig.settings.apiBase,
      upstreamSource: "pumpkin",
    });
  },
  async query(context = {}) {
    const upstreamConfig = context.upstreamConfig;
    const record = context.record || {};
    return queryStandardV2Account({
      label: "Pumpkin",
      token: record.token,
      email: record.email,
      entryUrl: record.entryUrl || upstreamConfig.settings.entryUrl,
      officialSiteUrl: record.upstreamSite || upstreamConfig.settings.officialSiteUrl,
      apiBase: record.apiBase || upstreamConfig.settings.apiBase,
      upstreamSource: "pumpkin",
    });
  },
});
