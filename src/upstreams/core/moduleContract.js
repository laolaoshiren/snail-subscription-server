"use strict";

const MODULE_API_VERSION = 1;
const DEFAULT_SUPPORTED_TYPES = Object.freeze([
  "universal",
  "clash",
  "shadowrocket",
  "surge",
  "quantumultx",
  "sing-box",
]);
const SUPPORTED_FIELD_TYPES = new Set([
  "text",
  "password",
  "url",
  "number",
  "textarea",
  "checkbox",
  "select",
]);
const DEFAULT_CAPABILITIES = Object.freeze({
  supportsStatusQuery: true,
  supportsInviteCode: true,
});
const DEFAULT_SHARED_CONFIG = Object.freeze({
  enabled: true,
  name: "",
  remark: "",
  runtimeMode: "always_refresh",
  trafficThresholdPercent: 20,
  maxRegistrationAgeMinutes: 120,
  subscriptionUpdateIntervalMinutes: 30,
  inviteCode: "",
  settings: {},
});

function normalizeString(value) {
  return (value || "").toString().trim();
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }

  return Boolean(value);
}

function normalizePositiveInteger(value, fallback, minimum = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(minimum, parsed);
}

function normalizePercentage(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, parsed));
}

function normalizeNumber(value, fallback = null) {
  if (value === "" || value === undefined || value === null) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed;
}

function uniqueTypes(types) {
  const seen = new Set();
  const result = [];
  types.forEach((type) => {
    if (!DEFAULT_SUPPORTED_TYPES.includes(type) || seen.has(type)) {
      return;
    }
    seen.add(type);
    result.push(type);
  });
  return result;
}

function normalizeSupportedTypes(types) {
  const source = Array.isArray(types) ? types.map((item) => normalizeString(item).toLowerCase()) : [];
  const normalized = uniqueTypes(source);
  if (normalized.length === 0) {
    return [...DEFAULT_SUPPORTED_TYPES];
  }

  if (!normalized.includes("universal")) {
    normalized.unshift("universal");
  }

  return uniqueTypes(normalized);
}

function normalizeFieldOptions(options) {
  if (!Array.isArray(options)) {
    return [];
  }

  return options
    .map((option) => {
      if (!option || typeof option !== "object") {
        return null;
      }

      const value = normalizeString(option.value);
      if (!value) {
        return null;
      }

      return {
        value,
        label: normalizeString(option.label) || value,
      };
    })
    .filter(Boolean);
}

function normalizeFieldDefaultValue(fieldType, value) {
  if (fieldType === "checkbox") {
    return Boolean(value);
  }

  if (fieldType === "number") {
    const parsed = normalizeNumber(value, null);
    return parsed === null ? "" : parsed;
  }

  return value === undefined || value === null ? "" : `${value}`;
}

function normalizeSettingField(field) {
  if (!field || typeof field !== "object") {
    return null;
  }

  const key = normalizeString(field.key);
  if (!key) {
    return null;
  }

  const type = SUPPORTED_FIELD_TYPES.has(field.type) ? field.type : "text";
  const options = type === "select" ? normalizeFieldOptions(field.options) : [];
  const fallbackOptionValue = options[0]?.value || "";
  const defaultValue =
    type === "select" && field.defaultValue === undefined
      ? fallbackOptionValue
      : normalizeFieldDefaultValue(type, field.defaultValue);

  return {
    key,
    label: normalizeString(field.label) || key,
    type,
    placeholder: normalizeString(field.placeholder),
    description: normalizeString(field.description),
    required: normalizeBoolean(field.required, false),
    defaultValue,
    min: field.min === undefined ? null : normalizeNumber(field.min, null),
    max: field.max === undefined ? null : normalizeNumber(field.max, null),
    step: field.step === undefined ? null : normalizeNumber(field.step, null),
    options,
  };
}

function normalizeCapabilities(rawCapabilities) {
  const source =
    rawCapabilities && typeof rawCapabilities === "object" ? rawCapabilities : DEFAULT_CAPABILITIES;

  return {
    supportsStatusQuery: source.supportsStatusQuery !== false,
    supportsInviteCode: source.supportsInviteCode !== false,
  };
}

