"use strict";

const loginView = document.querySelector("#loginView");
const dashboardView = document.querySelector("#dashboardView");
const loginForm = document.querySelector("#loginForm");
const loginUsername = document.querySelector("#loginUsername");
const loginPassword = document.querySelector("#loginPassword");
const loginPasswordVisible = document.querySelector("#loginPasswordVisible");
const loginHint = document.querySelector("#loginHint");
const registerForm = document.querySelector("#registerForm");
const upstreamForm = document.querySelector("#upstreamForm");
const systemForm = document.querySelector("#systemForm");
const passwordForm = document.querySelector("#passwordForm");
const logoutButton = document.querySelector("#logoutButton");
const reloadUpstreamsButton = document.querySelector("#reloadUpstreamsButton");
const checkUpdateButton = document.querySelector("#checkUpdateButton");
const runUpdateButton = document.querySelector("#runUpdateButton");
const upstreamCloudForm = document.querySelector("#upstreamCloudForm");
const checkUpstreamCloudButton = document.querySelector("#checkUpstreamCloudButton");
const syncUpstreamCloudButton = document.querySelector("#syncUpstreamCloudButton");
const saveUpstreamCloudButton = document.querySelector("#saveUpstreamCloudButton");

const statusBar = document.querySelector("#statusBar");
const linksList = document.querySelector("#linksList");
const emptyState = document.querySelector("#emptyState");
const qrModal = document.querySelector("#qrModal");
const qrModalTitle = document.querySelector("#qrModalTitle");
const qrModalImage = document.querySelector("#qrModalImage");
const qrModalPlaceholder = document.querySelector("#qrModalPlaceholder");
const qrModalUrl = document.querySelector("#qrModalUrl");
const qrModalClose = document.querySelector("#qrModalClose");
const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const subscriptionTab = document.querySelector("#subscriptionTab");
const logsTab = document.querySelector("#logsTab");
const upstreamsTab = document.querySelector("#upstreamsTab");
const systemTab = document.querySelector("#systemTab");
const userScopePanel = document.querySelector("#userScopePanel");

const userSwitcher = document.querySelector("#userSwitcher");
const upstreamSwitcher = document.querySelector("#upstreamSwitcher");
const upstreamList = document.querySelector("#upstreamList");
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
const upstreamCloudEnabledInput = document.querySelector("#upstreamCloudEnabled");
const upstreamCloudAutoSyncInput = document.querySelector("#upstreamCloudAutoSync");
const upstreamCloudRepoInput = document.querySelector("#upstreamCloudRepo");
const upstreamCloudBranchInput = document.querySelector("#upstreamCloudBranch");
const upstreamCloudDirectoryInput = document.querySelector("#upstreamCloudDirectory");
const upstreamCloudState = document.querySelector("#upstreamCloudState");
const upstreamCloudLatest = document.querySelector("#upstreamCloudLatest");
const upstreamCloudSyncedAt = document.querySelector("#upstreamCloudSyncedAt");
const upstreamCloudHint = document.querySelector("#upstreamCloudHint");
const appCurrentVersion = document.querySelector("#appCurrentVersion");
const appLatestVersion = document.querySelector("#appLatestVersion");
const appUpdateState = document.querySelector("#appUpdateState");
const appUpdateSummary = document.querySelector("#appUpdateSummary");

const loginButton = document.querySelector("#loginButton");
const registerButton = document.querySelector("#registerButton");
const saveUpstreamButton = document.querySelector("#saveUpstreamButton");
const saveSystemButton = document.querySelector("#saveSystemButton");
const savePasswordButton = document.querySelector("#savePasswordButton");
const POLLING_UPSTREAM_VALUE = "__polling__";
const ACTIVE_UPSTREAM_MODES = {
  SINGLE: "single",
  POLLING: "polling",
};

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
  upstreamOrder: [],
  relayUrlsByUser: {},
  userSummaries: [],
  currentUserKey: "userA",
  activeUpstreamId: "",
  activeUpstreamMode: ACTIVE_UPSTREAM_MODES.SINGLE,
  selectedUpstreamId: "",
  currentTab: "subscription",
  appUpdate: null,
  upstreamCloud: null,
  passwordIsDefault: false,
  defaultPassword: "",
  announcedUpdateKey: "",
  updateReconnectTimer: null,
};
let draggingUpstreamId = "";
let qrModalRequestToken = 0;

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

