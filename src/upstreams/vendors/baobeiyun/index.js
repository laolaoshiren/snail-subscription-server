"use strict";

const { defineUpstreamModule } = require("../../core/moduleContract");
const {
  DEFAULT_BAOBEI_COOKIE,
  queryBaobeiAccount,
  registerBaobeiAccount,
} = require("../../shared/baobeiApi");

const DEFAULT_ENTRY_URL = "https://web1.bby004.com";
const DEFAULT_SITE_URL = "https://user2.bby012.com";
const DEFAULT_API_HOSTS = [
  "https://api3.345119.xyz",
  "https://3.115.134.89",
  "https://api.345110.xyz",
].join("\n");

module.exports = defineUpstreamModule({
  manifest: {
    id: "baobeiyun",
    label: "宝贝云",
    description: "入口门控型标准面板，当前需要入口 Cookie、邮箱验证码和验证码校验。",
    website: "https://web1.bby004.com",
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
        description: "需先从入口页进入才能拿到访问 Cookie。",
      },
      {
        key: "officialSiteUrl",
        label: "面板地址",
        type: "url",
        placeholder: DEFAULT_SITE_URL,
        description: "最终前端面板地址。",
      },
      {
        key: "apiHosts",
        label: "API 候选",
        type: "textarea",
        placeholder: DEFAULT_API_HOSTS,
        description: "每行一个 API 主机，程序会自动选可用入口。",
      },
      {
        key: "accessCookie",
        label: "入口 Cookie",
        type: "text",
        placeholder: DEFAULT_BAOBEI_COOKIE,
        description: "入口页放行后返回的访问 Cookie。",
      },
    ],
  },
  defaultConfig: {
    name: "宝贝云",
    remark: "注册送 2 小时 5G",
    runtimeMode: "always_refresh",
    trafficThresholdPercent: 20,
    maxRegistrationAgeMinutes: 120,
    subscriptionUpdateIntervalMinutes: 30,
    inviteCode: "C5D297oX",
    settings: {
      entryUrl: DEFAULT_ENTRY_URL,
      officialSiteUrl: DEFAULT_SITE_URL,
      apiHosts: DEFAULT_API_HOSTS,
      accessCookie: DEFAULT_BAOBEI_COOKIE,
    },
  },
  normalizeProviderSettings(settings = {}, { helpers }) {
    return {
      entryUrl: helpers.normalizeString(settings.entryUrl) || DEFAULT_ENTRY_URL,
      officialSiteUrl: helpers.normalizeString(settings.officialSiteUrl) || DEFAULT_SITE_URL,
      apiHosts: helpers.normalizeString(settings.apiHosts) || DEFAULT_API_HOSTS,
      accessCookie: helpers.normalizeString(settings.accessCookie) || DEFAULT_BAOBEI_COOKIE,
    };
  },
  async register(context = {}) {
    const upstreamConfig = context.upstreamConfig;
    return registerBaobeiAccount({
      label: "宝贝云",
      inviteCode: context.inviteCode || upstreamConfig.inviteCode,
      entryUrl: upstreamConfig.settings.entryUrl,
      officialSiteUrl: upstreamConfig.settings.officialSiteUrl,
      apiHosts: upstreamConfig.settings.apiHosts,
      accessCookie: upstreamConfig.settings.accessCookie,
      upstreamSource: "baobeiyun",
    });
  },
  async query(context = {}) {
    const upstreamConfig = context.upstreamConfig;
    const record = context.record || {};
    return queryBaobeiAccount({
      label: "宝贝云",
      token: record.token,
      email: record.email,
      entryUrl: record.entryUrl || upstreamConfig.settings.entryUrl,
      officialSiteUrl: record.upstreamSite || upstreamConfig.settings.officialSiteUrl,
      apiBase: record.apiBase || "",
      apiHosts: upstreamConfig.settings.apiHosts,
      accessCookie: upstreamConfig.settings.accessCookie,
      upstreamSource: "baobeiyun",
    });
  },
});
