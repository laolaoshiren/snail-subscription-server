"use strict";

const { defineUpstreamModule } = require("../../core/moduleContract");
const {
  queryStandardV2Account,
  registerStandardV2Account,
} = require("../../shared/standardV2Api");

const DEFAULT_ENTRY_URL = "https://cokecloud.xin/#/register?code=r9urY3oC";
const DEFAULT_SITE_URL = "https://cokecloud.xin";
const DEFAULT_API_BASE = "https://cokecloud.xin/api/v1";

module.exports = defineUpstreamModule({
  manifest: {
    id: "cokecloud",
    label: "CokeCloud",
    description: "Eclipse 主题壳的标准 API 面板，当前无邮箱验证码、无 reCAPTCHA。",
    website: "https://cokecloud.xin",
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
        description: "广告分发页或主入口地址。",
      },
      {
        key: "officialSiteUrl",
        label: "站点地址",
        type: "url",
        placeholder: DEFAULT_SITE_URL,
        description: "实际前端面板地址。",
      },
      {
        key: "apiBase",
        label: "API 地址",
        type: "url",
        placeholder: DEFAULT_API_BASE,
        description: "CokeCloud API 根地址。",
      },
    ],
  },
  defaultConfig: {
    name: "CokeCloud",
    remark: "注册试用，无验证",
    runtimeMode: "always_refresh",
    trafficThresholdPercent: 20,
    maxRegistrationAgeMinutes: 120,
    subscriptionUpdateIntervalMinutes: 30,
    inviteCode: "r9urY3oC",
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
      label: "CokeCloud",
      inviteCode: context.inviteCode || upstreamConfig.inviteCode,
      entryUrl: upstreamConfig.settings.entryUrl,
      officialSiteUrl: upstreamConfig.settings.officialSiteUrl,
      apiBase: upstreamConfig.settings.apiBase,
      upstreamSource: "cokecloud",
    });
  },
  async query(context = {}) {
    const upstreamConfig = context.upstreamConfig;
    const record = context.record || {};
    return queryStandardV2Account({
      label: "CokeCloud",
      token: record.token,
      email: record.email,
      entryUrl: record.entryUrl || upstreamConfig.settings.entryUrl,
      officialSiteUrl: record.upstreamSite || upstreamConfig.settings.officialSiteUrl,
      apiBase: record.apiBase || upstreamConfig.settings.apiBase,
      upstreamSource: "cokecloud",
    });
  },
});
