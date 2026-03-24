"use strict";

const { defineUpstreamModule } = require("../../core/moduleContract");
const {
  queryTopmanAccount,
  registerTopmanAccount,
} = require("../../shared/topmanApi");

const DEFAULT_ENTRY_URL = "https://aooc.cc/";
const DEFAULT_SITE_URL = "https://jooy.cc";
const DEFAULT_API_BASE = "https://zz.topmang.com";
const DEFAULT_SECURITY_PASSWORD = "fgjhfdkjdt6i8865";

module.exports = defineUpstreamModule({
  manifest: {
    id: "topman",
    label: "拓扑门",
    description: "Buddy 主题 + 加密 API 面板，当前注册时要求站内验证码。",
    website: "https://jooy.cc",
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
        description: "广告落地入口地址。",
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
        description: "拓扑门加密 API 根地址。",
      },
      {
        key: "securityPassword",
        label: "加密密码",
        type: "text",
        placeholder: DEFAULT_SECURITY_PASSWORD,
        description: "前端 config.js 中的 API 加密密码。",
      },
      {
        key: "encryptResponse",
        label: "加密响应",
        type: "checkbox",
        description: "启用后按站点加密逻辑自动解密响应。",
        defaultValue: true,
      },
    ],
  },
  defaultConfig: {
    name: "拓扑门",
    remark: "免费计划，可自动识别配置",
    runtimeMode: "always_refresh",
    trafficThresholdPercent: 20,
    maxRegistrationAgeMinutes: 120,
    subscriptionUpdateIntervalMinutes: 30,
    inviteCode: "",
    settings: {
      entryUrl: DEFAULT_ENTRY_URL,
      officialSiteUrl: DEFAULT_SITE_URL,
      apiBase: DEFAULT_API_BASE,
      securityPassword: DEFAULT_SECURITY_PASSWORD,
      encryptResponse: true,
    },
  },
  normalizeProviderSettings(settings = {}, { helpers }) {
    return {
      entryUrl: helpers.normalizeString(settings.entryUrl) || DEFAULT_ENTRY_URL,
      officialSiteUrl: helpers.normalizeString(settings.officialSiteUrl) || DEFAULT_SITE_URL,
      apiBase: helpers.normalizeString(settings.apiBase) || DEFAULT_API_BASE,
      securityPassword: helpers.normalizeString(settings.securityPassword) || DEFAULT_SECURITY_PASSWORD,
      encryptResponse: settings.encryptResponse !== false,
    };
  },
  async register(context = {}) {
    const upstreamConfig = context.upstreamConfig;
    return registerTopmanAccount({
      label: "拓扑门",
      inviteCode: context.inviteCode || upstreamConfig.inviteCode,
      entryUrl: upstreamConfig.settings.entryUrl,
      officialSiteUrl: upstreamConfig.settings.officialSiteUrl,
      apiBase: upstreamConfig.settings.apiBase,
      securityPassword: upstreamConfig.settings.securityPassword,
      encryptResponse: upstreamConfig.settings.encryptResponse,
      upstreamSource: "topman",
    });
  },
  async query(context = {}) {
    const upstreamConfig = context.upstreamConfig;
    const record = context.record || {};
    return queryTopmanAccount({
      label: "拓扑门",
      token: record.token,
      email: record.email,
      entryUrl: record.entryUrl || upstreamConfig.settings.entryUrl,
      officialSiteUrl: record.upstreamSite || upstreamConfig.settings.officialSiteUrl,
      apiBase: record.apiBase || upstreamConfig.settings.apiBase,
      securityPassword: upstreamConfig.settings.securityPassword,
      encryptResponse: upstreamConfig.settings.encryptResponse,
      upstreamSource: "topman",
    });
  },
});
