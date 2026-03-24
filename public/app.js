"use strict";

const loginView = document.querySelector("#loginView");
const dashboardView = document.querySelector("#dashboardView");
const loginForm = document.querySelector("#loginForm");
const loginUsername = document.querySelector("#loginUsername");
const loginPassword = document.querySelector("#loginPassword");
const registerForm = document.querySelector("#registerForm");
const upstreamForm = document.querySelector("#upstreamForm");
const systemForm = document.querySelector("#systemForm");
const passwordForm = document.querySelector("#passwordForm");
const logoutButton = document.querySelector("#logoutButton");
const reloadUpstreamsButton = document.querySelector("#reloadUpstreamsButton");

const statusBar = document.querySelector("#statusBar");
const linksList = document.querySelector("#linksList");
const emptyState = document.querySelector("#emptyState");
const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const subscriptionTab = document.querySelector("#subscriptionTab");
const logsTab = document.querySelector("#logsTab");
const upstreamsTab = document.querySelector("#upstreamsTab");
const systemTab = document.querySelector("#systemTab");
const userScopePanel = document.querySelector("#userScopePanel");

const userSwitcher = document.querySelector("#userSwitcher");
const upstreamSwitcher = document.querySelector("#upstreamSwitcher");
const usageGrid = document.querySelector("#usageGrid");
const usageEmptyState = document.querySelector("#usageEmptyState");
const historyList = document.querySelector("#historyList");
const historyEmptyState = document.querySelector("#historyEmptyState");
const providerSettingsFields = document.querySelector("#providerSettingsFields");

const metaEmail = document.querySelector("#metaEmail");
const metaPassword = document.querySelector("#metaPassword");
const metaInviteCode = document.querySelector("#metaInviteCode");
const metaCreatedAt = document.querySelector("#metaCreatedAt");
const metaAccountCreatedAt = document.querySelector("#metaAccountCreatedAt");
const metaExpiredAt = document.querySelector("#metaExpiredAt");
const metaUpstreamSite = document.querySelector("#metaUpstreamSite");

const activeUserLabel = document.querySelector("#activeUserLabel");
const activeUpstreamLabel = document.querySelector("#activeUpstreamLabel");
const modeDescription = document.querySelector("#modeDescription");
const registerInviteCodeInput = document.querySelector("#inviteCode");

const upstreamOverviewName = document.querySelector("#upstreamOverviewName");
const upstreamOverviewModule = document.querySelector("#upstreamOverviewModule");
const upstreamOverviewStatus = document.querySelector("#upstreamOverviewStatus");
const upstreamOverviewRemark = document.querySelector("#upstreamOverviewRemark");
const upstreamOverviewDescription = document.querySelector("#upstreamOverviewDescription");

const displayOriginInput = document.querySelector("#displayOrigin");
const upstreamNameInput = document.querySelector("#upstreamName");
const upstreamRemarkInput = document.querySelector("#upstreamRemark");
const upstreamEnabledInput = document.querySelector("#upstreamEnabled");
const upstreamInviteCodeInput = document.querySelector("#upstreamInviteCode");
const trafficThresholdInput = document.querySelector("#trafficThresholdPercent");
const maxRegistrationAgeInput = document.querySelector("#maxRegistrationAgeMinutes");
const subscriptionUpdateIntervalInput = document.querySelector("#subscriptionUpdateIntervalMinutes");

const loginButton = document.querySelector("#loginButton");
const registerButton = document.querySelector("#registerButton");
const saveUpstreamButton = document.querySelector("#saveUpstreamButton");
const saveSystemButton = document.querySelector("#saveSystemButton");
const savePasswordButton = document.querySelector("#savePasswordButton");

const protocolLabels = {
  universal: "通用订阅",
  clash: "Clash",
  shadowrocket: "Shadowrocket",
  surge: "Surge",
  quantumultx: "Quantumult X",
  "sing-box": "sing-box",
};

const state = {
  displayOrigin: "",
  users: [],
  upstreams: [],
  relayUrlsByUser: {},
  userSummaries: [],
  currentUserKey: "userA",
  activeUpstreamId: "",
  currentTab: "subscription",
};

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const helper = document.createElement("textarea");
  helper.value = value;
  helper.setAttribute("readonly", "readonly");
  helper.style.position = "absolute";
  helper.style.left = "-9999px";
  document.body.appendChild(helper);
  helper.select();
  document.execCommand("copy");
  document.body.removeChild(helper);
}

