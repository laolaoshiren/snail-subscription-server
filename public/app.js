"use strict";

const loginView = document.querySelector("#loginView");
const dashboardView = document.querySelector("#dashboardView");
const loginForm = document.querySelector("#loginForm");
const registerForm = document.querySelector("#registerForm");
const passwordForm = document.querySelector("#passwordForm");
const settingsForm = document.querySelector("#settingsForm");
const logoutButton = document.querySelector("#logoutButton");
const statusBar = document.querySelector("#statusBar");
const linksList = document.querySelector("#linksList");
const emptyState = document.querySelector("#emptyState");
const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const subscriptionTab = document.querySelector("#subscriptionTab");
const logsTab = document.querySelector("#logsTab");
const settingsTab = document.querySelector("#settingsTab");
const userSwitcher = document.querySelector("#userSwitcher");
const usageGrid = document.querySelector("#usageGrid");
const usageEmptyState = document.querySelector("#usageEmptyState");
const historyList = document.querySelector("#historyList");
const historyEmptyState = document.querySelector("#historyEmptyState");

const metaEmail = document.querySelector("#metaEmail");
const metaPassword = document.querySelector("#metaPassword");
const metaInviteCode = document.querySelector("#metaInviteCode");
const metaCreatedAt = document.querySelector("#metaCreatedAt");
const metaUpstreamSite = document.querySelector("#metaUpstreamSite");
const activeUserLabel = document.querySelector("#activeUserLabel");
const modeDescription = document.querySelector("#modeDescription");
const displayOriginInput = document.querySelector("#displayOrigin");

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
  runtimeMode: "always_refresh",
  trafficThresholdPercent: 20,
  displayOrigin: "",
  users: [],
  relayUrlsByUser: {},
  userSummaries: [],
  currentUserKey: "userA",
  currentPayload: null,
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
  statusBar.textContent = message;
  statusBar.className = `status-bar tone-${tone}`;
}

function clearStatus() {
  statusBar.className = "status-bar hidden";
  statusBar.textContent = "";
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
  subscriptionTab.classList.toggle("hidden", tabName !== "subscription");
  logsTab.classList.toggle("hidden", tabName !== "logs");
  settingsTab.classList.toggle("hidden", tabName !== "settings");

  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabName);
  });
}

function showLogin() {
  loginView.classList.remove("hidden");
  dashboardView.classList.add("hidden");
}

function showDashboard() {
  loginView.classList.add("hidden");
  dashboardView.classList.remove("hidden");
  activateTab("subscription");
}

function findCurrentUser() {
  return state.users.find((user) => user.key === state.currentUserKey) || state.users[0] || {
    key: state.currentUserKey,
    label: "用户",
  };
}

