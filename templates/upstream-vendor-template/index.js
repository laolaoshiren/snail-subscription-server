"use strict";

// Copy this file into src/upstreams/vendors/<module-id>/index.js first.
const { defineUpstreamModule } = require("../../core/moduleContract");

module.exports = defineUpstreamModule({
  manifest: {
    id: "example-upstream",
    label: "示例上游",
    description: "把这个模板复制到 src/upstreams/vendors/<your-id>/index.js 后修改即可。",
    author: "Your Team",
    website: "https://example.com",
    docsUrl: "https://example.com/docs",
    supportedTypes: ["universal", "clash", "sing-box"],
    capabilities: {
      supportsStatusQuery: true,
      supportsInviteCode: true,
    },
    settingFields: [
      {
        key: "panelBaseUrl",
        label: "面板地址",
        type: "url",
        placeholder: "https://panel.example.com",
        description: "上游面板或 API 根地址。",
        required: true,
      },
      {
        key: "registerPath",
        label: "注册接口路径",
        type: "text",
        placeholder: "/api/register",
        description: "相对于面板地址的注册接口路径。",
        defaultValue: "/api/register",
      },
      {
        key: "statusPath",
        label: "状态接口路径",
        type: "text",
        placeholder: "/api/status",
        description: "相对于面板地址的状态查询接口路径。",
        defaultValue: "/api/status",
      },
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "可留空",
        description: "如果上游需要额外鉴权，可以在这里配置。",
      },
      {
        key: "allowInsecure",
        label: "允许不安全 TLS",
        type: "checkbox",
        description: "只有在上游证书不规范时才开启。",
        defaultValue: false,
      },
    ],
  },
  defaultConfig: {
    name: "示例上游",
    remark: "第三方模块模板",
    runtimeMode: "smart_usage",
    trafficThresholdPercent: 15,
    maxRegistrationAgeMinutes: 180,
    subscriptionUpdateIntervalMinutes: 30,
    inviteCode: "",
    settings: {
      panelBaseUrl: "",
      registerPath: "/api/register",
      statusPath: "/api/status",
      apiKey: "",
      allowInsecure: false,
    },
  },
  normalizeProviderSettings(settings = {}, { helpers }) {
    return {
      panelBaseUrl: helpers.normalizeString(settings.panelBaseUrl),
      registerPath: helpers.normalizeString(settings.registerPath) || "/api/register",
      statusPath: helpers.normalizeString(settings.statusPath) || "/api/status",
      apiKey: helpers.normalizeString(settings.apiKey),
      allowInsecure: helpers.normalizeBoolean(settings.allowInsecure, false),
    };
  },
  async register(context = {}) {
    const { upstreamConfig, inviteCode, helpers } = context;
    const settings = upstreamConfig.settings;

    // TODO: 在这里实现真实注册逻辑。
    // 下面是一个返回结构示例，字段名必须符合宿主标准。
    return helpers.createRegistrationRecord({
      email: "demo@example.com",
      password: "replace-with-real-password",
      inviteCode,
      token: "replace-with-real-token",
      clientUrls: {
        universal: `${settings.panelBaseUrl}/sub/demo`,
        clash: `${settings.panelBaseUrl}/sub/demo?target=clash`,
        "sing-box": `${settings.panelBaseUrl}/sub/demo?target=sing-box`,
      },
      upstreamSite: settings.panelBaseUrl,
      apiBase: settings.panelBaseUrl,
      upstreamSource: "custom-module",
    });
  },
  async query(context = {}) {
    const { record, helpers } = context;

    // TODO: 在这里实现真实状态查询逻辑。
    // 需要返回宿主可识别的流量 / 到期 / 客户端链接快照。
    return helpers.createUsageSnapshot({
      email: record.email,
      clientUrls: record.clientUrls,
      transferEnable: 50 * 1024 * 1024 * 1024,
      usedUpload: 3 * 1024 * 1024 * 1024,
      usedDownload: 7 * 1024 * 1024 * 1024,
      remainingTraffic: 40 * 1024 * 1024 * 1024,
      remainingPercent: 80,
      usagePercent: 20,
      expiredAt: "",
      accountCreatedAt: record.createdAt,
      upstreamSite: record.upstreamSite,
      apiBase: record.apiBase,
      upstreamSource: "custom-module",
    });
  },
});
