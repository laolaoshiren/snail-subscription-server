"use strict";

const loginView = document.querySelector("#loginView");
const dashboardView = document.querySelector("#dashboardView");
const loginForm = document.querySelector("#loginForm");
const registerForm = document.querySelector("#registerForm");
const passwordForm = document.querySelector("#passwordForm");
const logoutButton = document.querySelector("#logoutButton");
const statusBar = document.querySelector("#statusBar");
const linksList = document.querySelector("#linksList");
const emptyState = document.querySelector("#emptyState");
const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const subscriptionTab = document.querySelector("#subscriptionTab");
const securityTab = document.querySelector("#securityTab");

const metaEmail = document.querySelector("#metaEmail");
const metaPassword = document.querySelector("#metaPassword");
const metaInviteCode = document.querySelector("#metaInviteCode");
const metaCreatedAt = document.querySelector("#metaCreatedAt");
const metaUpstreamSite = document.querySelector("#metaUpstreamSite");

const loginButton = document.querySelector("#loginButton");
const registerButton = document.querySelector("#registerButton");
const savePasswordButton = document.querySelector("#savePasswordButton");
let currentRelayUrls = null;

const protocolLabels = {
  universal: "通用订阅",
  clash: "Clash",
  shadowrocket: "Shadowrocket",
  surge: "Surge",
  quantumultx: "Quantumult X",
  "sing-box": "sing-box",
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
  const isSubscription = tabName === "subscription";
  subscriptionTab.classList.toggle("hidden", !isSubscription);
  securityTab.classList.toggle("hidden", isSubscription);

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

function fillMeta(registration) {
  metaEmail.textContent = registration?.email || "暂无";
  metaPassword.textContent = registration?.password || "暂无";
  metaInviteCode.textContent = registration?.inviteCode || "无";
  metaCreatedAt.textContent = registration?.createdAt
    ? new Date(registration.createdAt).toLocaleString()
    : "暂无";
  metaUpstreamSite.textContent = registration?.upstreamSite || "暂无";
}

function renderLinks(relayUrls) {
  linksList.innerHTML = "";

  if (!relayUrls) {
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");

  for (const [type, label] of Object.entries(protocolLabels)) {
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
  }
}

function applyLatestState(registration, relayUrls) {
  if (relayUrls) {
    currentRelayUrls = relayUrls;
  }

  fillMeta(registration);
  renderLinks(currentRelayUrls);
}

async function loadLatestRegistration() {
  try {
    const payload = await requestJson("/api/subscriptions/latest?type=full");
    applyLatestState(payload.registration, payload.relayUrls);
  } catch (error) {
    if (error.status === 404) {
      applyLatestState(null, currentRelayUrls);
      clearStatus();
      return;
    }

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
    applyLatestState(null, payload.relayUrls);
    await loadLatestRegistration();
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

    showDashboard();
    setStatus("登录成功。", "success");
    await loadLatestRegistration();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setLoading(loginButton, "登录中...", false);
  }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();
  setLoading(registerButton, "生成中...", true);

  const formData = new FormData(registerForm);
  const inviteCode = (formData.get("inviteCode") || "").toString().trim();

  try {
    const payload = await requestJson("/api/subscriptions", {
      method: "POST",
      body: JSON.stringify({ type: "full", inviteCode }),
    });

    applyLatestState(payload.registration, payload.relayUrls);
    setStatus("已刷新服务器中转订阅。", "success");
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      setStatus("登录状态已失效，请重新输入密码。", "error");
      return;
    }

    setStatus(error.message, "error");
  } finally {
    setLoading(registerButton, "生成中...", false);
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
    applyLatestState(null, null);
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
