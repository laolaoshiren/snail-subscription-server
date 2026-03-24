"use strict";

const { defineUpstreamModule } = require("../../core/moduleContract");

const DEFAULT_ENTRY_URL = "https://v1.v52x.cc/#/register?code=EjHD";
const DEFAULT_SITE_URL = "https://v1.v52x.cc";
const DEFAULT_API_BASE = "https://admin.52admin.top";

module.exports = defineUpstreamModule({
  manifest: {
    id: "cloud52",
    label: "52Cloud",
    description: "自定义加密 API 面板，当前注册时要求 GeeTest 滑块验证码。",
    website: "https://v1.v52x.cc",
    capabilities: {
      supportsStatusQuery: false,
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
        description: "52Cloud 前端面板地址。",
      },
      {
        key: "apiBase",
        label: "API 地址",
        type: "url",
        placeholder: DEFAULT_API_BASE,
        description: "52Cloud 后端 API 地址。",
      },
    ],
  },
  defaultConfig: {
    name: "52Cloud",
    remark: "兑换码 52one",
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
    throw new Error(
      `${upstreamConfig.name || "52Cloud"} 当前启用了 GeeTest 滑块验证，未接入验证码求解前无法自动注册。`,
    );
  },
});