function renderLoginHint() {
  if (!loginHint || !loginPassword) {
    return;
  }

  if (state.passwordIsDefault && state.defaultPassword) {
    loginHint.innerHTML = `默认密码是 <code>${state.defaultPassword}</code>`;
    loginPassword.placeholder = `默认 ${state.defaultPassword}`;
    return;
  }

  loginHint.textContent = "请输入你设置的面板密码。";
  loginPassword.placeholder = "请输入面板密码";
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
  closeQrModal();
  toggleHidden(loginView, false);
  toggleHidden(dashboardView, true);
}

function showDashboard() {
  toggleHidden(loginView, true);
  toggleHidden(dashboardView, false);
  activateTab(state.currentTab || "subscription");
}

function resetQrModalContent(message = "生成中...") {
  if (qrModalImage) {
    qrModalImage.removeAttribute("src");
    qrModalImage.alt = "订阅二维码";
    toggleHidden(qrModalImage, true);
  }

  if (qrModalPlaceholder) {
    qrModalPlaceholder.textContent = message;
    toggleHidden(qrModalPlaceholder, false);
  }
}

function closeQrModal() {
  qrModalRequestToken += 1;

  if (!qrModal) {
    return;
  }

  toggleHidden(qrModal, true);
  setText(qrModalTitle, "订阅二维码");
  setText(qrModalUrl, "");
  resetQrModalContent();
}

async function openQrModal(label, url) {
  if (!qrModal || !url) {
    return;
  }

  const requestToken = qrModalRequestToken + 1;
  qrModalRequestToken = requestToken;

  setText(qrModalTitle, `${label} 二维码`);
  setText(qrModalUrl, url);
  resetQrModalContent("生成中...");
  toggleHidden(qrModal, false);

  try {
    const payload = await requestJson("/api/qrcode", {
      method: "POST",
      body: JSON.stringify({ text: url }),
    });

    if (requestToken !== qrModalRequestToken) {
      return;
    }

    if (!payload.dataUrl) {
      throw new Error("二维码生成失败。");
    }

    if (qrModalImage) {
      qrModalImage.src = payload.dataUrl;
      qrModalImage.alt = `${label} 二维码`;
      toggleHidden(qrModalImage, false);
    }

    toggleHidden(qrModalPlaceholder, true);
  } catch (error) {
    if (requestToken !== qrModalRequestToken) {
      return;
    }

    if (error.status === 401) {
      closeQrModal();
      showLogin();
      setStatus("登录状态已失效，请重新输入密码。", "error");
      return;
    }

    resetQrModalContent("生成失败，请重试。");
    setStatus(error.message, "error");
  }
}

function createFallbackUpstream(upstreamId = state.activeUpstreamId || state.selectedUpstreamId) {
  return {
    id: upstreamId,
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
  };
}

function getOrderedUpstreams() {
  const upstreamById = new Map(state.upstreams.map((item) => [item.id, item]));
  const ordered = [];
  const seen = new Set();

  (Array.isArray(state.upstreamOrder) ? state.upstreamOrder : []).forEach((upstreamId) => {
    if (!upstreamById.has(upstreamId) || seen.has(upstreamId)) {
      return;
    }

    seen.add(upstreamId);
    ordered.push(upstreamById.get(upstreamId));
  });

  state.upstreams.forEach((upstream) => {
    if (seen.has(upstream.id)) {
      return;
    }

    seen.add(upstream.id);
    ordered.push(upstream);
  });

  return ordered;
}