function buildDefaultConfig(manifest, defaultConfig = {}) {
  const source = defaultConfig && typeof defaultConfig === "object" ? defaultConfig : {};
  const capabilities = manifest.capabilities;

  return {
    enabled: source.enabled !== false,
    name: normalizeString(source.name) || manifest.label,
    remark: normalizeString(source.remark),
    runtimeMode:
      capabilities.supportsStatusQuery && source.runtimeMode === "smart_usage"
        ? "smart_usage"
        : "always_refresh",
    trafficThresholdPercent: normalizePercentage(
      source.trafficThresholdPercent,
      DEFAULT_SHARED_CONFIG.trafficThresholdPercent,
    ),
    maxRegistrationAgeMinutes: normalizePositiveInteger(
      source.maxRegistrationAgeMinutes,
      DEFAULT_SHARED_CONFIG.maxRegistrationAgeMinutes,
      0,
    ),
    subscriptionUpdateIntervalMinutes: normalizePositiveInteger(
      source.subscriptionUpdateIntervalMinutes,
      DEFAULT_SHARED_CONFIG.subscriptionUpdateIntervalMinutes,
      1,
    ),
    inviteCode: capabilities.supportsInviteCode ? normalizeString(source.inviteCode) : "",
    settings: source.settings && typeof source.settings === "object" ? { ...source.settings } : {},
  };
}

function normalizeManifest(rawManifest) {
  if (!rawManifest || typeof rawManifest !== "object") {
    throw new Error("Module manifest must be an object.");
  }

  const id = normalizeString(rawManifest.id);
  if (!id) {
    throw new Error("Module manifest.id is required.");
  }

  const label = normalizeString(rawManifest.label);
  if (!label) {
    throw new Error(`Module ${id} manifest.label is required.`);
  }

  const capabilities = normalizeCapabilities(rawManifest.capabilities);

  return {
    apiVersion: MODULE_API_VERSION,
    id,
    label,
    description: normalizeString(rawManifest.description),
    website: normalizeString(rawManifest.website),
    docsUrl: normalizeString(rawManifest.docsUrl),
    author: normalizeString(rawManifest.author),
    supportedTypes: normalizeSupportedTypes(rawManifest.supportedTypes),
    capabilities,
    settingFields: Object.freeze(
      (Array.isArray(rawManifest.settingFields) ? rawManifest.settingFields : [])
        .map(normalizeSettingField)
        .filter(Boolean),
    ),
  };
}

function normalizeFieldValue(field, rawValue) {
  if (field.type === "checkbox") {
    return normalizeBoolean(rawValue, false);
  }

  if (field.type === "number") {
    const value = rawValue === undefined || rawValue === null ? "" : `${rawValue}`.trim();
    return value;
  }

  return rawValue === undefined || rawValue === null ? "" : `${rawValue}`.trim();
}

function normalizeProviderSettingsBySchema(settingFields, rawSettings = {}) {
  const source = rawSettings && typeof rawSettings === "object" ? rawSettings : {};
  const nextSettings = {};

  settingFields.forEach((field) => {
    const rawValue = Object.prototype.hasOwnProperty.call(source, field.key)
      ? source[field.key]
      : field.defaultValue;
    nextSettings[field.key] = normalizeFieldValue(field, rawValue);
  });

  return nextSettings;
}

function normalizeSharedConfig(source, manifest, defaultConfig, providerSettings) {
  return {
    enabled: source.enabled !== false,
    name: normalizeString(source.name) || defaultConfig.name || manifest.label,
    remark: normalizeString(source.remark),
    runtimeMode:
      manifest.capabilities.supportsStatusQuery && source.runtimeMode === "smart_usage"
        ? "smart_usage"
        : "always_refresh",
    trafficThresholdPercent: normalizePercentage(
      source.trafficThresholdPercent,
      defaultConfig.trafficThresholdPercent,
    ),
    maxRegistrationAgeMinutes: normalizePositiveInteger(
      source.maxRegistrationAgeMinutes,
      defaultConfig.maxRegistrationAgeMinutes,
      0,
    ),
    subscriptionUpdateIntervalMinutes: normalizePositiveInteger(
      source.subscriptionUpdateIntervalMinutes,
      defaultConfig.subscriptionUpdateIntervalMinutes,
      1,
    ),
    inviteCode: manifest.capabilities.supportsInviteCode ? normalizeString(source.inviteCode) : "",
    settings: providerSettings,
  };
}

