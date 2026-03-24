"use strict";

const { defineUpstreamModule } = require("../../core/moduleContract");
const {
  queryMalaAccount,
  registerMalaAccount,
} = require("../../shared/malaProApi");

const DEFAULT_ENTRY_URL = "https://www.qiulinyun.online/register?code=SHtzdIZc";
const DEFAULT_SITE_URL = "https://www.qiulinyun.online";
const DEFAULT_API_BASE = "https://6846a627111aef29e11435821b54b486.qiulinyun.fun/api/v1";

module.exports = defineUpstreamModule({
  manifest: {
    id: "qiulinyun",
    label: "秋林云",
    description: "Mala-Pro 面板，无邮箱验证码，可直接自动注册试用。",
    website: "https://www.qiulinyun.online",
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
        description: "广告落地或注册入口地址。",
      },
      {
        key: "officialSiteUrl",
        label: "站点地址",
        type: "url",
        placeholder: DEFAULT_SITE_URL,
        description: "用于 Origin / Referer 的面板站点。",
      },
      {
        key: "apiBase",
        label: "API 地址",
        type: "url",
        placeholder: DEFAULT_API_BASE,
        description: "秋林云 API 根地址。",
      },
    ],
  },
  defaultConfig: {
    name: "秋林云",
    remark: "注册试用",
    runtimeMode: "always_refresh",
    trafficThresholdPercent: 20,
    maxRegistrationAgeMinutes: 120,
    subscriptionUpdateIntervalMinutes: 30,
    inviteCode: "SHtzdIZc",
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
    return registerMalaAccount({
      label: "秋林云",
      inviteCode: context.inviteCode || upstreamConfig.inviteCode,
      entryUrl: upstreamConfig.settings.entryUrl,
      officialSiteUrl: upstreamConfig.settings.officialSiteUrl,
      apiBase: upstreamConfig.settings.apiBase,
      upstreamSource: "qiulinyun",
    });
  },
  async query(context = {}) {
    const upstreamConfig = context.upstreamConfig;
    const record = context.record || {};
    return queryMalaAccount({
      label: "秋林云",
      token: record.token,
      email: record.email,
      entryUrl: record.entryUrl || upstreamConfig.settings.entryUrl,
      officialSiteUrl: record.upstreamSite || upstreamConfig.settings.officialSiteUrl,
      apiBase: record.apiBase || upstreamConfig.settings.apiBase,
      upstreamSource: "qiulinyun",
    });
  },
});