function getActiveUpstream() {
  return (
    state.upstreams.find((item) => item.id === state.activeUpstreamId) ||
    getOrderedUpstreams()[0] ||
    createFallbackUpstream(state.activeUpstreamId)
  );
}

function getSelectedUpstream() {
  return (
    getOrderedUpstreams().find((item) => item.id === state.selectedUpstreamId) ||
    getActiveUpstream() ||
    createFallbackUpstream(state.selectedUpstreamId)
  );
}

function isPollingMode() {
  return state.activeUpstreamMode === ACTIVE_UPSTREAM_MODES.POLLING;
}

function getRuntimeSelectionLabel(upstream = getActiveUpstream()) {
  return isPollingMode() ? "轮询模式" : upstream?.label || "主上游";
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

function formatCommit(value) {
  if (!value) {
    return "暂无";
  }

  const text = value.toString().trim();
  return text.length > 12 ? text.slice(0, 12) : text;
}

function parseRepoInput(value) {
  const parts = (value || "")
    .toString()
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);

  return {
    repoOwner: parts[0] || "",
    repoName: parts[1] || "",
  };
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
    return `仅兼容模式，${updateIntervalText}。`;
  }

  if (config.runtimeMode === "smart_usage") {
    const ageRule =
      Number(config.maxRegistrationAgeMinutes) > 0
        ? `，或账号年龄超过 ${config.maxRegistrationAgeMinutes} 分钟`
        : "";
    return `智能模式：低于 ${config.trafficThresholdPercent}%${ageRule} 时重注，${updateIntervalText}。`;
  }

  return `兼容模式：每次拉取都重注，${updateIntervalText}。`;
}

function describeRuntimeSelection(upstream = getActiveUpstream()) {
  if (!isPollingMode()) {
    return describeMode(upstream);
  }

  const enabledNames = getOrderedUpstreams()
    .filter((item) => item?.config?.enabled !== false)
    .map((item) => item.label);
  if (enabledNames.length === 0) {
    return "轮询模式：暂无可用上游。";
  }

  return `轮询模式：按顺序尝试。${enabledNames.join(" → ")}`;
}

function selectUpstreamConfig(upstreamId) {
  if (!upstreamId || upstreamId === state.selectedUpstreamId) {
    return;
  }

  state.selectedUpstreamId = upstreamId;
  renderUpstreamList();
  syncUpstreamForm();
}

async function persistUpstreamOrder(nextOrder) {
  const previousOrder = [...state.upstreamOrder];
  state.upstreamOrder = [...nextOrder];
  renderUpstreamSwitcher();
  renderUpstreamList();

  try {
    await requestJson("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        upstreamOrder: nextOrder,
      }),
    });
  } catch (error) {
    state.upstreamOrder = previousOrder;
    renderUpstreamSwitcher();
    renderUpstreamList();
    syncUpstreamForm();
    setStatus(error.message, "error");
  }
}

