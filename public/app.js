"use strict";

const loginView = document.querySelector("#loginView");
const dashboardView = document.querySelector("#dashboardView");
const loginForm = document.querySelector("#loginForm");
const registerForm = document.querySelector("#registerForm");
const passwordForm = document.querySelector("#passwordForm");
const settingsForm = document.querySelector("#settingsForm");
const logoutButton = document.querySelector("#logoutButton");
const reloadUpstreamsButton = document.querySelector("#reloadUpstreamsButton");
const statusBar = document.querySelector("#statusBar");
const linksList = document.querySelector("#linksList");
const emptyState = document.querySelector("#emptyState");
const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const subscriptionTab = document.querySelector("#subscriptionTab");
const logsTab = document.querySelector("#logsTab");
const settingsTab = document.querySelector("#settingsTab");
const sharedUpstreamPanel = document.querySelector("#sharedUpstreamPanel");
const sharedUserPanel = document.querySelector("#sharedUserPanel");
const userSwitcher = document.querySelector("#userSwitcher");
const upstreamSwitcher = document.querySelector("#upstreamSwitcher");
const usageGrid = document.querySelector("#usageGrid");
const usageEmptyState = document.querySelector("#usageEmptyState");
const historyList = document.querySelector("#historyList");
const historyEmptyState = document.querySelector("#historyEmptyState");

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
const settingsDescription = document.querySelector("#settingsDescription");
const displayOriginInput = document.querySelector("#displayOrigin");
const upstreamEnabledInput = document.querySelector("#upstreamEnabled");
const upstreamInviteCodeInput = document.querySelector("#upstreamInviteCode");
const trafficThresholdInput = document.querySelector("#trafficThresholdPercent");
const maxRegistrationAgeInput = document.querySelector("#maxRegistrationAgeMinutes");
const providerSettingsFields = document.querySelector("#providerSettingsFields");

const loginButton = document.querySelector("#loginButton");
const registerButton = document.querySelector("#registerButton");
const savePasswordButton = document.querySelector("#savePasswordButton");
const saveSettingsButton = document.querySelector("#saveSettingsButton");

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

function toggleHidden(element, shouldHide) {
  if (!element || !element.classList) {
    return;
  }

  element.classList.toggle("hidden", shouldHide);
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
    const error = new Error(payload.error || "Request failed.");
    error.status = response.status;
    throw error;
  }

  return payload;
}

function activateTab(tabName) {
  toggleHidden(subscriptionTab, tabName !== "subscription");
  toggleHidden(logsTab, tabName !== "logs");
  toggleHidden(settingsTab, tabName !== "settings");
  toggleHidden(sharedUserPanel, tabName === "settings");

  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabName);
  });
}

function syncStickyOffsets() {
  if (!sharedUserPanel) {
    return;
  }

  if (!sharedUpstreamPanel || window.innerWidth <= 720) {
    sharedUserPanel.style.top = "";
    return;
  }

  sharedUserPanel.style.top = `${sharedUpstreamPanel.offsetHeight + 26}px`;
}

function showLogin() {
  toggleHidden(loginView, false);
  toggleHidden(dashboardView, true);
}

function showDashboard() {
  toggleHidden(loginView, true);
  toggleHidden(dashboardView, false);
  activateTab("subscription");
}

function getActiveUpstream() {
  return (
    state.upstreams.find((item) => item.id === state.activeUpstreamId) ||
    state.upstreams[0] || {
      id: state.activeUpstreamId,
      label: "默认上游",
      description: "",
      config: {
        runtimeMode: "always_refresh",
        trafficThresholdPercent: 20,
        maxRegistrationAgeMinutes: 0,
        inviteCode: "",
        enabled: true,
        settings: {},
      },
      settingFields: [],
    }
  );
}

