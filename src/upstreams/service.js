"use strict";

const {
  ACTIVE_UPSTREAM_MODES,
  DEFAULT_AGGREGATE_TIMEOUT_SECONDS,
  getUpstreamConfig,
  loadSecurityState,
  normalizeAggregateTimeoutSeconds,
  RUNTIME_MODES,
} = require("../authStore");
const {
  appendUserHistory,
  getUserState,
  updateUserState,
} = require("../registrationStore");
const { getUpstreamModule } = require("./core/registry");

const registrationQueues = new Map();
const AGGREGATE_STORAGE_DELIMITER = "::";

function normalizeAggregateExecutionTimeoutMs(timeoutSeconds) {
  const parsed = Number.parseInt(timeoutSeconds, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return normalizeAggregateTimeoutSeconds(parsed, DEFAULT_AGGREGATE_TIMEOUT_SECONDS) * 1000;
}

function buildAggregateTargetKey(target = {}) {
  return target.storageKey || `${target.upstreamId || "upstream"}:${target.instanceNumber || 1}`;
}

function normalizeAggregateExecutionError(error) {
  if (error instanceof Error) {
    return error;
  }

  return new Error(`${error || "Unknown error."}`);
}

function createAggregateTimeoutError(timeoutSeconds) {
  const error = new Error(`聚合请求超过 ${timeoutSeconds} 秒，已跳过该实例。`);
  error.code = "AGGREGATE_TIMEOUT";
  return error;
}

async function collectAggregateExecutionResults(targets, executor, options = {}) {
  const orderedTargets = Array.isArray(targets) ? targets : [];
  const timeoutMs = normalizeAggregateExecutionTimeoutMs(options.timeoutSeconds);
  const timeoutSeconds =
    timeoutMs > 0
      ? Math.max(1, Math.ceil(timeoutMs / 1000))
      : normalizeAggregateTimeoutSeconds(undefined, DEFAULT_AGGREGATE_TIMEOUT_SECONDS);
  const successMap = new Map();
  const failureMap = new Map();
  const pendingEntries = new Map();

  orderedTargets.forEach((target) => {
    let wrappedPromise = null;
    wrappedPromise = Promise.resolve()
      .then(() => executor(target))
      .then(
        (value) => ({
          wrappedPromise,
          target,
          status: "fulfilled",
          value,
        }),
        (error) => ({
          wrappedPromise,
          target,
          status: "rejected",
          error: normalizeAggregateExecutionError(error),
        }),
      );
    pendingEntries.set(wrappedPromise, target);
  });

  const deadlineAt = timeoutMs > 0 ? Date.now() + timeoutMs : 0;

  while (pendingEntries.size > 0) {
    const pendingPromises = Array.from(pendingEntries.keys());
    if (pendingPromises.length === 0) {
      break;
    }

    let outcome = null;
    if (deadlineAt > 0) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      outcome = await Promise.race([
        ...pendingPromises,
        new Promise((resolve) => {
          setTimeout(() => resolve(null), remainingMs);
        }),
      ]);

      if (!outcome) {
        break;
      }
    } else {
      outcome = await Promise.race(pendingPromises);
    }

    pendingEntries.delete(outcome.wrappedPromise);

    if (outcome.status === "fulfilled") {
      successMap.set(buildAggregateTargetKey(outcome.target), {
        ...outcome.target,
        ...outcome.value,
      });
      continue;
    }

    failureMap.set(buildAggregateTargetKey(outcome.target), {
      ...outcome.target,
      error: outcome.error,
    });
  }

  if (pendingEntries.size > 0) {
    pendingEntries.forEach((target) => {
      failureMap.set(buildAggregateTargetKey(target), {
        ...target,
        error: createAggregateTimeoutError(timeoutSeconds),
      });
    });
  }

  return {
    targets: orderedTargets
      .map((target) => successMap.get(buildAggregateTargetKey(target)))
      .filter(Boolean),
    failures: orderedTargets
      .map((target) => failureMap.get(buildAggregateTargetKey(target)))
      .filter(Boolean),
    timedOut: pendingEntries.size > 0,
  };
}