function renderUpstreamList() {
  if (!upstreamList) {
    return;
  }

  upstreamList.innerHTML = "";

  getOrderedUpstreams().forEach((upstream, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `upstream-list-item${upstream.id === state.selectedUpstreamId ? " active" : ""}${upstream.config?.enabled === false ? " disabled" : ""}`;
    item.draggable = true;
    item.dataset.upstreamId = upstream.id;
    item.innerHTML = `
      <span class="upstream-list-item__order">${String(index + 1).padStart(2, "0")}</span>
      <span class="upstream-list-item__body">
        <strong>${upstream.label || upstream.id}</strong>
        <small>${upstream.config?.enabled === false ? "已停用" : upstream.sourceType === "synced" ? `${upstream.id} · 云端` : upstream.id}</small>
      </span>
      <span class="upstream-list-item__drag">⋮⋮</span>
    `;

    item.addEventListener("click", () => {
      selectUpstreamConfig(upstream.id);
    });

    item.addEventListener("dragstart", (event) => {
      draggingUpstreamId = upstream.id;
      item.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", upstream.id);
    });

    item.addEventListener("dragend", () => {
      draggingUpstreamId = "";
      item.classList.remove("dragging");
    });

    item.addEventListener("dragover", (event) => {
      if (!draggingUpstreamId || draggingUpstreamId === upstream.id) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      item.classList.add("drag-target");
    });

    item.addEventListener("dragleave", () => {
      item.classList.remove("drag-target");
    });

    item.addEventListener("drop", async (event) => {
      item.classList.remove("drag-target");
      if (!draggingUpstreamId || draggingUpstreamId === upstream.id) {
        return;
      }

      event.preventDefault();
      const orderedIds = getOrderedUpstreams()
        .map((item) => item.id)
        .filter((upstreamId) => upstreamId !== draggingUpstreamId);
      const targetIndex = orderedIds.indexOf(upstream.id);
      if (targetIndex < 0) {
        return;
      }

      orderedIds.splice(targetIndex, 0, draggingUpstreamId);
      await persistUpstreamOrder(orderedIds);
    });

    upstreamList.appendChild(item);
  });
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

    const actions = document.createElement("div");
    actions.className = "link-actions";

    const copyButton = document.createElement("button");
    copyButton.className = "ghost-button small-button";
    copyButton.type = "button";
    copyButton.textContent = "复制";
    copyButton.disabled = !url;
    copyButton.addEventListener("click", async () => {
      if (!url) {
        return;
      }

      await copyText(url);
      setStatus(`${label} 链接已复制。`, "success");
    });

    const qrButton = document.createElement("button");
    qrButton.className = "ghost-button small-button";
    qrButton.type = "button";
    qrButton.textContent = "二维码";
    qrButton.disabled = !url;
    qrButton.addEventListener("click", async () => {
      await openQrModal(label, url);
    });

    actions.append(copyButton, qrButton);
    foot.append(actions);
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
  const runtimeUpstream = getActiveUpstream();
  const selectedUpstream = getSelectedUpstream();
  const config = selectedUpstream.config || {};
  const supportsStatusQuery = upstreamSupportsStatusQuery(selectedUpstream);
  const supportsInviteCode = upstreamSupportsInviteCode(selectedUpstream);
  const runtimeSupportsInviteCode = upstreamSupportsInviteCode(runtimeUpstream);

  setText(activeUpstreamLabel, getRuntimeSelectionLabel(runtimeUpstream));
  setText(modeDescription, describeRuntimeSelection(runtimeUpstream));
  renderUpstreamOverview(selectedUpstream);

  setInputValue(upstreamNameInput, config.name || selectedUpstream.label || "");
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
    registerInviteCodeInput.disabled = !runtimeSupportsInviteCode;
    registerInviteCodeInput.placeholder = runtimeSupportsInviteCode
      ? "可选，默认用当前上游邀请码"
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

  renderProviderSettingsFields(selectedUpstream);
}

function syncSystemForm() {
  setInputValue(displayOriginInput, state.displayOrigin || "");
}