function findCurrentUser() {
  return state.users.find((user) => user.key === state.currentUserKey) || state.users[0] || {
    key: state.currentUserKey,
    label: "用户",
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

function describeMode(upstream) {
  const config = upstream?.config || {};
  if (config.runtimeMode === "smart_usage") {
    const ageText =
      Number(config.maxRegistrationAgeMinutes) > 0
        ? `，或账号年龄超过 ${config.maxRegistrationAgeMinutes} 分钟`
        : "";
    return `智能模式：仅在客户端拉取或管理查看时查询上游；当剩余流量低于 ${config.trafficThresholdPercent}%${ageText} 时重新注册。`;
  }

  return "兼容模式：客户端每次拉取订阅都会直接重新注册上游账号，不做查询判断。";
}

function selectRuntimeMode(runtimeMode) {
  if (!settingsForm) {
    return;
  }

  const radio = settingsForm.querySelector(`input[name="runtimeMode"][value="${runtimeMode}"]`);
  if (radio) {
    radio.checked = true;
  }
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

function renderLinks(relayUrls) {
  if (!linksList) {
    return;
  }

  linksList.innerHTML = "";

  if (!relayUrls) {
    toggleHidden(emptyState, false);
    return;
  }

  toggleHidden(emptyState, true);

  Object.entries(protocolLabels).forEach(([type, label]) => {
    const url = relayUrls[type];
    const item = document.createElement("article");
    item.className = "link-card";

    const head = document.createElement("div");
    head.className = "link-head";
    head.innerHTML = `<strong>${label}</strong><span>${type.toUpperCase()}</span>`;

    const input = document.createElement("input");
    input.className = "link-input";
    input.type = "text";
    input.readOnly = true;
    input.value = url || "";

    const button = document.createElement("button");
    button.className = "ghost-button";
    button.type = "button";
    button.textContent = "复制";
    button.addEventListener("click", async () => {
      if (!url) {
        return;
      }

      await copyText(url);
      setStatus(`${label} 链接已复制。`, "success");
    });

    item.append(head, input, button);
    linksList.appendChild(item);
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

  const cards = [
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

  cards.forEach(([label, value]) => {
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

  if (entry.relayType) {
    parts.push(entry.relayType);
  }

  if (entry.decision === "register") {
    parts.push("已重新注册");
  } else if (entry.decision === "reuse") {
    parts.push("继续复用");
  } else if (entry.decision === "low-traffic") {
    parts.push("流量不足");
  } else if (entry.decision === "expired") {
    parts.push("达到续期时间");
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
    const item = document.createElement("article");
    item.className = "history-item";

    const metaText = buildHistoryMeta(entry);
    const registrationTime = entry.registration?.createdAt
      ? `注册时间：${formatDateTime(entry.registration.createdAt)}`
      : "";
    const usageText =
      typeof entry.usage?.usedTotal === "number" && typeof entry.usage?.transferEnable === "number"
        ? `已用 ${formatBytes(entry.usage.usedTotal)} / 总量 ${formatBytes(entry.usage.transferEnable)}`
        : "";

    item.innerHTML = `
      <div class="history-head">
        <strong>${entry.title || "状态更新"}</strong>
        <span>${formatDateTime(entry.timestamp)}</span>
      </div>
      <p>${entry.message || "暂无说明"}</p>
      <div class="history-meta">${[metaText, registrationTime, usageText].filter(Boolean).join(" · ") || "暂无更多信息"}</div>
    `;
    historyList.appendChild(item);
  });
}

function updateSummaryFromPayload(payload) {
  const currentUser = findCurrentUser();
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
    button.className = `user-chip${user.key === state.currentUserKey ? " active" : ""}`;

    let note = "未初始化";
    if (summary?.hasRegistration && typeof summary.remainingPercent === "number") {
      note = `剩余 ${summary.remainingPercent.toFixed(2)}%`;
    } else if (summary?.hasRegistration) {
      note = "已注册";
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
      body: JSON.stringify({ activeUpstreamId: upstreamId }),
    });
    await refreshSession();
    setStatus(`已切换到 ${getActiveUpstream().label}。`, "success");
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

  upstreamSwitcher.innerHTML = "";

  state.upstreams.forEach((upstream) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `upstream-chip${upstream.id === state.activeUpstreamId ? " active" : ""}`;

    const modeText =
      upstream.config?.runtimeMode === "smart_usage" ? "智能模式" : "兼容模式";
    const statusText = upstream.config?.enabled === false ? "已停用" : modeText;

    button.innerHTML = `<strong>${upstream.label}</strong><small>${statusText}</small>`;
    button.addEventListener("click", async () => {
      if (upstream.id === state.activeUpstreamId) {
        return;
      }

      await switchActiveUpstream(upstream.id);
    });

    upstreamSwitcher.appendChild(button);
  });

  syncStickyOffsets();
}

function renderProviderSettingsFields(upstream) {
  if (!providerSettingsFields) {
    return;
  }

  providerSettingsFields.innerHTML = "";
  const fields = Array.isArray(upstream?.settingFields) ? upstream.settingFields : [];
  const providerSettings = upstream?.config?.settings || {};

  fields.forEach((field) => {
    const wrapper = document.createElement("label");
    wrapper.className = "provider-field";
    const title = document.createElement("span");
    title.textContent = field.label || field.key;

    const input = document.createElement("input");
    input.type = "text";
    input.name = `provider_${field.key}`;
    input.dataset.providerKey = field.key;
    input.placeholder = field.placeholder || "";
    input.value = providerSettings[field.key] || "";

    const description = document.createElement("small");
    description.textContent = field.description || "";

    wrapper.append(title, input, description);
    providerSettingsFields.appendChild(wrapper);
  });
}

function syncSettingsForm() {
  const upstream = getActiveUpstream();
  const config = upstream.config || {};

  setText(activeUpstreamLabel, upstream.label || "默认上游");
  setText(modeDescription, describeMode(upstream));
  setText(
    settingsDescription,
    `${upstream.label || "当前上游"} 的设置会直接影响固定服务器中转链接的实际行为。`,
  );

  setInputValue(displayOriginInput, state.displayOrigin || "");
  setCheckboxValue(upstreamEnabledInput, config.enabled !== false);
  setInputValue(upstreamInviteCodeInput, config.inviteCode || "");
  setInputValue(trafficThresholdInput, config.trafficThresholdPercent ?? 20);
  setInputValue(maxRegistrationAgeInput, config.maxRegistrationAgeMinutes ?? 0);
  selectRuntimeMode(config.runtimeMode || "always_refresh");
  renderProviderSettingsFields(upstream);
}

function applySession(payload) {
  state.displayOrigin = payload.displayOrigin || "";
  state.users = Array.isArray(payload.users) ? payload.users : [];
  state.upstreams = Array.isArray(payload.upstreams) ? payload.upstreams : [];
  state.relayUrlsByUser = payload.relayUrlsByUser || {};
  state.userSummaries = Array.isArray(payload.userSummaries) ? payload.userSummaries : [];
  state.activeUpstreamId = payload.activeUpstreamId || state.upstreams[0]?.id || "";

  const hasCurrentUser = state.users.some((user) => user.key === state.currentUserKey);
  if (!hasCurrentUser) {
    state.currentUserKey = payload.defaultUserKey || state.users[0]?.key || "userA";
  }

  setText(activeUserLabel, findCurrentUser().label);
  renderUpstreamSwitcher();
  renderUserSwitcher();
  syncSettingsForm();
}

function applyUserPayload(payload) {
  const upstream = payload.upstream || getActiveUpstream();
  if (upstream?.id) {
    state.activeUpstreamId = upstream.id;
  }

  state.relayUrlsByUser[state.currentUserKey] =
    payload.relayUrls || state.relayUrlsByUser[state.currentUserKey];

  setText(activeUserLabel, payload.user?.label || findCurrentUser().label);
  setText(activeUpstreamLabel, upstream?.label || getActiveUpstream().label);
  setText(modeDescription, describeMode(upstream));

  fillMeta(payload.registration);
  renderLinks(payload.relayUrls || state.relayUrlsByUser[state.currentUserKey] || null);
  renderUsage(payload.usage);
  renderHistory(payload.history);
  updateSummaryFromPayload(payload);
  renderUserSwitcher();
}

async function loadUserState() {
  const user = findCurrentUser();
  setText(activeUserLabel, user.label);
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
    const inviteCode = (formData.get("inviteCode") || "").toString().trim();

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
      setStatus(`${findCurrentUser().label} 已在 ${getActiveUpstream().label} 下完成重新注册。`, "success");
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

if (settingsForm) {
  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearStatus();
    setLoading(saveSettingsButton, "保存中...", true);

    const formData = new FormData(settingsForm);
    const providerSettings = {};
    Array.from(providerSettingsFields?.querySelectorAll("[data-provider-key]") || []).forEach((input) => {
      providerSettings[input.dataset.providerKey] = input.value.trim();
    });

    try {
      await requestJson("/api/settings", {
        method: "POST",
        body: JSON.stringify({
          displayOrigin: (formData.get("displayOrigin") || "").toString().trim(),
          upstreamId: state.activeUpstreamId,
          enabled: upstreamEnabledInput?.checked,
          inviteCode: (formData.get("inviteCode") || "").toString().trim(),
          runtimeMode: (formData.get("runtimeMode") || "").toString(),
          trafficThresholdPercent: Number.parseInt(formData.get("trafficThresholdPercent"), 10),
          maxRegistrationAgeMinutes: Number.parseInt(formData.get("maxRegistrationAgeMinutes"), 10),
          providerSettings,
        }),
      });

      await refreshSession();
      setStatus("当前上游设置已更新。", "success");
    } catch (error) {
      if (error.status === 401) {
        showLogin();
        setStatus("登录状态已失效，请重新输入密码。", "error");
        return;
      }

      setStatus(error.message, "error");
    } finally {
      setLoading(saveSettingsButton, "保存中...", false);
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
      await requestJson("/api/upstreams/reload", { method: "POST" });
      await refreshSession();
      setStatus("上游模块已重新加载。", "success");
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

window.addEventListener("resize", () => {
  syncStickyOffsets();
});

refreshSession();