function normalizeClientUrls(clientUrls, supportedTypes, subscribeUrl) {
  const source = clientUrls && typeof clientUrls === "object" ? clientUrls : {};
  const normalized = {};

  supportedTypes.forEach((type) => {
    const value = normalizeString(source[type]);
    if (value) {
      normalized[type] = value;
    }
  });

  if (!normalized.universal && subscribeUrl) {
    normalized.universal = subscribeUrl;
  }

  return normalized;
}

function ensureUniversalUrl(clientUrls, moduleId) {
  if (!clientUrls.universal) {
    throw new Error(`Module ${moduleId} register() result must include clientUrls.universal or subscribeUrl.`);
  }
}

function createRegistrationRecord(input = {}, manifest) {
  if (!input || typeof input !== "object") {
    throw new Error(`Module ${manifest.id} register() result must be an object.`);
  }

  const subscribeUrl = normalizeString(input.subscribeUrl);
  const clientUrls = normalizeClientUrls(input.clientUrls, manifest.supportedTypes, subscribeUrl);
  ensureUniversalUrl(clientUrls, manifest.id);

  return {
    email: normalizeString(input.email),
    password: normalizeString(input.password),
    inviteCode: normalizeString(input.inviteCode),
    token: normalizeString(input.token),
    subscribeUrl: clientUrls.universal,
    clientUrls,
    createdAt: normalizeString(input.createdAt) || new Date().toISOString(),
    accountCreatedAt: normalizeString(input.accountCreatedAt),
    expiredAt: normalizeString(input.expiredAt),
    mock: Boolean(input.mock),
    upstreamSite: normalizeString(input.upstreamSite),
    apiBase: normalizeString(input.apiBase),
    entryUrl: normalizeString(input.entryUrl),
    detectorConfigUrl: normalizeString(input.detectorConfigUrl),
    upstreamSource: normalizeString(input.upstreamSource),
  };
}

function createUsageSnapshot(input = {}, manifest) {
  if (!input || typeof input !== "object") {
    throw new Error(`Module ${manifest.id} query() result must be an object.`);
  }

  const subscribeUrl = normalizeString(input.subscribeUrl);
  const clientUrls = normalizeClientUrls(input.clientUrls, manifest.supportedTypes, subscribeUrl);
  const usedUpload = normalizeNumber(input.usedUpload, 0) || 0;
  const usedDownload = normalizeNumber(input.usedDownload, 0) || 0;
  const usedTotal = normalizeNumber(input.usedTotal, usedUpload + usedDownload);
  const transferEnable = normalizeNumber(input.transferEnable, 0) || 0;
  const remainingTraffic = normalizeNumber(
    input.remainingTraffic,
    Math.max(transferEnable - usedTotal, 0),
  );
  const remainingPercent = normalizeNumber(
    input.remainingPercent,
    transferEnable > 0 ? Number(((remainingTraffic / transferEnable) * 100).toFixed(2)) : 0,
  );
  const usagePercent = normalizeNumber(
    input.usagePercent,
    transferEnable > 0 ? Number(((usedTotal / transferEnable) * 100).toFixed(2)) : 0,
  );

  return {
    queriedAt: normalizeString(input.queriedAt) || new Date().toISOString(),
    email: normalizeString(input.email),
    subscribeUrl: clientUrls.universal || "",
    clientUrls,
    planId: input.planId ?? null,
    planName: normalizeString(input.planName),
    resetDay: input.resetDay ?? null,
    expiredAt: normalizeString(input.expiredAt),
    accountCreatedAt: normalizeString(input.accountCreatedAt),
    lastLoginAt: normalizeString(input.lastLoginAt),
    transferEnable,
    usedUpload,
    usedDownload,
    usedTotal,
    remainingTraffic,
    remainingPercent,
    usagePercent,
    stat: input.stat ?? null,
    upstreamSite: normalizeString(input.upstreamSite),
    apiBase: normalizeString(input.apiBase),
    entryUrl: normalizeString(input.entryUrl),
    detectorConfigUrl: normalizeString(input.detectorConfigUrl),
    upstreamSource: normalizeString(input.upstreamSource),
  };
}