function enqueueRegistration(queueKey, job) {
  const currentQueue = registrationQueues.get(queueKey) || Promise.resolve();
  const nextJob = currentQueue.then(job, job);
  registrationQueues.set(queueKey, nextJob.catch(() => undefined));
  return nextJob;
}

function resolveQueueKey(userKey, storageKey) {
  return `${userKey}:${storageKey}`;
}

function buildUpstreamStorageKey(upstreamId, instanceNumber = 1) {
  const normalizedInstanceNumber = Number.parseInt(instanceNumber, 10);
  if (!Number.isFinite(normalizedInstanceNumber) || normalizedInstanceNumber <= 1) {
    return upstreamId;
  }

  return `${upstreamId}${AGGREGATE_STORAGE_DELIMITER}${normalizedInstanceNumber}`;
}

function buildHistoryDetails(options = {}, upstreamId, storageKey) {
  const details = options.details && typeof options.details === "object" ? { ...options.details } : {};
  const instanceNumber = Number.parseInt(options.instanceNumber, 10);

  if (Number.isFinite(instanceNumber) && instanceNumber > 1) {
    details.aggregate = true;
    details.instanceNumber = instanceNumber;
  }

  if (storageKey && storageKey !== upstreamId) {
    details.storageKey = storageKey;
  }

  if (options.instanceLabel) {
    details.instanceLabel = options.instanceLabel;
  }

  return Object.keys(details).length > 0 ? details : null;
}

function normalizeInviteCode(inviteCode, upstreamConfig, record) {
  return (inviteCode || upstreamConfig?.inviteCode || record?.inviteCode || "").toString().trim();
}

function getRegistrationAgeMinutes(record, usage) {
  const referenceTime = usage?.accountCreatedAt || record?.accountCreatedAt || record?.createdAt || "";
  if (!referenceTime) {
    return null;
  }

  const timestamp = new Date(referenceTime).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return (Date.now() - timestamp) / 60000;
}