function renderAppUpdateStatus() {
  const status = state.appUpdate || {};
  const isDockerUpdate = status.mode === "docker";
  const currentVersionText = status.currentVersion
    ? `${status.currentVersion}${status.currentCommitSha ? ` · ${formatCommit(status.currentCommitSha)}` : ""}`
    : "暂无";
  const latestVersionText = status.latestVersion
    ? `${status.latestVersion}${status.latestCommitSha ? ` · ${formatCommit(status.latestCommitSha)}` : ""}`
    : "暂无";

  let stateText = "未检查";
  let summary = "检测当前版本并手动触发在线更新。";

  if (status.updating) {
    stateText = "更新中";
    summary = isDockerUpdate ? "正在拉取新镜像并重建容器。" : "更新任务已启动，完成后会自动重启服务。";
  } else if (status.checking) {
    stateText = "检查中";
    summary = "正在检查 GitHub 上的最新版本。";
  } else if (!status.supported) {
    stateText = "只读";
    summary = "当前部署环境只能显示版本，不能直接在线更新。";
  } else if (status.lastError) {
    stateText = "检查失败";
    summary = status.lastError;
  } else if (status.updateAvailable) {
    stateText = "发现更新";
    summary = isDockerUpdate ? "检测到新镜像，点击后会自动拉取并重建容器。" : "检测到新版本，手动确认后才会开始更新。";
  } else if (status.currentVersion) {
    stateText = "已是最新";
    summary = isDockerUpdate ? "当前 Docker 部署已经是最新版本。" : "当前程序已经是最新版本。";
  }

  setText(appCurrentVersion, currentVersionText);
  setText(appLatestVersion, latestVersionText);
  setText(appUpdateState, stateText);
  setText(appUpdateSummary, summary);

  if (checkUpdateButton) {
    checkUpdateButton.disabled = Boolean(status.checking || status.updating);
  }
  if (runUpdateButton) {
    runUpdateButton.disabled = Boolean(
      !status.supported || !status.updateAvailable || status.checking || status.updating,
    );
  }
}

function syncUpstreamCloudForm() {
  const status = state.upstreamCloud || {};
  const config = status.config || {};
  const repoText =
    config.repoOwner && config.repoName
      ? `${config.repoOwner}/${config.repoName}`
      : "";

  setCheckboxValue(upstreamCloudEnabledInput, config.enabled !== false);
  setCheckboxValue(upstreamCloudAutoSyncInput, config.autoSync);
  setInputValue(upstreamCloudRepoInput, repoText);
  setInputValue(upstreamCloudBranchInput, config.branch || "main");
  setInputValue(upstreamCloudDirectoryInput, config.directory || "src/upstreams/vendors");

  let stateText = "未检查";
  let hintText = "保存后可手动检查或立即同步。";

  if (status.syncing) {
    stateText = "同步中";
    hintText = "正在下载并重载云端上游模块。";
  } else if (status.checking) {
    stateText = "检查中";
    hintText = "正在检查云端模块是否有更新。";
  } else if (status.lastError) {
    stateText = "失败";
    hintText = status.lastError;
  } else if (config.enabled === false) {
    stateText = "已停用";
    hintText = "启用后才会检查和同步云端模块。";
  } else if (status.updateAvailable) {
    stateText = "发现更新";
    hintText = "云端有新的上游模块，可立即同步。";
  } else if (status.lastSyncedAt) {
    stateText = "已同步";
    hintText = "当前云端模块已经同步到本地。";
  }

  setText(upstreamCloudState, stateText);
  setText(upstreamCloudLatest, formatCommit(status.latestCommitSha));
  setText(upstreamCloudSyncedAt, formatDateTime(status.lastSyncedAt));
  setText(upstreamCloudHint, hintText);

  if (checkUpstreamCloudButton) {
    checkUpstreamCloudButton.disabled = Boolean(status.syncing || status.checking || config.enabled === false);
  }
  if (syncUpstreamCloudButton) {
    syncUpstreamCloudButton.disabled = Boolean(status.syncing || status.checking || config.enabled === false);
  }
  if (saveUpstreamCloudButton) {
    saveUpstreamCloudButton.disabled = Boolean(status.syncing);
  }
}