function buildHelpers(manifest, defaultConfig) {
  return {
    MODULE_API_VERSION,
    DEFAULT_SUPPORTED_TYPES,
    normalizeString,
    normalizeBoolean,
    normalizePositiveInteger,
    normalizePercentage,
    normalizeNumber,
    normalizeProviderSettingsBySchema(rawSettings) {
      return normalizeProviderSettingsBySchema(manifest.settingFields, rawSettings);
    },
    createRegistrationRecord(input) {
      return createRegistrationRecord(input, manifest);
    },
    createUsageSnapshot(input) {
      return createUsageSnapshot(input, manifest);
    },
    getDefaultConfig() {
      return JSON.parse(JSON.stringify(defaultConfig));
    },
  };
}

function defineUpstreamModule(definition = {}) {
  const manifest = normalizeManifest(definition.manifest);
  const defaultConfig = buildDefaultConfig(manifest, definition.defaultConfig);
  manifest.defaultConfig = Object.freeze(JSON.parse(JSON.stringify(defaultConfig)));
  const helpers = buildHelpers(manifest, defaultConfig);

  if (typeof definition.register !== "function") {
    throw new Error(`Module ${manifest.id} must provide register().`);
  }

  if (manifest.capabilities.supportsStatusQuery && typeof definition.query !== "function") {
    throw new Error(`Module ${manifest.id} must provide query() when supportsStatusQuery=true.`);
  }

  function normalizeSettings(raw = {}) {
    const source = raw && typeof raw === "object" ? raw : {};
    const normalizedBySchema = helpers.normalizeProviderSettingsBySchema(source.settings);
    const providerSettings =
      typeof definition.normalizeProviderSettings === "function"
        ? definition.normalizeProviderSettings({ ...normalizedBySchema }, {
            manifest,
            defaultConfig,
            helpers,
          }) || normalizedBySchema
        : normalizedBySchema;

    return normalizeSharedConfig(source, manifest, defaultConfig, providerSettings);
  }

  function applySettingsPatch(currentConfig = {}, patch = {}) {
    const providerSettingsPatch =
      patch.providerSettings && typeof patch.providerSettings === "object"
        ? patch.providerSettings
        : {};

    const nextRawConfig = {
      ...(currentConfig && typeof currentConfig === "object" ? currentConfig : {}),
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.remark === undefined ? {} : { remark: patch.remark }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.inviteCode === undefined ? {} : { inviteCode: patch.inviteCode }),
      ...(patch.runtimeMode === undefined ? {} : { runtimeMode: patch.runtimeMode }),
      ...(patch.trafficThresholdPercent === undefined
        ? {}
        : { trafficThresholdPercent: patch.trafficThresholdPercent }),
      ...(patch.maxRegistrationAgeMinutes === undefined
        ? {}
        : { maxRegistrationAgeMinutes: patch.maxRegistrationAgeMinutes }),
      ...(patch.subscriptionUpdateIntervalMinutes === undefined
        ? {}
        : { subscriptionUpdateIntervalMinutes: patch.subscriptionUpdateIntervalMinutes }),
      settings: {
        ...((currentConfig && currentConfig.settings) || {}),
        ...providerSettingsPatch,
      },
    };

    return normalizeSettings(nextRawConfig);
  }

  async function register(context = {}) {
    const result = await definition.register({
      ...context,
      upstreamConfig: normalizeSettings(context.upstreamConfig || defaultConfig),
      manifest,
      helpers,
    });

    return helpers.createRegistrationRecord(result);
  }

  async function query(context = {}) {
    if (!manifest.capabilities.supportsStatusQuery) {
      return null;
    }

    const result = await definition.query({
      ...context,
      upstreamConfig: normalizeSettings(context.upstreamConfig || defaultConfig),
      manifest,
      helpers,
    });

    if (!result) {
      return null;
    }

    return helpers.createUsageSnapshot(result);
  }

  return Object.freeze({
    manifest: Object.freeze(manifest),
    normalizeSettings,
    applySettingsPatch,
    register,
    query,
  });
}

module.exports = {
  DEFAULT_CAPABILITIES,
  DEFAULT_SHARED_CONFIG,
  DEFAULT_SUPPORTED_TYPES,
  MODULE_API_VERSION,
  createRegistrationRecord,
  createUsageSnapshot,
  defineUpstreamModule,
  normalizeBoolean,
  normalizeFieldOptions,
  normalizeNumber,
  normalizePercentage,
  normalizePositiveInteger,
  normalizeProviderSettingsBySchema,
  normalizeSettingField,
  normalizeString,
};