function setStatus(message, tone = "neutral") {
  if (!statusBar) {
    return;
  }

  statusBar.textContent = message;
  statusBar.className = `status-bar tone-${tone}`;
}

function clearStatus() {
  if (!statusBar) {
    return;
  }

  statusBar.className = "status-bar hidden";
  statusBar.textContent = "";
}

function toggleHidden(element, hidden) {
  if (!element || !element.classList) {
    return;
  }

  element.classList.toggle("hidden", hidden);
}

function setText(element, value) {
  if (element) {
    element.textContent = value;
  }
}

function setInputValue(element, value) {
  if (element) {
    element.value = value;
  }
}

function setCheckboxValue(element, value) {
  if (element) {
    element.checked = Boolean(value);
  }
}

function setLoading(button, loadingText, active) {
  if (!button) {
    return;
  }

  if (!button.dataset.defaultText) {
    button.dataset.defaultText = button.textContent;
  }

  button.disabled = active;
  button.textContent = active ? loadingText : button.dataset.defaultText;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (error) {
    payload = {};
  }

  if (!response.ok) {
    const nextError = new Error(payload.error || "Request failed.");
    nextError.status = response.status;
    throw nextError;
  }

  return payload;
}

async function storeBrowserCredential() {
  if (!window.PasswordCredential || !navigator.credentials?.store) {
    return;
  }

  const password = (loginPassword?.value || "").trim();
  if (!password) {
    return;
  }

  try {
    const credential = new PasswordCredential({
      id: (loginUsername?.value || "snail-panel").trim() || "snail-panel",
      password,
      name: "Snail Panel",
    });
    await navigator.credentials.store(credential);
  } catch (error) {
    // Ignore browser credential API failures and keep normal login flow.
  }
}

function activateTab(tabName) {
  state.currentTab = tabName;
  toggleHidden(subscriptionTab, tabName !== "subscription");
  toggleHidden(logsTab, tabName !== "logs");
  toggleHidden(upstreamsTab, tabName !== "upstreams");
  toggleHidden(systemTab, tabName !== "system");
  toggleHidden(userScopePanel, !["subscription", "logs"].includes(tabName));

  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabName);
  });
}

function showLogin() {
  toggleHidden(loginView, false);
  toggleHidden(dashboardView, true);
}

function showDashboard() {
  toggleHidden(loginView, true);
  toggleHidden(dashboardView, false);
  activateTab(state.currentTab || "subscription");
}

function getActiveUpstream() {
  return (
    state.upstreams.find((item) => item.id === state.activeUpstreamId) ||
    state.upstreams[0] || {
      id: state.activeUpstreamId,
      label: "主上游",
      moduleLabel: "snail-default",
      description: "",
      capabilities: {
        supportsStatusQuery: true,
        supportsInviteCode: true,
      },
      supportedTypes: Object.keys(protocolLabels),
      remark: "",
      active: true,
      config: {
        enabled: true,
        name: "主上游",
        remark: "",
        runtimeMode: "always_refresh",
        trafficThresholdPercent: 20,
        maxRegistrationAgeMinutes: 120,
        subscriptionUpdateIntervalMinutes: 30,
        inviteCode: "",
        settings: {},
      },
      settingFields: [],
    }
  );
}

function getCurrentUser() {
  return state.users.find((user) => user.key === state.currentUserKey) || state.users[0] || {
    key: "userA",
    label: "用户A",
  };
}