function announceAvailableUpdate() {
  const status = state.appUpdate || {};
  if (!status.updateAvailable) {
    return;
  }

  const nextKey = `${status.latestVersion || ""}:${status.latestCommitSha || ""}`;
  if (!nextKey || state.announcedUpdateKey === nextKey) {
    return;
  }

  state.announcedUpdateKey = nextKey;
  if (statusBar?.classList.contains("hidden")) {
    setStatus(`发现新版本，可在系统页更新。`, "warning");
  }
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
    const nextSettings =
      upstreamId === POLLING_UPSTREAM_VALUE
        ? {
            activeUpstreamMode: ACTIVE_UPSTREAM_MODES.POLLING,
          }
        : {
            activeUpstreamId: upstreamId,
            activeUpstreamMode: ACTIVE_UPSTREAM_MODES.SINGLE,
          };
    await requestJson("/api/settings", {
      method: "POST",
      body: JSON.stringify(nextSettings),
    });

    await refreshSession();
    setStatus(
      isPollingMode()
        ? "已切换到轮询模式。下游请求会按排序顺序自动尝试上游。"
        : `已切换到 ${getActiveUpstream().label}。`,
      "success",
    );
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

  const pollingOption = document.createElement("option");
  pollingOption.value = POLLING_UPSTREAM_VALUE;
  pollingOption.textContent = "轮询模式 · 按排序顺序依次尝试";
  upstreamSwitcher.appendChild(pollingOption);

  getOrderedUpstreams().forEach((upstream) => {
    const modeText = upstream.config?.runtimeMode === "smart_usage" ? "智能模式" : "兼容模式";
    const statusText = upstream.config?.enabled === false ? "已停用" : modeText;
    const option = document.createElement("option");
    option.value = upstream.id;
    option.textContent = `${upstream.label} · ${statusText}`;
    option.disabled = upstream.config?.enabled === false;
    upstreamSwitcher.appendChild(option);
  });

  upstreamSwitcher.value = isPollingMode()
    ? POLLING_UPSTREAM_VALUE
    : state.activeUpstreamId || getOrderedUpstreams()[0]?.id || "";
}

function applySession(payload) {
  state.passwordIsDefault = Boolean(payload.passwordIsDefault);
  state.defaultPassword = (payload.defaultPassword || "").toString();
  state.displayOrigin = payload.displayOrigin || "";
  state.users = Array.isArray(payload.users) ? payload.users : [];
  state.upstreams = Array.isArray(payload.upstreams) ? payload.upstreams : [];
  state.upstreamOrder = Array.isArray(payload.upstreamOrder) ? payload.upstreamOrder : [];
  state.relayUrlsByUser = payload.relayUrlsByUser || {};
  state.userSummaries = Array.isArray(payload.userSummaries) ? payload.userSummaries : [];
  state.activeUpstreamId = payload.activeUpstreamId || state.upstreams[0]?.id || "";
  state.activeUpstreamMode = payload.activeUpstreamMode || ACTIVE_UPSTREAM_MODES.SINGLE;
  state.appUpdate = payload.appUpdate || null;
  state.upstreamCloud = payload.upstreamCloud || null;

  if (!state.users.some((user) => user.key === state.currentUserKey)) {
    state.currentUserKey = payload.defaultUserKey || state.users[0]?.key || "userA";
  }
  if (!getOrderedUpstreams().some((upstream) => upstream.id === state.selectedUpstreamId)) {
    state.selectedUpstreamId = state.activeUpstreamId || getOrderedUpstreams()[0]?.id || "";
  }

  setText(activeUserLabel, getCurrentUser().label);
  renderUpstreamSwitcher();
  renderUpstreamList();
  renderUserSwitcher();
  syncUpstreamForm();
  syncSystemForm();
  renderAppUpdateStatus();
  syncUpstreamCloudForm();
  announceAvailableUpdate();
  renderLoginHint();
}

function applyUserPayload(payload) {
  const upstream = payload.upstream || getActiveUpstream();
  state.relayUrlsByUser[state.currentUserKey] =
    payload.relayUrls || state.relayUrlsByUser[state.currentUserKey] || {};

  setText(activeUserLabel, payload.user?.label || getCurrentUser().label);
  setText(activeUpstreamLabel, getRuntimeSelectionLabel(upstream));
  setText(modeDescription, describeRuntimeSelection(upstream));

  fillMeta(payload.registration);
  renderLinks(payload.relayUrls || state.relayUrlsByUser[state.currentUserKey] || null, upstream);
  renderUsage(payload.usage);
  renderHistory(payload.history);
  updateSummaryFromPayload(payload);
  renderUserSwitcher();
}