function getCurrentSummary() {
  return state.userSummaries.find((item) => item.key === state.currentUserKey) || null;
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

function describeMode(runtimeMode) {
  if (runtimeMode === "smart_usage") {
    return `当前是智能模式：只有客户端拉取和管理查看才会查上游，剩余流量低于 ${state.trafficThresholdPercent}% 时才重新注册。`;
  }

  return "当前是兼容模式：客户端每次拉取订阅都会直接重新注册上游账号。";
}

function selectRuntimeMode(runtimeMode) {
  const radio = settingsForm.querySelector(`input[name="runtimeMode"][value="${runtimeMode}"]`);
  if (radio) {
    radio.checked = true;
  }
}

function fillMeta(registration) {
  metaEmail.textContent = registration?.email || "暂无";
  metaPassword.textContent = registration?.password || "暂无";
  metaInviteCode.textContent = registration?.inviteCode || "无";
  metaCreatedAt.textContent = registration?.createdAt
    ? formatDateTime(registration.createdAt)
    : "暂无";
  metaUpstreamSite.textContent = registration?.upstreamSite || registration?.entryUrl || "暂无";
}

function renderLinks(relayUrls) {
  linksList.innerHTML = "";

  if (!relayUrls) {
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");

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
  usageGrid.innerHTML = "";

  if (!usage) {
    usageEmptyState.classList.remove("hidden");
    return;
  }

  usageEmptyState.classList.add("hidden");

  const cards = [
    ["最近查询", formatDateTime(usage.queriedAt)],
    ["套餐", usage.planName || "暂无"],
    ["总流量", formatBytes(usage.transferEnable)],
    ["已用流量", formatBytes(usage.usedTotal)],
    ["剩余流量", formatBytes(usage.remainingTraffic)],
    ["剩余比例", formatPercent(usage.remainingPercent)],
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
    parts.push("已换号");
  } else if (entry.decision === "reuse") {
    parts.push("继续复用");
  } else if (entry.decision === "low-traffic") {
    parts.push("低流量预警");
  }

  if (typeof entry.usage?.remainingPercent === "number") {
    parts.push(`剩余 ${entry.usage.remainingPercent.toFixed(2)}%`);
  }

  return parts.join(" · ");
}

function renderHistory(history) {
  historyList.innerHTML = "";

  if (!Array.isArray(history) || history.length === 0) {
    historyEmptyState.classList.remove("hidden");
    return;
  }

  historyEmptyState.classList.add("hidden");

  history.forEach((entry) => {
    const item = document.createElement("article");
    item.className = "history-item";

    const metaText = buildHistoryMeta(entry);
    const registrationTime = entry.registration?.createdAt
      ? `上游注册时间：${formatDateTime(entry.registration.createdAt)}`
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

    return state.userSummaries.find((item) => item.key === user.key) || {
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
    };
  });
}

function renderUserSwitcher() {
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

function applySession(payload) {
  state.runtimeMode = payload.runtimeMode || state.runtimeMode;
  state.trafficThresholdPercent = payload.trafficThresholdPercent || state.trafficThresholdPercent;
  state.displayOrigin = payload.displayOrigin || "";
  state.users = Array.isArray(payload.users) ? payload.users : [];
  state.relayUrlsByUser = payload.relayUrlsByUser || {};
  state.userSummaries = Array.isArray(payload.userSummaries) ? payload.userSummaries : [];

  const hasCurrent = state.users.some((user) => user.key === state.currentUserKey);
  if (!hasCurrent) {
    state.currentUserKey = payload.defaultUserKey || state.users[0]?.key || "userA";
  }

  activeUserLabel.textContent = findCurrentUser().label;
  modeDescription.textContent = describeMode(state.runtimeMode);
  selectRuntimeMode(state.runtimeMode);
  displayOriginInput.value = state.displayOrigin;
  renderUserSwitcher();
}

function applyUserPayload(payload) {
  state.currentPayload = payload;
  state.runtimeMode = payload.runtimeMode || state.runtimeMode;
  state.trafficThresholdPercent = payload.trafficThresholdPercent || state.trafficThresholdPercent;
  displayOriginInput.value = state.displayOrigin;
  state.relayUrlsByUser[state.currentUserKey] = payload.relayUrls || state.relayUrlsByUser[state.currentUserKey];

  activeUserLabel.textContent = payload.user?.label || findCurrentUser().label;
  modeDescription.textContent = describeMode(state.runtimeMode);
  selectRuntimeMode(state.runtimeMode);

  fillMeta(payload.registration);
  renderLinks(payload.relayUrls || state.relayUrlsByUser[state.currentUserKey] || null);
  renderUsage(payload.usage);
  renderHistory(payload.history);
  updateSummaryFromPayload(payload);
  renderUserSwitcher();
}

async function loadUserState() {
  const user = findCurrentUser();
  activeUserLabel.textContent = user.label;

  try {
    const payload = await requestJson(
      `/api/subscriptions/latest?type=full&user=${encodeURIComponent(state.currentUserKey)}`,
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
      }),
    });

    applyUserPayload(payload);
    setStatus(`${findCurrentUser().label} 已重新注册新的上游账号。`, "success");
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

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();
  setLoading(saveSettingsButton, "保存中...", true);

  const formData = new FormData(settingsForm);
  const runtimeMode = (formData.get("runtimeMode") || "").toString();
  const displayOrigin = (formData.get("displayOrigin") || "").toString().trim();

  try {
    const payload = await requestJson("/api/settings", {
      method: "POST",
      body: JSON.stringify({ runtimeMode, displayOrigin }),
    });

    state.runtimeMode = payload.runtimeMode;
    state.displayOrigin = payload.displayOrigin || "";
    state.trafficThresholdPercent = payload.trafficThresholdPercent || state.trafficThresholdPercent;
    modeDescription.textContent = describeMode(state.runtimeMode);
    selectRuntimeMode(state.runtimeMode);
    displayOriginInput.value = state.displayOrigin;
    await refreshSession();
    setStatus("运行模式已更新。", "success");
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

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activateTab(button.dataset.tab);
  });
});

refreshSession();