function formatDateTime(value) {
  if (!value) {
    return "暂无";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatBytes(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "暂无";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = value;
  let unitIndex = 0;

  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }

  return `${current.toFixed(current >= 100 || unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "暂无";
  }

  return `${value.toFixed(2)}%`;
}

function upstreamSupportsStatusQuery(upstream) {
  return upstream?.capabilities?.supportsStatusQuery !== false;
}

function upstreamSupportsInviteCode(upstream) {
  return upstream?.capabilities?.supportsInviteCode !== false;
}

function getSupportedProtocolTypes(upstream) {
  const supportedTypes = Array.isArray(upstream?.supportedTypes) ? upstream.supportedTypes : [];
  return supportedTypes.length > 0 ? supportedTypes : Object.keys(protocolLabels);
}

function describeMode(upstream) {
  const config = upstream?.config || {};
  const updateIntervalText = `${config.subscriptionUpdateIntervalMinutes ?? 30} 分钟自动更新`;
  if (!upstreamSupportsStatusQuery(upstream)) {
    return `当前上游未实现状态查询接口，仅支持兼容模式；下游订阅按 ${updateIntervalText}。`;
  }

  if (config.runtimeMode === "smart_usage") {
    const ageRule =
      Number(config.maxRegistrationAgeMinutes) > 0
        ? `，或账号年龄超过 ${config.maxRegistrationAgeMinutes} 分钟`
        : "";
    return `智能模式：仅在客户端拉取或管理查看时查询上游；当剩余流量低于 ${config.trafficThresholdPercent}%${ageRule} 时重新注册；下游订阅按 ${updateIntervalText}。`;
  }

  return `兼容模式：客户端每次拉取都会直接重新注册当前上游，不做查询判断；下游订阅按 ${updateIntervalText}。`;
}

function fillMeta(registration) {
  setText(metaEmail, registration?.email || "暂无");
  setText(metaPassword, registration?.password || "暂无");
  setText(metaInviteCode, registration?.inviteCode || "暂无");
  setText(metaCreatedAt, registration?.createdAt ? formatDateTime(registration.createdAt) : "暂无");
  setText(
    metaAccountCreatedAt,
    registration?.accountCreatedAt ? formatDateTime(registration.accountCreatedAt) : "暂无",
  );
  setText(metaExpiredAt, registration?.expiredAt ? formatDateTime(registration.expiredAt) : "暂无");
  setText(metaUpstreamSite, registration?.upstreamSite || registration?.entryUrl || "暂无");
}

function renderLinks(relayUrls, upstream = getActiveUpstream()) {
  if (!linksList) {
    return;
  }

  linksList.innerHTML = "";

  if (!relayUrls) {
    toggleHidden(emptyState, false);
    return;
  }

  toggleHidden(emptyState, true);

  getSupportedProtocolTypes(upstream).forEach((type) => {
    const label = protocolLabels[type] || type;
    const url = relayUrls[type];
    const card = document.createElement("article");
    card.className = "link-card";

    const head = document.createElement("div");
    head.className = "link-head";
    head.innerHTML = `<strong>${label}</strong><span>${type.toUpperCase()}</span>`;

    const input = document.createElement("input");
    input.className = "link-input";
    input.type = "text";
    input.readOnly = true;
    input.value = url || "";

    const foot = document.createElement("div");
    foot.className = "link-foot";

    const hint = document.createElement("small");
    hint.textContent = "固定链接，切换上游后仍保持不变";

    const button = document.createElement("button");
    button.className = "ghost-button small-button";
    button.type = "button";
    button.textContent = "复制";
    button.addEventListener("click", async () => {
      if (!url) {
        return;
      }

      await copyText(url);
      setStatus(`${label} 固定订阅链接已复制。`, "success");
    });

    foot.append(hint, button);
    card.append(head, input, foot);
    linksList.appendChild(card);
  });
}

function renderUsage(usage) {
  if (!usageGrid) {
    return;
  }

  usageGrid.innerHTML = "";

  if (!usage) {
    toggleHidden(usageEmptyState, false);
    return;
  }

  toggleHidden(usageEmptyState, true);

  const rows = [
    ["最近查询", formatDateTime(usage.queriedAt)],
    ["套餐", usage.planName || "暂无"],
    ["总流量", formatBytes(usage.transferEnable)],
    ["已用流量", formatBytes(usage.usedTotal)],
    ["剩余流量", formatBytes(usage.remainingTraffic)],
    ["剩余比例", formatPercent(usage.remainingPercent)],
    ["上游创建时间", formatDateTime(usage.accountCreatedAt)],
    ["到期时间", formatDateTime(usage.expiredAt)],
    ["最近登录", formatDateTime(usage.lastLoginAt)],
  ];

  rows.forEach(([label, value]) => {
    const card = document.createElement("article");
    card.className = "usage-card";
    card.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    usageGrid.appendChild(card);
  });
}

function buildHistoryMeta(entry) {
  const parts = [];

  if (entry.mode === "smart_usage") {
    parts.push("智能模式");
  } else if (entry.mode === "always_refresh") {
    parts.push("兼容模式");
  }

  if (entry.requestSource === "relay") {
    parts.push("客户端拉取");
  } else if (entry.requestSource === "view") {
    parts.push("管理查看");
  } else if (entry.requestSource === "manual") {
    parts.push("手动操作");
  }

  if (entry.decision === "register") {
    parts.push("已重新注册");
  } else if (entry.decision === "reuse") {
    parts.push("继续复用");
  } else if (entry.decision === "low-traffic") {
    parts.push("流量不足");
  } else if (entry.decision === "expired") {
    parts.push("达到过期时间");
  }

  if (entry.relayType) {
    parts.push(entry.relayType);
  }

  if (typeof entry.usage?.remainingPercent === "number") {
    parts.push(`剩余 ${entry.usage.remainingPercent.toFixed(2)}%`);
  }

  return parts.join(" · ");
}

function renderHistory(history) {
  if (!historyList) {
    return;
  }

  historyList.innerHTML = "";

  if (!Array.isArray(history) || history.length === 0) {
    toggleHidden(historyEmptyState, false);
    return;
  }

  toggleHidden(historyEmptyState, true);

  history.forEach((entry) => {
    const card = document.createElement("article");
    card.className = "history-item";

    const metaText = buildHistoryMeta(entry);
    const usageText =
      typeof entry.usage?.usedTotal === "number" && typeof entry.usage?.transferEnable === "number"
        ? `已用 ${formatBytes(entry.usage.usedTotal)} / 总量 ${formatBytes(entry.usage.transferEnable)}`
        : "";
    const registrationText = entry.registration?.createdAt
      ? `注册时间：${formatDateTime(entry.registration.createdAt)}`
      : "";

    card.innerHTML = `
      <div class="history-head">
        <strong>${entry.title || "状态更新"}</strong>
        <span>${formatDateTime(entry.timestamp)}</span>
      </div>
      <p>${entry.message || "暂无说明"}</p>
      <div class="history-meta">${[metaText, usageText, registrationText].filter(Boolean).join(" · ") || "暂无更多信息"}</div>
    `;

    historyList.appendChild(card);
  });
}

function renderUpstreamOverview(upstream) {
  const config = upstream?.config || {};
  const capabilitySummary = [];
  if (!upstreamSupportsStatusQuery(upstream)) {
    capabilitySummary.push("仅兼容模式");
  }
  if (!upstreamSupportsInviteCode(upstream)) {
    capabilitySummary.push("不支持邀请码");
  }
  if (Array.isArray(upstream?.supportedTypes) && upstream.supportedTypes.length > 0) {
    capabilitySummary.push(`支持 ${upstream.supportedTypes.join(", ")}`);
  }
  setText(upstreamOverviewName, upstream?.label || "主上游");
  setText(upstreamOverviewModule, upstream?.id || "snail-default");
  setText(upstreamOverviewStatus, config.enabled === false ? "已停用" : "启用中");
  setText(upstreamOverviewRemark, config.remark || upstream?.remark || "暂无备注");
  setText(
    upstreamOverviewDescription,
    [upstream?.description || "暂无说明", capabilitySummary.join(" · ")].filter(Boolean).join(" · "),
  );
}

function createProviderFieldControl(field, value) {
  if (field.type === "textarea") {
    const input = document.createElement("textarea");
    input.name = `provider_${field.key}`;
    input.dataset.providerKey = field.key;
    input.placeholder = field.placeholder || "";
    input.value = value ?? "";
    input.rows = 4;
    input.required = field.required === true;
    return input;
  }

  if (field.type === "select") {
    const input = document.createElement("select");
    input.name = `provider_${field.key}`;
    input.dataset.providerKey = field.key;
    input.required = field.required === true;

    if (!field.required) {
      const emptyOption = document.createElement("option");
      emptyOption.value = "";
      emptyOption.textContent = field.placeholder || "请选择";
      input.appendChild(emptyOption);
    }

    (Array.isArray(field.options) ? field.options : []).forEach((option) => {
      const optionElement = document.createElement("option");
      optionElement.value = option.value;
      optionElement.textContent = option.label || option.value;
      input.appendChild(optionElement);
    });
    input.value = value ?? "";
    return input;
  }

  if (field.type === "checkbox") {
    const wrapper = document.createElement("div");
    wrapper.className = "checkbox-row provider-checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = `provider_${field.key}`;
    input.dataset.providerKey = field.key;
    input.checked = Boolean(value);
    const text = document.createElement("span");
    text.textContent = field.label || field.key;
    wrapper.append(input, text);
    return wrapper;
  }

  const input = document.createElement("input");
  input.type = field.type === "password" ? "password" : field.type === "number" ? "number" : "text";
  input.name = `provider_${field.key}`;
  input.dataset.providerKey = field.key;
  input.placeholder = field.placeholder || "";
  input.value = value ?? "";
  input.required = field.required === true;

  if (field.type === "url") {
    input.inputMode = "url";
  }

  if (field.type === "number") {
    if (field.min !== null && field.min !== undefined) {
      input.min = String(field.min);
    }
    if (field.max !== null && field.max !== undefined) {
      input.max = String(field.max);
    }
    if (field.step !== null && field.step !== undefined) {
      input.step = String(field.step);
    }
  }

  return input;
}

function getProviderFieldValue(field, container) {
  if (field.type === "checkbox") {
    const checkbox = container?.querySelector("[data-provider-key]");
    return Boolean(checkbox?.checked);
  }

  const input = container?.querySelector("[data-provider-key]");
  return (input?.value || "").trim();
}

function renderProviderSettingsFields(upstream) {
  if (!providerSettingsFields) {
    return;
  }

  providerSettingsFields.innerHTML = "";
  const fields = Array.isArray(upstream?.settingFields) ? upstream.settingFields : [];
  const providerSettings = upstream?.config?.settings || {};

  fields.forEach((field) => {
    const label = document.createElement("label");
    label.className = "provider-field";
    const hasEmbeddedLabel = field.type === "checkbox";
    const value =
      providerSettings[field.key] === undefined ? field.defaultValue : providerSettings[field.key];

    if (!hasEmbeddedLabel) {
      const title = document.createElement("span");
      title.textContent = field.label || field.key;
      label.appendChild(title);
    }

    label.appendChild(createProviderFieldControl(field, value));

    if (field.description) {
      const description = document.createElement("small");
      description.textContent = field.description || "";
      label.appendChild(description);
    }

    providerSettingsFields.appendChild(label);
  });
}

function syncUpstreamForm() {
  const upstream = getActiveUpstream();
  const config = upstream.config || {};
  const supportsStatusQuery = upstreamSupportsStatusQuery(upstream);
  const supportsInviteCode = upstreamSupportsInviteCode(upstream);

  setText(activeUpstreamLabel, upstream.label || "主上游");
  setText(modeDescription, describeMode(upstream));
  renderUpstreamOverview(upstream);

  setInputValue(upstreamNameInput, config.name || upstream.label || "");
  setInputValue(upstreamRemarkInput, config.remark || "");
  setCheckboxValue(upstreamEnabledInput, config.enabled !== false);
  setInputValue(upstreamInviteCodeInput, config.inviteCode || "");
  setInputValue(trafficThresholdInput, config.trafficThresholdPercent ?? 20);
  setInputValue(maxRegistrationAgeInput, config.maxRegistrationAgeMinutes ?? 120);
  setInputValue(subscriptionUpdateIntervalInput, config.subscriptionUpdateIntervalMinutes ?? 30);

  if (upstreamInviteCodeInput) {
    upstreamInviteCodeInput.disabled = !supportsInviteCode;
    upstreamInviteCodeInput.placeholder = supportsInviteCode ? "可选" : "当前上游不支持邀请码";
  }
  if (registerInviteCodeInput) {
    registerInviteCodeInput.disabled = !supportsInviteCode;
    registerInviteCodeInput.placeholder = supportsInviteCode
      ? "可选，不填则使用当前上游默认邀请码"
      : "当前上游不支持邀请码";
  }

  const radio = upstreamForm?.querySelector(`input[name="runtimeMode"][value="${config.runtimeMode || "always_refresh"}"]`);
  if (radio) {
    radio.checked = true;
  }

  const smartUsageRadio = upstreamForm?.querySelector('input[name="runtimeMode"][value="smart_usage"]');
  const alwaysRefreshRadio = upstreamForm?.querySelector('input[name="runtimeMode"][value="always_refresh"]');
  if (smartUsageRadio) {
    smartUsageRadio.disabled = !supportsStatusQuery;
    if (!supportsStatusQuery && alwaysRefreshRadio) {
      alwaysRefreshRadio.checked = true;
    }
  }
  if (trafficThresholdInput) {
    trafficThresholdInput.disabled = !supportsStatusQuery;
  }
  if (maxRegistrationAgeInput) {
    maxRegistrationAgeInput.disabled = !supportsStatusQuery;
  }

  renderProviderSettingsFields(upstream);
}

function syncSystemForm() {
  setInputValue(displayOriginInput, state.displayOrigin || "");
}

function updateSummaryFromPayload(payload) {
  const currentUser = getCurrentUser();
  const nextSummary = {
    key: currentUser.key,
    label: currentUser.label,
    hasRegistration: Boolean(payload.registration),
    createdAt: payload.registration?.createdAt || "",
    updatedAt: payload.usage?.queriedAt || payload.registration?.createdAt || "",
    remainingPercent:
      typeof payload.usage?.remainingPercent === "number" ? payload.usage.remainingPercent : null,
    remainingTraffic:
      typeof payload.usage?.remainingTraffic === "number" ? payload.usage.remainingTraffic : null,
    transferEnable:
      typeof payload.usage?.transferEnable === "number" ? payload.usage.transferEnable : null,
    queriedAt: payload.usage?.queriedAt || "",
    lastAction: Array.isArray(payload.history) && payload.history[0] ? payload.history[0].title : "",
  };

  state.userSummaries = state.users.map((user) => {
    if (user.key === currentUser.key) {
      return nextSummary;
    }

    return (
      state.userSummaries.find((item) => item.key === user.key) || {
        key: user.key,
        label: user.label,
        hasRegistration: false,
        createdAt: "",
        updatedAt: "",
        remainingPercent: null,
        remainingTraffic: null,
        transferEnable: null,
        queriedAt: "",
        lastAction: "",
      }
    );
  });
}

function renderUserSwitcher() {
  if (!userSwitcher) {
    return;
  }

  userSwitcher.innerHTML = "";

  state.users.forEach((user) => {
    const summary = state.userSummaries.find((item) => item.key === user.key);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `scope-chip${user.key === state.currentUserKey ? " active" : ""}`;

    let note = "未初始化";
    if (summary?.hasRegistration && typeof summary.remainingPercent === "number") {
      note = `剩余 ${summary.remainingPercent.toFixed(2)}%`;
    } else if (summary?.hasRegistration) {
      note = "已有记录";
    }

    button.innerHTML = `<strong>${user.label}</strong><small>${note}</small>`;
    button.addEventListener("click", async () => {
      if (user.key === state.currentUserKey) {
        return;
      }

      state.currentUserKey = user.key;
      renderUserSwitcher();
      await loadUserState();
    });

    userSwitcher.appendChild(button);
  });
}

async function switchActiveUpstream(upstreamId) {
  clearStatus();

  try {
    await requestJson("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        activeUpstreamId: upstreamId,
      }),
    });

    await refreshSession();
    setStatus(`已切换到 ${getActiveUpstream().label}。下游固定订阅链接不会变化。`, "success");
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      setStatus("登录状态已失效，请重新输入密码。", "error");
      return;
    }

    setStatus(error.message, "error");
  }
}

function renderUpstreamSwitcher() {
  if (!upstreamSwitcher) {
    return;
  }

  const previousValue = upstreamSwitcher.value;
  upstreamSwitcher.innerHTML = "";

  state.upstreams.forEach((upstream) => {
    const modeText = upstream.config?.runtimeMode === "smart_usage" ? "智能模式" : "兼容模式";
    const statusText = upstream.config?.enabled === false ? "已停用" : modeText;
    const option = document.createElement("option");
    option.value = upstream.id;
    option.textContent = `${upstream.label} · ${statusText}`;
    upstreamSwitcher.appendChild(option);
  });

  const nextValue = state.upstreams.some((item) => item.id === state.activeUpstreamId)
    ? state.activeUpstreamId
    : previousValue;
  upstreamSwitcher.value = nextValue || state.activeUpstreamId || state.upstreams[0]?.id || "";
}

function applySession(payload) {
  state.displayOrigin = payload.displayOrigin || "";
  state.users = Array.isArray(payload.users) ? payload.users : [];
  state.upstreams = Array.isArray(payload.upstreams) ? payload.upstreams : [];
  state.relayUrlsByUser = payload.relayUrlsByUser || {};
  state.userSummaries = Array.isArray(payload.userSummaries) ? payload.userSummaries : [];
  state.activeUpstreamId = payload.activeUpstreamId || state.upstreams[0]?.id || "";

  if (!state.users.some((user) => user.key === state.currentUserKey)) {
    state.currentUserKey = payload.defaultUserKey || state.users[0]?.key || "userA";
  }

  setText(activeUserLabel, getCurrentUser().label);
  renderUpstreamSwitcher();
  renderUserSwitcher();
  syncUpstreamForm();
  syncSystemForm();
}

function applyUserPayload(payload) {
  const upstream = payload.upstream || getActiveUpstream();
  state.relayUrlsByUser[state.currentUserKey] =
    payload.relayUrls || state.relayUrlsByUser[state.currentUserKey] || {};

  setText(activeUserLabel, payload.user?.label || getCurrentUser().label);
  setText(activeUpstreamLabel, upstream.label || getActiveUpstream().label);
  setText(modeDescription, describeMode(upstream));

  fillMeta(payload.registration);
  renderLinks(payload.relayUrls || state.relayUrlsByUser[state.currentUserKey] || null, upstream);
  renderUsage(payload.usage);
  renderHistory(payload.history);
  updateSummaryFromPayload(payload);
  renderUserSwitcher();
}

async function loadUserState() {
  setText(activeUserLabel, getCurrentUser().label);
  setText(activeUpstreamLabel, getActiveUpstream().label);

  try {
    const payload = await requestJson(
      `/api/subscriptions/latest?type=full&user=${encodeURIComponent(state.currentUserKey)}&upstreamId=${encodeURIComponent(state.activeUpstreamId)}`,
    );

    applyUserPayload(payload);

    if (payload.warning) {
      setStatus(payload.warning, "warning");
      return;
    }

    clearStatus();
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      setStatus("登录状态已失效，请重新输入密码。", "error");
      return;
    }

    setStatus(error.message, "error");
  }
}

async function refreshSession() {
  try {
    const payload = await requestJson("/api/session", { method: "GET" });

    if (!payload.authenticated) {
      showLogin();
      clearStatus();
      return;
    }

    showDashboard();
    applySession(payload);
    await loadUserState();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearStatus();
    setLoading(loginButton, "登录中...", true);

    const formData = new FormData(loginForm);
    const password = (formData.get("password") || "").toString();

    try {
      await requestJson("/api/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });

      await storeBrowserCredential();
      setStatus("登录成功。", "success");
      await refreshSession();
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setLoading(loginButton, "登录中...", false);
    }
  });
}

if (registerForm) {
  registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearStatus();
    setLoading(registerButton, "处理中...", true);

    const formData = new FormData(registerForm);
    const inviteCode = upstreamSupportsInviteCode(getActiveUpstream())
      ? (formData.get("inviteCode") || "").toString().trim()
      : "";

    try {
      const payload = await requestJson("/api/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          type: "full",
          inviteCode,
          userKey: state.currentUserKey,
          upstreamId: state.activeUpstreamId,
        }),
      });

      applyUserPayload(payload);
      setStatus(`当前用户已在 ${getActiveUpstream().label} 下完成重新注册。`, "success");
    } catch (error) {
      if (error.status === 401) {
        showLogin();
        setStatus("登录状态已失效，请重新输入密码。", "error");
        return;
      }

      setStatus(error.message, "error");
    } finally {
      setLoading(registerButton, "处理中...", false);
    }
  });
}

if (upstreamForm) {
  upstreamForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearStatus();
    setLoading(saveUpstreamButton, "保存中...", true);

    const formData = new FormData(upstreamForm);
    const upstream = getActiveUpstream();
    const providerSettings = {};
    Array.from(upstream?.settingFields || []).forEach((field) => {
      const element = providerSettingsFields?.querySelector(`[data-provider-key="${field.key}"]`);
      const container = element?.closest(".provider-field");
      if (!container) {
        return;
      }

      providerSettings[field.key] = getProviderFieldValue(field, container);
    });

    try {
      await requestJson("/api/settings", {
        method: "POST",
        body: JSON.stringify({
          upstreamId: state.activeUpstreamId,
          name: (formData.get("name") || "").toString().trim(),
          remark: (formData.get("remark") || "").toString().trim(),
          enabled: upstreamEnabledInput?.checked,
          inviteCode: upstreamSupportsInviteCode(upstream)
            ? (formData.get("inviteCode") || "").toString().trim()
            : "",
          runtimeMode: (formData.get("runtimeMode") || "").toString(),
          trafficThresholdPercent: Number.parseInt(formData.get("trafficThresholdPercent"), 10),
          maxRegistrationAgeMinutes: Number.parseInt(formData.get("maxRegistrationAgeMinutes"), 10),
          subscriptionUpdateIntervalMinutes: Number.parseInt(
            formData.get("subscriptionUpdateIntervalMinutes"),
            10,
          ),
          providerSettings,
        }),
      });

      await refreshSession();
      setStatus("当前上游配置已更新。下游固定订阅链接未变化。", "success");
    } catch (error) {
      if (error.status === 401) {
        showLogin();
        setStatus("登录状态已失效，请重新输入密码。", "error");
        return;
      }

      setStatus(error.message, "error");
    } finally {
      setLoading(saveUpstreamButton, "保存中...", false);
    }
  });
}

if (systemForm) {
  systemForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearStatus();
    setLoading(saveSystemButton, "保存中...", true);

    const formData = new FormData(systemForm);

    try {
      await requestJson("/api/settings", {
        method: "POST",
        body: JSON.stringify({
          displayOrigin: (formData.get("displayOrigin") || "").toString().trim(),
        }),
      });

      await refreshSession();
      setStatus("系统设置已更新。", "success");
    } catch (error) {
      if (error.status === 401) {
        showLogin();
        setStatus("登录状态已失效，请重新输入密码。", "error");
        return;
      }

      setStatus(error.message, "error");
    } finally {
      setLoading(saveSystemButton, "保存中...", false);
    }
  });
}

if (passwordForm) {
  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearStatus();
    setLoading(savePasswordButton, "保存中...", true);

    const formData = new FormData(passwordForm);
    const currentPassword = (formData.get("currentPassword") || "").toString();
    const newPassword = (formData.get("newPassword") || "").toString();

    try {
      await requestJson("/api/password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });

      passwordForm.reset();
      setStatus("面板密码已更新。", "success");
    } catch (error) {
      if (error.status === 401) {
        showLogin();
        setStatus("登录状态已失效，请重新输入密码。", "error");
        return;
      }

      setStatus(error.message, "error");
    } finally {
      setLoading(savePasswordButton, "保存中...", false);
    }
  });
}

if (reloadUpstreamsButton) {
  reloadUpstreamsButton.addEventListener("click", async () => {
    clearStatus();
    setLoading(reloadUpstreamsButton, "重载中...", true);

    try {
      const payload = await requestJson("/api/upstreams/reload", { method: "POST" });
      await refreshSession();
      setStatus(
        Array.isArray(payload.diagnostics) && payload.diagnostics.length > 0
          ? `上游模块已重载，但有 ${payload.diagnostics.length} 个模块未通过校验。`
          : "上游模块已重新加载。",
        Array.isArray(payload.diagnostics) && payload.diagnostics.length > 0 ? "warning" : "success",
      );
    } catch (error) {
      if (error.status === 401) {
        showLogin();
        setStatus("登录状态已失效，请重新输入密码。", "error");
        return;
      }

      setStatus(error.message, "error");
    } finally {
      setLoading(reloadUpstreamsButton, "重载中...", false);
    }
  });
}

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    clearStatus();

    try {
      await requestJson("/api/logout", { method: "POST" });
      showLogin();
      fillMeta(null);
      renderLinks(null);
      renderUsage(null);
      renderHistory([]);
      setStatus("已退出登录。", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
}

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activateTab(button.dataset.tab);
  });
});

if (upstreamSwitcher) {
  upstreamSwitcher.addEventListener("change", async (event) => {
    const nextUpstreamId = event.target.value;
    if (!nextUpstreamId || nextUpstreamId === state.activeUpstreamId) {
      return;
    }

    await switchActiveUpstream(nextUpstreamId);
  });
}

refreshSession();