async function loadUserState() {
  setText(activeUserLabel, getCurrentUser().label);
  setText(activeUpstreamLabel, getRuntimeSelectionLabel(getActiveUpstream()));

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
      state.passwordIsDefault = Boolean(payload.passwordIsDefault);
      state.defaultPassword = (payload.defaultPassword || "").toString();
      renderLoginHint();
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

function beginUpdateReconnectPolling() {
  if (state.updateReconnectTimer) {
    window.clearTimeout(state.updateReconnectTimer);
    state.updateReconnectTimer = null;
  }

  let attempts = 0;

  const poll = async () => {
    attempts += 1;

    try {
      const payload = await requestJson("/api/session", { method: "GET" });
      if (payload.authenticated) {
        showDashboard();
        applySession(payload);
        await loadUserState();

        if (!payload.appUpdate?.updating) {
          state.updateReconnectTimer = null;
          setStatus("系统更新完成。", "success");
          return;
        }
      }
    } catch (error) {
      // Ignore temporary restart failures while the service is rebooting.
    }

    if (attempts >= 60) {
      state.updateReconnectTimer = null;
      setStatus("更新后的自动重连超时，请手动刷新页面。", "warning");
      return;
    }

    state.updateReconnectTimer = window.setTimeout(poll, 3000);
  };

  state.updateReconnectTimer = window.setTimeout(poll, 3000);
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
      if (error.status === 401) {
        setStatus(
          state.passwordIsDefault
            ? "默认密码不正确，请重试。"
            : "面板密码错误，请确认你设置的密码。",
          "error",
        );
        return;
      }

      setStatus(error.message, "error");
    } finally {
      setLoading(loginButton, "登录中...", false);
    }
  });
}

renderLoginHint();

if (loginPasswordVisible && loginPassword) {
  loginPasswordVisible.addEventListener("change", () => {
    loginPassword.type = loginPasswordVisible.checked ? "text" : "password";
  });
}

if (qrModalClose) {
  qrModalClose.addEventListener("click", () => {
    closeQrModal();
  });
}

if (qrModal) {
  qrModal.addEventListener("click", (event) => {
    if (event.target === qrModal) {
      closeQrModal();
    }
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && qrModal && !qrModal.classList.contains("hidden")) {
    closeQrModal();
  }
});

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
        }),
      });

      applyUserPayload(payload);
      setStatus(
        isPollingMode()
          ? `当前用户已按轮询模式完成注册，命中 ${payload.upstream?.label || "可用上游"}。`
          : `当前用户已在 ${getActiveUpstream().label} 下完成重新注册。`,
        "success",
      );
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
    const upstream = getSelectedUpstream();
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
          upstreamId: state.selectedUpstreamId,
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
      setStatus("当前上游配置已更新。", "success");
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