function normalizeSubscriptionUrlHost(value = "") {
  const source = (value || "").toString().trim();
  if (!source) {
    return "";
  }

  try {
    return new URL(source).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isIpAddressHost(host = "") {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test((host || "").toString().trim());
}

function shouldPreferUsageSubscriptionUrl(recordSubscribeUrl = "", usageSubscribeUrl = "") {
  const normalizedRecord = (recordSubscribeUrl || "").toString().trim();
  const normalizedUsage = (usageSubscribeUrl || "").toString().trim();
  if (!normalizedUsage) {
    return false;
  }
  if (!normalizedRecord) {
    return true;
  }

  const recordHost = normalizeSubscriptionUrlHost(normalizedRecord);
  const usageHost = normalizeSubscriptionUrlHost(normalizedUsage);
  if (!usageHost) {
    return false;
  }
  if (!recordHost) {
    return true;
  }
  if (recordHost === usageHost) {
    return normalizedUsage !== normalizedRecord;
  }
  if (isIpAddressHost(recordHost) && !isIpAddressHost(usageHost)) {
    return true;
  }
  if (!recordHost.includes("susnaillink") && usageHost.includes("susnaillink")) {
    return true;
  }

  return false;
}

function mergeRegistrationWithUsage(record, usage) {
  if (!record) {
    return null;
  }

  const recordSubscribeUrl = typeof record.subscribeUrl === "string" ? record.subscribeUrl.trim() : "";
  const usageSubscribeUrl = typeof usage?.subscribeUrl === "string" ? usage.subscribeUrl.trim() : "";
  const recordClientUrls =
    record?.clientUrls && typeof record.clientUrls === "object" && Object.keys(record.clientUrls).length > 0
      ? record.clientUrls
      : null;
  const usageClientUrls =
    usage?.clientUrls && typeof usage.clientUrls === "object" && Object.keys(usage.clientUrls).length > 0
      ? usage.clientUrls
      : null;
  const preferredSubscribeUrl = shouldPreferUsageSubscriptionUrl(recordSubscribeUrl, usageSubscribeUrl)
    ? usageSubscribeUrl
    : recordSubscribeUrl || usageSubscribeUrl || record.subscribeUrl;
  const preferredClientUrls = shouldPreferUsageSubscriptionUrl(
    (recordClientUrls?.universal || recordSubscribeUrl || "").toString(),
    (usageClientUrls?.universal || usageSubscribeUrl || "").toString(),
  )
    ? usageClientUrls || recordClientUrls || record.clientUrls
    : recordClientUrls || usageClientUrls || record.clientUrls;

  return {
    ...record,
    email: record.email || usage?.email || "",
    subscribeUrl: preferredSubscribeUrl,
    clientUrls: preferredClientUrls,
    upstreamSite: record.upstreamSite || usage?.upstreamSite || "",
    apiBase: record.apiBase || usage?.apiBase || "",
    entryUrl: record.entryUrl || usage?.entryUrl || "",
    detectorConfigUrl: record.detectorConfigUrl || usage?.detectorConfigUrl || "",
    upstreamSource: record.upstreamSource || usage?.upstreamSource || "",
    accountCreatedAt: usage?.accountCreatedAt || record.accountCreatedAt || "",
    expiredAt: usage?.expiredAt || record.expiredAt || "",
    lastUsageCheckAt: usage?.queriedAt || record.lastUsageCheckAt || "",
  };
}

function getUpstreamContext(upstreamId, upstreamConfig) {
  const module = getUpstreamModule(upstreamId);
  if (!module) {
    throw new Error(`Unknown upstream: ${upstreamId}`);
  }

  return {
    upstreamId,
    module,
    upstreamConfig,
  };
}

function upstreamSupportsRelayType(upstreamId, relayType) {
  if (!relayType) {
    return true;
  }

  const module = getUpstreamModule(upstreamId);
  const supportedTypes = Array.isArray(module?.manifest?.supportedTypes)
    ? module.manifest.supportedTypes
    : [];
  return supportedTypes.length === 0 || supportedTypes.includes(relayType);
}

function getEnabledOrderedUpstreamIds(state, relayType = "") {
  const orderedIds = Array.isArray(state.upstreamOrder)
    ? state.upstreamOrder.filter((upstreamId) => state.upstreams?.[upstreamId])
    : Object.keys(state.upstreams || {});

  return orderedIds.filter((upstreamId) => {
    if (state.upstreams?.[upstreamId]?.enabled === false) {
      return false;
    }

    if (!relayType) {
      return true;
    }

    return upstreamSupportsRelayType(upstreamId, relayType);
  });
}

async function getRuntimeCandidateUpstreamIds(relayType = "") {
  const state = await loadSecurityState();
  const enabledIds = getEnabledOrderedUpstreamIds(state, relayType);

  if (state.activeUpstreamMode !== ACTIVE_UPSTREAM_MODES.POLLING) {
    return state.activeUpstreamId ? [state.activeUpstreamId] : enabledIds.slice(0, 1);
  }

  return enabledIds;
}

async function getRuntimeAggregateTargets(relayType = "") {
  const state = await loadSecurityState();
  const enabledIds = getEnabledOrderedUpstreamIds(state, relayType);
  const counts = state.upstreamAggregation?.counts && typeof state.upstreamAggregation.counts === "object"
    ? state.upstreamAggregation.counts
    : {};
  const targets = [];

  enabledIds.forEach((upstreamId) => {
    const rawCopies = Number.parseInt(counts[upstreamId], 10);
    const copies = Number.isFinite(rawCopies) && rawCopies > 0 ? rawCopies : 0;
    if (copies <= 0) {
      return;
    }

    const upstreamLabel =
      state.upstreams?.[upstreamId]?.name ||
      getUpstreamModule(upstreamId)?.manifest?.label ||
      upstreamId;

    for (let instanceNumber = 1; instanceNumber <= copies; instanceNumber += 1) {
      targets.push({
        upstreamId,
        storageKey: buildUpstreamStorageKey(upstreamId, instanceNumber),
        instanceNumber,
        instanceLabel: copies > 1 ? `${upstreamLabel} #${instanceNumber}` : upstreamLabel,
      });
    }
  });

  return targets;
}

async function createRegistration(userKey, upstreamId, options = {}) {
  const storageKey = options.storageKey || upstreamId;
  const upstreamConfig = await getUpstreamConfig(upstreamId);
  if (!upstreamConfig || upstreamConfig.enabled === false) {
    throw new Error("Current upstream is disabled.");
  }

  const { module } = getUpstreamContext(upstreamId, upstreamConfig);
  const inviteCode = normalizeInviteCode(options.inviteCode, upstreamConfig, options.record);
  const result = await module.register({
    inviteCode,
    upstreamConfig,
    verbose: false,
    logger: console,
  });

  await updateUserState(userKey, storageKey, async (userState) => {
    userState.latestRegistration = result;
    userState.latestUsage = null;
    userState.history = [
      {
        action: "register",
        title: options.title || "已注册新的上游账号",
        message: options.message || "服务端已创建新的上游订阅账号。",
        mode: upstreamConfig.runtimeMode || "",
        decision: options.decision || "register",
        relayType: options.relayType || "",
        requestSource: options.requestSource || "",
        upstreamId: storageKey,
        registration: result,
        details: buildHistoryDetails(options, upstreamId, storageKey),
      },
      ...(Array.isArray(userState.history) ? userState.history : []),
    ];
  });

  return result;
}

async function saveUsageSnapshot(userKey, upstreamId, record, usage, options = {}) {
  const storageKey = options.storageKey || upstreamId;
  const mergedRecord = mergeRegistrationWithUsage(record, usage);
  const upstreamConfig = await getUpstreamConfig(upstreamId);

  await updateUserState(userKey, storageKey, async (userState) => {
    userState.latestRegistration = mergedRecord;
    userState.latestUsage = usage;
    userState.history = [
      {
        action: "usage_check",
        title: options.title || "已查询上游使用情况",
        message: options.message || "服务端已刷新当前上游账号的流量与到期信息。",
        mode: upstreamConfig?.runtimeMode || "",
        decision: options.decision || "",
        relayType: options.relayType || "",
        requestSource: options.requestSource || "",
        upstreamId: storageKey,
        usage,
        registration: mergedRecord,
        details: buildHistoryDetails(options, upstreamId, storageKey),
      },
      ...(Array.isArray(userState.history) ? userState.history : []),
    ];
  });

  return {
    latestRegistration: mergedRecord,
    latestUsage: usage,
  };
}

async function queryCurrentUsage(upstreamId, record) {
  if (!record || record.mock) {
    return null;
  }

  const upstreamConfig = await getUpstreamConfig(upstreamId);
  if (!upstreamConfig || upstreamConfig.enabled === false) {
    throw new Error("Current upstream is disabled.");
  }

  const { module } = getUpstreamContext(upstreamId, upstreamConfig);
  if (module.manifest?.capabilities?.supportsStatusQuery === false) {
    return null;
  }

  return module.query({
    record,
    upstreamConfig,
    verbose: false,
    logger: console,
  });
}

function evaluateSmartDecision(upstreamConfig, record, usage) {
  const thresholdPercent = upstreamConfig.trafficThresholdPercent;
  const ageLimitMinutes = upstreamConfig.maxRegistrationAgeMinutes;
  const ageMinutes = getRegistrationAgeMinutes(record, usage);

  if (ageLimitMinutes > 0 && ageMinutes !== null && ageMinutes >= ageLimitMinutes) {
    return {
      shouldRegister: true,
      decision: "expired",
      title: "上游账号已达到续期时间",
      message: `当前上游账号已使用 ${Math.floor(ageMinutes)} 分钟，超过设定的 ${ageLimitMinutes} 分钟，已准备重新注册。`,
      details: {
        ageMinutes: Number(ageMinutes.toFixed(2)),
        maxRegistrationAgeMinutes: ageLimitMinutes,
      },
    };
  }

  const remainingPercent =
    typeof usage?.remainingPercent === "number" ? usage.remainingPercent : null;
  if (remainingPercent !== null && remainingPercent < thresholdPercent) {
    return {
      shouldRegister: true,
      decision: "low-traffic",
      title: "上游剩余流量过低",
      message: `当前剩余流量 ${remainingPercent.toFixed(2)}%，低于阈值 ${thresholdPercent}%，已准备重新注册。`,
      details: {
        remainingPercent,
        trafficThresholdPercent: thresholdPercent,
      },
    };
  }

  return {
    shouldRegister: false,
    decision: "reuse",
    title: "继续复用当前上游账号",
    message:
      remainingPercent === null
        ? "当前无需重新注册，继续返回现有订阅内容。"
        : `当前剩余流量 ${remainingPercent.toFixed(2)}%，且未超过设定时长，继续复用现有账号。`,
    details: {
      remainingPercent,
      trafficThresholdPercent: thresholdPercent,
      ageMinutes: ageMinutes === null ? null : Number(ageMinutes.toFixed(2)),
      maxRegistrationAgeMinutes: ageLimitMinutes,
    },
  };
}

async function resolveViewState(userKey, upstreamId, options = {}) {
  const storageKey = options.storageKey || upstreamId;
  const upstreamConfig = await getUpstreamConfig(upstreamId);
  if (!upstreamConfig) {
    throw new Error("Current upstream does not exist.");
  }

  const currentState = await getUserState(userKey, storageKey);
  if (upstreamConfig.runtimeMode !== RUNTIME_MODES.SMART_USAGE) {
    return {
      runtimeMode: upstreamConfig.runtimeMode,
      upstreamConfig,
      userState: currentState,
      warning: "",
    };
  }

  const queueKey = resolveQueueKey(userKey, storageKey);
  return enqueueRegistration(queueKey, async () => {
    const initialState = await getUserState(userKey, storageKey);
    if (!initialState.latestRegistration) {
      await createRegistration(userKey, upstreamId, {
        ...options,
        storageKey,
        requestSource: "view",
        title: "管理页查看时自动初始化",
        message: "当前用户在此上游下还没有可用记录，已自动注册新的上游账号。",
      });

      return {
        runtimeMode: upstreamConfig.runtimeMode,
        upstreamConfig,
        userState: await getUserState(userKey, storageKey),
        warning: "",
      };
    }

    try {
      const usage = await queryCurrentUsage(upstreamId, initialState.latestRegistration);
      if (!usage) {
        return {
          runtimeMode: upstreamConfig.runtimeMode,
          upstreamConfig,
          userState: initialState,
          warning: "",
        };
      }

      const decision = evaluateSmartDecision(upstreamConfig, initialState.latestRegistration, usage);
      await saveUsageSnapshot(userKey, upstreamId, initialState.latestRegistration, usage, {
        ...options,
        storageKey,
        requestSource: "view",
        title: "管理页已刷新上游状态",
        message: decision.message,
        decision: decision.decision,
        details: decision.details,
      });

      if (decision.shouldRegister) {
        await createRegistration(userKey, upstreamId, {
          ...options,
          storageKey,
          requestSource: "view",
          title: decision.title,
          message: `${decision.message} 服务端已创建新的上游账号。`,
          decision: "register",
          details: decision.details,
          record: initialState.latestRegistration,
        });
      }

      return {
        runtimeMode: upstreamConfig.runtimeMode,
        upstreamConfig,
        userState: await getUserState(userKey, storageKey),
        warning: "",
      };
    } catch (error) {
      await appendUserHistory(userKey, storageKey, {
        action: "usage_check_failed",
        title: "管理页查询上游失败",
        message: error.message,
        mode: upstreamConfig.runtimeMode,
        requestSource: "view",
        registration: initialState.latestRegistration,
        details: buildHistoryDetails(options, upstreamId, storageKey),
      });

      return {
        runtimeMode: upstreamConfig.runtimeMode,
        upstreamConfig,
        userState: await getUserState(userKey, storageKey),
        warning: `上游查询失败，已返回本地缓存：${error.message}`,
      };
    }
  });
}

async function resolveRelayState(userKey, upstreamId, relayType, options = {}) {
  const storageKey = options.storageKey || upstreamId;
  const upstreamConfig = await getUpstreamConfig(upstreamId);
  if (!upstreamConfig) {
    throw new Error("Current upstream does not exist.");
  }

  const queueKey = resolveQueueKey(userKey, storageKey);
  return enqueueRegistration(queueKey, async () => {
    const initialState = await getUserState(userKey, storageKey);

    if (upstreamConfig.runtimeMode === RUNTIME_MODES.ALWAYS_REFRESH) {
      await createRegistration(userKey, upstreamId, {
        ...options,
        storageKey,
        requestSource: "relay",
        relayType,
        title: "兼容模式已重新注册",
        message: "客户端拉取订阅时，按兼容模式重新注册新的上游账号。",
      });

      return {
        runtimeMode: upstreamConfig.runtimeMode,
        upstreamConfig,
        userState: await getUserState(userKey, storageKey),
      };
    }

    if (!initialState.latestRegistration) {
      await createRegistration(userKey, upstreamId, {
        ...options,
        storageKey,
        requestSource: "relay",
        relayType,
        title: "首次拉取时自动初始化",
        message: "当前用户在此上游下没有可用记录，已自动注册新的上游账号。",
      });

      return {
        runtimeMode: upstreamConfig.runtimeMode,
        upstreamConfig,
        userState: await getUserState(userKey, storageKey),
      };
    }

    try {
      const usage = await queryCurrentUsage(upstreamId, initialState.latestRegistration);
      if (!usage) {
        await createRegistration(userKey, upstreamId, {
          ...options,
          storageKey,
          requestSource: "relay",
          relayType,
          title: "查询结果为空，已重新注册",
          message: "未能从上游取得当前账号状态，已回退为重新注册。",
          record: initialState.latestRegistration,
        });

        return {
          runtimeMode: upstreamConfig.runtimeMode,
          upstreamConfig,
          userState: await getUserState(userKey, storageKey),
        };
      }

      const decision = evaluateSmartDecision(upstreamConfig, initialState.latestRegistration, usage);
      await saveUsageSnapshot(userKey, upstreamId, initialState.latestRegistration, usage, {
        ...options,
        storageKey,
        requestSource: "relay",
        relayType,
        title: "客户端拉取前已查询上游状态",
        message: decision.message,
        decision: decision.decision,
        details: decision.details,
      });

      if (decision.shouldRegister) {
        await createRegistration(userKey, upstreamId, {
          ...options,
          storageKey,
          requestSource: "relay",
          relayType,
          title: decision.title,
          message: `${decision.message} 服务端已切换到新的上游账号。`,
          decision: "register",
          details: decision.details,
          record: initialState.latestRegistration,
        });
      } else {
        await appendUserHistory(userKey, storageKey, {
          action: "reuse_registration",
          title: "继续复用当前上游账号",
          message: decision.message,
          mode: upstreamConfig.runtimeMode,
          decision: decision.decision,
          relayType,
          requestSource: "relay",
          usage,
          registration: mergeRegistrationWithUsage(initialState.latestRegistration, usage),
          details: buildHistoryDetails(
            {
              ...options,
              details: decision.details,
            },
            upstreamId,
            storageKey,
          ),
        });
      }

      return {
        runtimeMode: upstreamConfig.runtimeMode,
        upstreamConfig,
        userState: await getUserState(userKey, storageKey),
      };
    } catch (error) {
      await appendUserHistory(userKey, storageKey, {
        action: "usage_check_failed",
        title: "客户端拉取前查询上游失败",
        message: error.message,
        mode: upstreamConfig.runtimeMode,
        relayType,
        requestSource: "relay",
        registration: initialState.latestRegistration,
        details: buildHistoryDetails(options, upstreamId, storageKey),
      });

      await createRegistration(userKey, upstreamId, {
        ...options,
        storageKey,
        requestSource: "relay",
        relayType,
        title: "查询失败，已重新注册",
        message: `当前上游查询失败，已回退为重新注册：${error.message}`,
        record: initialState.latestRegistration,
      });

      return {
        runtimeMode: upstreamConfig.runtimeMode,
        upstreamConfig,
        userState: await getUserState(userKey, storageKey),
      };
    }
  });
}

async function manualRegister(userKey, upstreamId, options = {}) {
  const storageKey = options.storageKey || upstreamId;
  const queueKey = resolveQueueKey(userKey, storageKey);
  const upstreamConfig = await getUpstreamConfig(upstreamId);
  if (!upstreamConfig) {
    throw new Error("Current upstream does not exist.");
  }

  return enqueueRegistration(queueKey, async () => {
    await createRegistration(userKey, upstreamId, {
      ...options,
      storageKey,
      inviteCode: options.inviteCode,
      requestSource: "manual",
      relayType: options.relayType || "",
      title: "管理页手动重新注册",
      message: "已根据管理页请求创建新的上游账号。",
      decision: "register",
    });

    return {
      runtimeMode: upstreamConfig.runtimeMode,
      upstreamConfig,
      userState: await getUserState(userKey, storageKey),
    };
  });
}

async function manualRegisterWithRuntime(userKey, options = {}) {
  const requestedRelayType = options.relayType || "";
  const candidateIds = options.upstreamId
    ? [options.upstreamId]
    : await getRuntimeCandidateUpstreamIds(requestedRelayType);
  let lastError = null;

  for (const upstreamId of candidateIds) {
    try {
      const result = await manualRegister(userKey, upstreamId, options);
      return {
        ...result,
        upstreamId,
      };
    } catch (error) {
      lastError = error;
      if (candidateIds.length > 1) {
        await appendUserHistory(userKey, upstreamId, {
          action: "polling_skip",
          title: "轮询模式跳过失败候选项",
          message: error.message,
          requestSource: "manual",
          relayType: requestedRelayType,
          details: {
            polling: true,
          },
        });
      }
    }
  }

  throw lastError || new Error("No available upstream.");
}

async function resolveAggregateViewStates(userKey, relayType = "", options = {}) {
  const targets = await getRuntimeAggregateTargets(relayType);
  return collectAggregateExecutionResults(
    targets,
    async (target) => resolveViewState(userKey, target.upstreamId, target),
    options,
  );
}

async function resolveAggregateRelayStates(userKey, relayType = "", options = {}) {
  const targets = await getRuntimeAggregateTargets(relayType);
  return collectAggregateExecutionResults(
    targets,
    async (target) => resolveRelayState(userKey, target.upstreamId, relayType, target),
    options,
  );
}

async function manualRegisterAggregateWithRuntime(userKey, options = {}) {
  const targets = await getRuntimeAggregateTargets(options.relayType || "");
  const { targets: results, failures } = await collectAggregateExecutionResults(
    targets,
    async (target) =>
      manualRegister(userKey, target.upstreamId, {
        ...options,
        ...target,
      }),
    {
      timeoutSeconds: options.timeoutSeconds,
    },
  );

  for (const failure of failures) {
    await appendUserHistory(userKey, failure.storageKey, {
      action: "aggregate_skip",
      title: "鑱氬悎妯″紡璺宠繃澶辫触瀹炰緥",
      message: failure.error?.message || "Unknown error.",
      requestSource: "manual",
      relayType: options.relayType || "",
      details: buildHistoryDetails(failure, failure.upstreamId, failure.storageKey),
    });
  }

  if (results.length === 0) {
    throw failures[0]?.error || new Error("No aggregate upstream succeeded.");
  }

  return {
    targets: results,
    failures,
  };
}

module.exports = {
  buildUpstreamStorageKey,
  getRuntimeAggregateTargets,
  getRuntimeCandidateUpstreamIds,
  manualRegister,
  manualRegisterAggregateWithRuntime,
  manualRegisterWithRuntime,
  mergeRegistrationWithUsage,
  queryCurrentUsage,
  resolveAggregateRelayStates,
  resolveAggregateViewStates,
  resolveRelayState,
  resolveViewState,
  upstreamSupportsRelayType,
};