if (upstreamCloudForm) {
  upstreamCloudForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearStatus();
    setLoading(saveUpstreamCloudButton, "保存中...", true);

    const repo = parseRepoInput(upstreamCloudRepoInput?.value || "");

    try {
      await requestJson("/api/settings", {
        method: "POST",
        body: JSON.stringify({
          upstreamCloud: {
            enabled: upstreamCloudEnabledInput?.checked,
            autoSync: upstreamCloudAutoSyncInput?.checked,
            repoOwner: repo.repoOwner,
            repoName: repo.repoName,
            branch: (upstreamCloudBranchInput?.value || "").trim(),
            directory: (upstreamCloudDirectoryInput?.value || "").trim(),
          },
        }),
      });

      await refreshSession();
      setStatus("云端上游配置已更新。", "success");
    } catch (error) {
      if (error.status === 401) {
        showLogin();
        setStatus("登录状态已失效，请重新输入密码。", "error");
        return;
      }

      setStatus(error.message, "error");
    } finally {
      setLoading(saveUpstreamCloudButton, "保存中...", false);
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

if (checkUpdateButton) {
  checkUpdateButton.addEventListener("click", async () => {
    clearStatus();
    setLoading(checkUpdateButton, "检查中...", true);

    try {
      const payload = await requestJson("/api/system/check-update", { method: "POST" });
      state.appUpdate = payload.appUpdate || state.appUpdate;
      renderAppUpdateStatus();
      setStatus(
        payload.appUpdate?.updateAvailable ? "检测到新版本，可手动更新。" : "当前已经是最新版本。",
        payload.appUpdate?.updateAvailable ? "warning" : "success",
      );
    } catch (error) {
      if (error.status === 401) {
        showLogin();
        setStatus("登录状态已失效，请重新输入密码。", "error");
        return;
      }

      setStatus(error.message, "error");
    } finally {
      setLoading(checkUpdateButton, "检查中...", false);
    }
  });
}

if (runUpdateButton) {
  runUpdateButton.addEventListener("click", async () => {
    clearStatus();
    setLoading(runUpdateButton, "更新中...", true);

    try {
      const payload = await requestJson("/api/system/update", { method: "POST" });
      state.appUpdate = payload.appUpdate || state.appUpdate;
      renderAppUpdateStatus();
      if (payload.restartRequired) {
        setStatus("系统更新已完成，服务会自动重启。", "warning");
        beginUpdateReconnectPolling();
      } else {
        setStatus("当前已经是最新版本。", "success");
      }
    } catch (error) {
      if (error.status === 401) {
        showLogin();
        setStatus("登录状态已失效，请重新输入密码。", "error");
        return;
      }

      setStatus(error.message, "error");
    } finally {
      setLoading(runUpdateButton, "立即更新", false);
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

if (checkUpstreamCloudButton) {
  checkUpstreamCloudButton.addEventListener("click", async () => {
    clearStatus();
    setLoading(checkUpstreamCloudButton, "检查中...", true);

    try {
      const payload = await requestJson("/api/upstreams/cloud/check", { method: "POST" });
      state.upstreamCloud = payload.upstreamCloud || state.upstreamCloud;
      syncUpstreamCloudForm();
      setStatus(
        payload.upstreamCloud?.updateAvailable ? "云端检测到新模块，可立即同步。" : "云端上游已是最新状态。",
        payload.upstreamCloud?.updateAvailable ? "warning" : "success",
      );
    } catch (error) {
      if (error.status === 401) {
        showLogin();
        setStatus("登录状态已失效，请重新输入密码。", "error");
        return;
      }

      setStatus(error.message, "error");
    } finally {
      setLoading(checkUpstreamCloudButton, "检查中...", false);
    }
  });
}

if (syncUpstreamCloudButton) {
  syncUpstreamCloudButton.addEventListener("click", async () => {
    clearStatus();
    setLoading(syncUpstreamCloudButton, "同步中...", true);

    try {
      const payload = await requestJson("/api/upstreams/cloud/sync", { method: "POST" });
      state.upstreamCloud = payload.upstreamCloud || state.upstreamCloud;
      await refreshSession();
      if (!payload.synced) {
        setStatus("云端上游已是最新状态。", "success");
      } else {
        setStatus(
          Array.isArray(payload.diagnostics) && payload.diagnostics.length > 0
            ? `云端模块已同步，但有 ${payload.diagnostics.length} 个模块未通过校验。`
            : "云端上游模块已同步并重载。",
          Array.isArray(payload.diagnostics) && payload.diagnostics.length > 0 ? "warning" : "success",
        );
      }
    } catch (error) {
      if (error.status === 401) {
        showLogin();
        setStatus("登录状态已失效，请重新输入密码。", "error");
        return;
      }

      setStatus(error.message, "error");
    } finally {
      setLoading(syncUpstreamCloudButton, "同步中...", false);
    }
  });
}

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    closeQrModal();
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
    const currentValue = isPollingMode() ? POLLING_UPSTREAM_VALUE : state.activeUpstreamId;
    if (!nextUpstreamId || nextUpstreamId === currentValue) {
      return;
    }

    await switchActiveUpstream(nextUpstreamId);
  });
}

refreshSession();
