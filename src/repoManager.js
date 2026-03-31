"use strict";

const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { getUpstreamCloudConfig } = require("./authStore");
const { dataDir, repoRoot, syncedUpstreamsDir, tempDir } = require("./dataPaths");
const {
  listUpstreamModuleDiagnostics,
  reloadUpstreamModules,
} = require("./upstreams/core/registry");
const { loadSystemState, updateSystemState } = require("./systemStateStore");

const execFileAsync = promisify(execFile);
const packageFile = path.join(repoRoot, "package.json");
const APP_CHECK_TTL_MS = 1000 * 60 * 2;
const CLOUD_CHECK_TTL_MS = 1000 * 60 * 2;
const DEFAULT_DOCKER_SOCKET_PATH = trimGitRefValue(process.env.SNAIL_DOCKER_SOCKET_PATH || "/var/run/docker.sock") || "/var/run/docker.sock";
const DEFAULT_DOCKER_COMMAND = trimGitRefValue(process.env.SNAIL_DOCKER_COMMAND || "docker") || "docker";
const DEFAULT_UPDATE_REPO_OWNER = trimGitRefValue(process.env.SNAIL_UPDATE_REPO_OWNER || "laolaoshiren") || "laolaoshiren";
const DEFAULT_UPDATE_REPO_NAME =
  trimGitRefValue(process.env.SNAIL_UPDATE_REPO_NAME || "snail-subscription-server") ||
  "snail-subscription-server";
const DEFAULT_UPDATE_BRANCH = trimGitRefValue(process.env.SNAIL_UPDATE_BRANCH || "main") || "main";
const DOCKER_UPDATE_ENV_KEYS = Object.freeze([
  "PORT",
  "HOST",
  "PROXY_URL",
  "INVITE_CODE",
  "ALLOW_INSECURE_TLS",
  "RELAY_FETCH_TIMEOUT_MS",
  "MAX_RETRIES",
  "RETRY_DELAY_MS",
  "FETCH_TIMEOUT_MS",
  "PUBLIC_ORIGIN",
  "SNAIL_DATA_DIR",
  "ACCOUNT_DATA_DIR",
  "SNAIL_UPDATE_MODE",
  "SNAIL_DOCKER_CONTAINER_NAME",
  "SNAIL_DOCKER_IMAGE",
  "SNAIL_DOCKER_HOST_DATA_DIR",
  "SNAIL_DOCKER_SOCKET_PATH",
  "SNAIL_DOCKER_COMMAND",
  "SNAIL_DOCKER_COMMAND_ARGS",
  "SNAIL_UPDATE_REPO_OWNER",
  "SNAIL_UPDATE_REPO_NAME",
  "SNAIL_UPDATE_BRANCH",
]);

const cacheState = {
  localInfo: null,
  localInfoAt: 0,
  appStatus: null,
  appStatusAt: 0,
  cloudStatus: null,
  cloudStatusAt: 0,
  updatePromise: null,
  syncPromise: null,
};

function invalidateCaches() {
  cacheState.localInfo = null;
  cacheState.localInfoAt = 0;
  cacheState.appStatus = null;
  cacheState.appStatusAt = 0;
  cacheState.cloudStatus = null;
  cacheState.cloudStatusAt = 0;
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd || repoRoot,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      encoding: options.encoding || "utf8",
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${command} is not available.`);
    }

    if (options.allowFailure) {
      return {
        stdout: error.stdout || "",
        stderr: error.stderr || error.message || "",
      };
    }

    const details = (error.stderr || error.stdout || error.message || "").toString().trim();
    throw new Error(details || `${command} failed.`);
  }
}

async function runGit(args, options = {}) {
  return runCommand("git", args, options);
}

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function readPackageMeta(filePath) {
  const content = await fsPromises.readFile(filePath, "utf8");
  const payload = JSON.parse(content);
  return {
    name: payload.name || "",
    version: payload.version || "0.0.0",
  };
}

function trimGitRefValue(value) {
  return (value || "").toString().trim();
}

function parseCommandArgs(value) {
  const rawValue = trimGitRefValue(value);
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => item.toString());
    }
  } catch (error) {
    // Fall through to simple tokenization.
  }

  return rawValue.split(/\s+/).filter(Boolean);
}

function formatRemoteLabel(remoteUrl, fallback = "") {
  const trimmed = trimGitRefValue(remoteUrl);
  if (!trimmed) {
    return fallback;
  }

  return trimmed.replace(/\.git$/i, "");
}

function buildCloudSourceKey(config) {
  return [config.repoOwner, config.repoName, config.branch, config.directory].join("/");
}

function buildCloudRemoteUrl(config) {
  return `https://github.com/${config.repoOwner}/${config.repoName}.git`;
}

function buildAppRemoteUrl(config = {}) {
  return `https://github.com/${config.repoOwner}/${config.repoName}.git`;
}

function ensureShortCommit(commit) {
  const value = trimGitRefValue(commit);
  return value ? value.slice(0, 7) : "";
}

function getReadonlyUpdateContext() {
  return {
    remoteName: "github",
    remoteUrl: buildAppRemoteUrl({
      repoOwner: DEFAULT_UPDATE_REPO_OWNER,
      repoName: DEFAULT_UPDATE_REPO_NAME,
    }),
    remoteLabel: `${DEFAULT_UPDATE_REPO_OWNER}/${DEFAULT_UPDATE_REPO_NAME}`,
    branch: DEFAULT_UPDATE_BRANCH,
    repoOwner: DEFAULT_UPDATE_REPO_OWNER,
    repoName: DEFAULT_UPDATE_REPO_NAME,
  };
}

function getDockerUpdateContext() {
  return {
    mode: trimGitRefValue(process.env.SNAIL_UPDATE_MODE || ""),
    command: DEFAULT_DOCKER_COMMAND,
    commandArgs: parseCommandArgs(process.env.SNAIL_DOCKER_COMMAND_ARGS || ""),
    image: trimGitRefValue(process.env.SNAIL_DOCKER_IMAGE || ""),
    containerName: trimGitRefValue(process.env.SNAIL_DOCKER_CONTAINER_NAME || ""),
    hostDataDir:
      trimGitRefValue(process.env.SNAIL_DOCKER_HOST_DATA_DIR || "") ||
      trimGitRefValue(process.env.SNAIL_DATA_DIR || process.env.ACCOUNT_DATA_DIR || ""),
    socketPath: DEFAULT_DOCKER_SOCKET_PATH,
    port: trimGitRefValue(process.env.PORT || ""),
  };
}

async function canUseDockerSelfUpdate() {
  const context = getDockerUpdateContext();
  if (
    context.mode !== "docker" ||
    !context.image ||
    !context.containerName ||
    !context.hostDataDir ||
    !context.port ||
    !fs.existsSync(context.socketPath)
  ) {
    return false;
  }

  try {
    await runCommand(context.command, [...context.commandArgs, "version"]);
    return true;
  } catch (error) {
    return false;
  }
}

async function fetchJsonWithHeaders(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "snail-subscription-server",
      ...headers,
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }

  return response.json();
}

async function fetchReadonlyRemotePackageMeta(context) {
  const url = `https://raw.githubusercontent.com/${context.repoOwner}/${context.repoName}/${context.branch}/package.json`;
  return fetchJsonWithHeaders(url);
}

async function fetchReadonlyRemoteCommit(context) {
  const url = `https://api.github.com/repos/${context.repoOwner}/${context.repoName}/commits/${context.branch}`;
  const payload = await fetchJsonWithHeaders(url, {
    "X-GitHub-Api-Version": "2022-11-28",
  });
  return trimGitRefValue(payload?.sha || "");
}

async function buildReadonlyRemoteAppStatus(baseStatus, options = {}) {
  const context = getReadonlyUpdateContext();
  const [remotePackage, remoteCommit] = await Promise.all([
    fetchReadonlyRemotePackageMeta(context),
    fetchReadonlyRemoteCommit(context),
  ]);
  const checkedAt = new Date().toISOString();
  const latestVersion =
    trimGitRefValue(remotePackage?.version || "") || baseStatus.currentVersion || "0.0.0";
  const latestCommitSha = trimGitRefValue(remoteCommit);
  const updateAvailable = Boolean(
    latestVersion !== baseStatus.currentVersion ||
    (latestCommitSha && baseStatus.currentCommitSha && latestCommitSha !== baseStatus.currentCommitSha),
  );

  return {
    ...baseStatus,
    supported: options.supported ?? false,
    mode: options.mode || "readonly",
    checking: false,
    checkedAt,
    lastError: options.lastError || "",
    source: {
      remoteName: context.remoteName,
      remoteLabel: context.remoteLabel,
      branch: context.branch,
    },
    latest: {
      version: latestVersion,
      commit: latestCommitSha,
      shortCommit: ensureShortCommit(latestCommitSha),
    },
    latestVersion,
    latestCommitSha,
    updateAvailable,
    canFastForward: false,
    hasLocalChanges: false,
    commitsAhead: 0,
    commitsBehind: 0,
  };
}

function buildDefaultAppStatus(localInfo, systemState) {
  return {
    supported: true,
    mode: "git",
    checking: false,
    updating: Boolean(systemState?.appUpdate?.updating),
    checkedAt: systemState?.appUpdate?.lastCheckedAt || "",
    lastUpdatedAt: systemState?.appUpdate?.lastUpdatedAt || "",
    lastError: systemState?.appUpdate?.lastError || "",
    source: {
      remoteName: localInfo.remoteName || "",
      remoteLabel: localInfo.remoteLabel || "",
      branch: localInfo.branch || "",
    },
    current: {
      version: localInfo.version || "0.0.0",
      commit: localInfo.commit || "",
      shortCommit: localInfo.shortCommit || "",
    },
    currentVersion: localInfo.version || "0.0.0",
    currentCommitSha: localInfo.commit || "",
    latest: {
      version: systemState?.appUpdate?.latestVersion || localInfo.version || "0.0.0",
      commit: systemState?.appUpdate?.latestCommitSha || localInfo.commit || "",
      shortCommit: ensureShortCommit(systemState?.appUpdate?.latestCommitSha || localInfo.commit || ""),
    },
    latestVersion: systemState?.appUpdate?.latestVersion || localInfo.version || "0.0.0",
    latestCommitSha: systemState?.appUpdate?.latestCommitSha || localInfo.commit || "",
    updateAvailable: Boolean(systemState?.appUpdate?.updateAvailable),
    canFastForward: true,
    hasLocalChanges: false,
    commitsAhead: 0,
    commitsBehind: 0,
  };
}

function buildDefaultCloudStatus(config, systemState) {
  return {
    supported: true,
    enabled: config.enabled !== false,
    autoSync: Boolean(config.autoSync),
    checking: false,
    syncing: Boolean(systemState?.upstreamCloud?.syncing),
    checkedAt: systemState?.upstreamCloud?.lastCheckedAt || "",
    lastSyncedAt: systemState?.upstreamCloud?.lastSyncedAt || "",
    lastError: systemState?.upstreamCloud?.lastError || "",
    source: {
      repoOwner: config.repoOwner,
      repoName: config.repoName,
      repoLabel: `${config.repoOwner}/${config.repoName}`,
      branch: config.branch,
      directory: config.directory,
    },
    config: {
      enabled: config.enabled !== false,
      autoSync: Boolean(config.autoSync),
      repoOwner: config.repoOwner,
      repoName: config.repoName,
      branch: config.branch,
      directory: config.directory,
    },
    latest: {
      commit: systemState?.upstreamCloud?.latestCommitSha || "",
      shortCommit: ensureShortCommit(systemState?.upstreamCloud?.latestCommitSha || ""),
    },
    latestCommitSha: systemState?.upstreamCloud?.latestCommitSha || "",
    lastSynced: {
      commit: systemState?.upstreamCloud?.lastSyncedCommitSha || "",
      shortCommit: ensureShortCommit(systemState?.upstreamCloud?.lastSyncedCommitSha || ""),
      sourceKey: systemState?.upstreamCloud?.lastSyncedSourceKey || "",
    },
    lastSyncedCommitSha: systemState?.upstreamCloud?.lastSyncedCommitSha || "",
    lastSyncedAt: systemState?.upstreamCloud?.lastSyncedAt || "",
    installedModules: Array.isArray(systemState?.upstreamCloud?.installedModules)
      ? [...systemState.upstreamCloud.installedModules]
      : [],
    updateAvailable: Boolean(systemState?.upstreamCloud?.updateAvailable),
  };
}

async function getRepositoryContext() {
  const remoteName = trimGitRefValue(process.env.SNAIL_GIT_REMOTE || "origin") || "origin";
  const remoteUrl = trimGitRefValue((await runGit(["remote", "get-url", remoteName])).stdout);
  const branchOutput = trimGitRefValue((await runGit(["rev-parse", "--abbrev-ref", "HEAD"])).stdout);
  const branch = trimGitRefValue(process.env.SNAIL_UPDATE_BRANCH || branchOutput || "main") || "main";

  return {
    remoteName,
    remoteUrl,
    remoteLabel: formatRemoteLabel(remoteUrl, remoteName),
    branch,
    remoteRef: `${remoteName}/${branch}`,
  };
}

async function getLocalRepositoryInfo(force = false) {
  if (!force && cacheState.localInfo && Date.now() - cacheState.localInfoAt < APP_CHECK_TTL_MS) {
    return cacheState.localInfo;
  }

  const packageMeta = await readPackageMeta(packageFile);
  const context = await getRepositoryContext();
  const commit = trimGitRefValue((await runGit(["rev-parse", "HEAD"])).stdout);
  const localInfo = {
    name: packageMeta.name,
    version: packageMeta.version,
    commit,
    shortCommit: ensureShortCommit(commit),
    branch: context.branch,
    remoteName: context.remoteName,
    remoteUrl: context.remoteUrl,
    remoteLabel: context.remoteLabel,
  };

  cacheState.localInfo = localInfo;
  cacheState.localInfoAt = Date.now();
  return localInfo;
}

async function getReadonlyLocalInfo(force = false) {
  if (!force && cacheState.localInfo && Date.now() - cacheState.localInfoAt < APP_CHECK_TTL_MS) {
    return cacheState.localInfo;
  }

  const packageMeta = await readPackageMeta(packageFile);
  const context = getReadonlyUpdateContext();
  const localInfo = {
    name: packageMeta.name,
    version: packageMeta.version,
    commit: trimGitRefValue(process.env.SNAIL_BUILD_COMMIT || ""),
    shortCommit: ensureShortCommit(process.env.SNAIL_BUILD_COMMIT || ""),
    branch: context.branch,
    remoteName: context.remoteName,
    remoteUrl: context.remoteUrl,
    remoteLabel: context.remoteLabel,
  };

  cacheState.localInfo = localInfo;
  cacheState.localInfoAt = Date.now();
  return localInfo;
}

async function hasLocalChanges() {
  const result = await runGit(["status", "--porcelain"]);
  return trimGitRefValue(result.stdout).length > 0;
}

async function fetchRemoteRef(context, force = false) {
  if (!force && cacheState.appStatus && Date.now() - cacheState.appStatusAt < APP_CHECK_TTL_MS) {
    return;
  }

  await runGit(["fetch", context.remoteName, context.branch]);
}

async function getRemotePackageMeta(remoteRef) {
  const result = await runGit(["show", `${remoteRef}:package.json`]);
  return JSON.parse(result.stdout.toString());
}

async function buildAppUpdateStatus(force = false) {
  if (!force && cacheState.appStatus && Date.now() - cacheState.appStatusAt < APP_CHECK_TTL_MS) {
    return cacheState.appStatus;
  }

  const systemState = await loadSystemState();
  let localInfo;
  let fallback;

  try {
    localInfo = await getLocalRepositoryInfo(force);
    fallback = buildDefaultAppStatus(localInfo, systemState);
  } catch (error) {
    localInfo = await getReadonlyLocalInfo(force);
    const dockerSupported = await canUseDockerSelfUpdate();
    const readonlyMode = dockerSupported ? "docker" : "readonly";
    fallback = {
      supported: dockerSupported,
      mode: readonlyMode,
      checking: false,
      updating: Boolean(systemState?.appUpdate?.updating),
      checkedAt: systemState?.appUpdate?.lastCheckedAt || "",
      lastUpdatedAt: systemState?.appUpdate?.lastUpdatedAt || "",
      lastError: "",
      source: {
        remoteName: localInfo.remoteName || "",
        remoteLabel: localInfo.remoteLabel || "",
        branch: localInfo.branch || "",
      },
      current: {
        version: localInfo.version || "0.0.0",
        commit: localInfo.commit || "",
        shortCommit: localInfo.shortCommit || "",
      },
      currentVersion: localInfo.version || "0.0.0",
      currentCommitSha: localInfo.commit || "",
      latest: {
        version: systemState?.appUpdate?.latestVersion || localInfo.version || "0.0.0",
        commit: systemState?.appUpdate?.latestCommitSha || "",
        shortCommit: ensureShortCommit(systemState?.appUpdate?.latestCommitSha || ""),
      },
      latestVersion: systemState?.appUpdate?.latestVersion || localInfo.version || "0.0.0",
      latestCommitSha: systemState?.appUpdate?.latestCommitSha || "",
      updateAvailable: Boolean(systemState?.appUpdate?.updateAvailable),
      canFastForward: dockerSupported,
      hasLocalChanges: false,
      commitsAhead: 0,
      commitsBehind: 0,
    };

    try {
      const payload = await buildReadonlyRemoteAppStatus(fallback, {
        supported: dockerSupported,
        mode: readonlyMode,
      });
      cacheState.appStatus = payload;
      cacheState.appStatusAt = Date.now();
      await updateSystemState({
        appUpdate: {
          supported: dockerSupported,
          mode: readonlyMode,
          currentVersion: payload.currentVersion,
          currentCommitSha: payload.currentCommitSha,
          latestVersion: payload.latestVersion,
          latestCommitSha: payload.latestCommitSha,
          updateAvailable: payload.updateAvailable,
          checking: false,
          updating: false,
          lastCheckedAt: payload.checkedAt,
          lastError: "",
        },
      });
      return payload;
    } catch (readonlyError) {
      const payload = {
        ...fallback,
        lastError: readonlyError.message || error.message,
      };
      cacheState.appStatus = payload;
      cacheState.appStatusAt = Date.now();
      await updateSystemState({
        appUpdate: {
          supported: dockerSupported,
          mode: readonlyMode,
          currentVersion: payload.currentVersion,
          currentCommitSha: payload.currentCommitSha,
          latestVersion: payload.latestVersion,
          latestCommitSha: payload.latestCommitSha,
          updateAvailable: false,
          checking: false,
          updating: false,
          lastCheckedAt: new Date().toISOString(),
          lastError: payload.lastError,
        },
      });
      return payload;
    }
  }

  try {
    const context = await getRepositoryContext();
    await updateSystemState({
      appUpdate: {
        supported: true,
        checking: true,
        currentVersion: localInfo.version,
        currentCommitSha: localInfo.commit,
        lastError: "",
      },
    });

    await fetchRemoteRef(context, force);

    const remoteCommit = trimGitRefValue((await runGit(["rev-parse", context.remoteRef])).stdout);
    const remotePackage = await getRemotePackageMeta(context.remoteRef);
    const counts = trimGitRefValue(
      (await runGit(["rev-list", "--left-right", "--count", `HEAD...${context.remoteRef}`])).stdout,
    ).split(/\s+/);
    const commitsAhead = Number.parseInt(counts[0] || "0", 10) || 0;
    const commitsBehind = Number.parseInt(counts[1] || "0", 10) || 0;
    const localChanges = await hasLocalChanges();
    const checkedAt = new Date().toISOString();

    const payload = {
      supported: true,
      mode: "git",
      checking: false,
      updating: Boolean(systemState.appUpdate.updating),
      checkedAt,
      lastUpdatedAt: systemState.appUpdate.lastUpdatedAt || "",
      lastError: "",
      source: {
        remoteName: context.remoteName,
        remoteLabel: context.remoteLabel,
        branch: context.branch,
      },
      current: {
        version: localInfo.version,
        commit: localInfo.commit,
        shortCommit: localInfo.shortCommit,
      },
      currentVersion: localInfo.version,
      currentCommitSha: localInfo.commit,
      latest: {
        version: remotePackage.version || localInfo.version,
        commit: remoteCommit,
        shortCommit: ensureShortCommit(remoteCommit),
      },
      latestVersion: remotePackage.version || localInfo.version,
      latestCommitSha: remoteCommit,
      updateAvailable: commitsBehind > 0,
      canFastForward: commitsAhead === 0,
      hasLocalChanges: localChanges,
      commitsAhead,
      commitsBehind,
    };

    cacheState.appStatus = payload;
    cacheState.appStatusAt = Date.now();
    await updateSystemState({
      appUpdate: {
        supported: true,
        mode: "git",
        currentVersion: payload.current.version,
        currentCommitSha: payload.current.commit,
        latestVersion: payload.latest.version,
        latestCommitSha: payload.latest.commit,
        updateAvailable: payload.updateAvailable,
        checking: false,
        updating: Boolean(systemState.appUpdate.updating),
        lastCheckedAt: checkedAt,
        lastError: "",
      },
    });
    return payload;
  } catch (error) {
    let payload = {
      ...fallback,
      checking: false,
      lastError: error.message,
    };

    try {
      payload = await buildReadonlyRemoteAppStatus(payload, {
        supported: false,
        mode: "readonly",
        lastError: error.message,
      });
    } catch {
      // Keep the original git fallback when readonly metadata is also unavailable.
    }

    cacheState.appStatus = payload;
    cacheState.appStatusAt = Date.now();
    await updateSystemState({
      appUpdate: {
        supported: payload.supported,
        mode: payload.mode,
        checking: false,
        currentVersion: payload.current.version,
        currentCommitSha: payload.current.commit,
        latestVersion: payload.latest.version,
        latestCommitSha: payload.latest.commit,
        updateAvailable: payload.updateAvailable,
        lastCheckedAt: new Date().toISOString(),
        lastError: payload.lastError,
      },
    });
    return payload;
  }
}

async function runNpmInstall() {
  const npmCommand = getNpmCommand();
  const args = fs.existsSync(path.join(repoRoot, "package-lock.json"))
    ? ["ci", "--omit=dev"]
    : ["install", "--omit=dev"];
  if (process.platform === "win32") {
    await runCommand("cmd.exe", ["/d", "/s", "/c", `${npmCommand} ${args.join(" ")}`]);
    return;
  }

  await runCommand(npmCommand, args);
}

function collectDockerUpdateEnvEntries() {
  return DOCKER_UPDATE_ENV_KEYS.map((key) => [key, trimGitRefValue(process.env[key] || "")]).filter(
    ([, value]) => Boolean(value),
  );
}

function buildDockerHelperContainerName(containerName) {
  return `${containerName}-updater-${Date.now()}`;
}

function buildDockerHelperRunArgs(context) {
  const helperName = buildDockerHelperContainerName(context.containerName);
  const args = [
    "run",
    "--rm",
    "-d",
    "--name",
    helperName,
    "-v",
    `${context.socketPath}:${context.socketPath}`,
    "-v",
    `${context.hostDataDir}:/host-data`,
  ];

  collectDockerUpdateEnvEntries().forEach(([key, value]) => {
    args.push("-e", `${key}=${value}`);
  });

  args.push("--entrypoint", "node", context.image);
  args.push("scripts/docker-self-update.js");
  return args;
}

async function runDockerSelfUpdate(status) {
  const context = getDockerUpdateContext();
  if (!(await canUseDockerSelfUpdate())) {
    throw new Error("Docker online update is not available in the current deployment.");
  }

  await updateSystemState({
    appUpdate: {
      supported: true,
      mode: "docker",
      updating: true,
      updateAvailable: false,
      lastError: "",
    },
  });

  try {
    await runCommand(context.command, [...context.commandArgs, "pull", context.image]);
    await runCommand(context.command, [...context.commandArgs, ...buildDockerHelperRunArgs(context)]);
    invalidateCaches();

    return {
      updated: true,
      restartRequired: true,
      shouldExitCurrentProcess: false,
      status: {
        ...status,
        supported: true,
        mode: "docker",
        updating: true,
        updateAvailable: false,
        lastError: "",
      },
    };
  } catch (error) {
    await updateSystemState({
      appUpdate: {
        updating: false,
        lastError: error.message,
      },
    });
    throw error;
  }
}

async function runSystemUpdate() {
  if (cacheState.updatePromise) {
    return cacheState.updatePromise;
  }

  cacheState.updatePromise = (async () => {
    const status = await buildAppUpdateStatus(true);
    if (status.lastError) {
      throw new Error(status.lastError);
    }

    if (!status.supported) {
      throw new Error("The current deployment can only check versions and cannot update automatically.");
    }

    if (!status.updateAvailable) {
      return {
        updated: false,
        restartRequired: false,
        shouldExitCurrentProcess: false,
        status,
      };
    }

    if (status.mode === "docker") {
      return runDockerSelfUpdate(status);
    }

    if (!status.canFastForward) {
      throw new Error("The current repository has local commits and cannot fast-forward.");
    }

    if (status.hasLocalChanges) {
      throw new Error("The current repository has uncommitted changes and cannot update automatically.");
    }

    const context = await getRepositoryContext();
    await updateSystemState({
      appUpdate: {
        updating: true,
        lastError: "",
      },
    });

    try {
      await runGit(["pull", "--ff-only", context.remoteName, context.branch]);
      await runNpmInstall();
      invalidateCaches();
      const nextStatus = await buildAppUpdateStatus(true);
      await updateSystemState({
        appUpdate: {
          updating: false,
          lastUpdatedAt: new Date().toISOString(),
          lastError: "",
        },
      });

      return {
        updated: true,
        restartRequired: true,
        shouldExitCurrentProcess: true,
        status: nextStatus,
      };
    } catch (error) {
      await updateSystemState({
        appUpdate: {
          updating: false,
          lastError: error.message,
        },
      });
      throw error;
    }
  })();

  try {
    return await cacheState.updatePromise;
  } finally {
    cacheState.updatePromise = null;
  }
}

async function getCloudInstalledModules() {
  if (!fs.existsSync(syncedUpstreamsDir)) {
    return [];
  }

  const entries = await fsPromises.readdir(syncedUpstreamsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function getGitHubBranchCommit(config) {
  const remoteUrl = buildCloudRemoteUrl(config);
  const result = await runGit(["ls-remote", remoteUrl, `refs/heads/${config.branch}`]);
  const line = trimGitRefValue(result.stdout).split(/\r?\n/).find(Boolean) || "";
  return trimGitRefValue(line.split(/\s+/)[0] || "");
}

async function buildUpstreamCloudStatus(force = false) {
  if (!force && cacheState.cloudStatus && Date.now() - cacheState.cloudStatusAt < CLOUD_CHECK_TTL_MS) {
    return cacheState.cloudStatus;
  }

  const config = await getUpstreamCloudConfig();
  const systemState = await loadSystemState();
  const fallback = buildDefaultCloudStatus(config, systemState);
  const sourceKey = buildCloudSourceKey(config);

  if (!config.enabled) {
    cacheState.cloudStatus = {
      ...fallback,
      supported: true,
      enabled: false,
      updateAvailable: false,
    };
    cacheState.cloudStatusAt = Date.now();
    return cacheState.cloudStatus;
  }

  try {
    await updateSystemState({
      upstreamCloud: {
        checking: true,
        lastError: "",
      },
    });

    const latestCommit = await getGitHubBranchCommit(config);
    const installedModules = await getCloudInstalledModules();
    const checkedAt = new Date().toISOString();
    const sourceChanged = (systemState.upstreamCloud.lastSyncedSourceKey || "") !== sourceKey;
    const updateAvailable =
      sourceChanged ||
      !latestCommit ||
      latestCommit !== (systemState.upstreamCloud.lastSyncedCommitSha || "") ||
      installedModules.length === 0;

    const payload = {
      supported: true,
      enabled: true,
      autoSync: Boolean(config.autoSync),
      checking: false,
      syncing: Boolean(systemState.upstreamCloud.syncing),
      checkedAt,
      lastSyncedAt: systemState.upstreamCloud.lastSyncedAt || "",
      lastError: "",
      source: {
        repoOwner: config.repoOwner,
        repoName: config.repoName,
        repoLabel: `${config.repoOwner}/${config.repoName}`,
        branch: config.branch,
        directory: config.directory,
      },
      config: {
        enabled: true,
        autoSync: Boolean(config.autoSync),
        repoOwner: config.repoOwner,
        repoName: config.repoName,
        branch: config.branch,
        directory: config.directory,
      },
      latest: {
        commit: latestCommit,
        shortCommit: ensureShortCommit(latestCommit),
      },
      latestCommitSha: latestCommit,
      lastSynced: {
        commit: systemState.upstreamCloud.lastSyncedCommitSha || "",
        shortCommit: ensureShortCommit(systemState.upstreamCloud.lastSyncedCommitSha || ""),
        sourceKey: systemState.upstreamCloud.lastSyncedSourceKey || "",
      },
      lastSyncedCommitSha: systemState.upstreamCloud.lastSyncedCommitSha || "",
      lastSyncedAt: systemState.upstreamCloud.lastSyncedAt || "",
      installedModules,
      updateAvailable: Boolean(latestCommit) && updateAvailable,
    };

    cacheState.cloudStatus = payload;
    cacheState.cloudStatusAt = Date.now();
    await updateSystemState({
      upstreamCloud: {
        checking: false,
        lastCheckedAt: checkedAt,
        latestCommitSha: latestCommit,
        updateAvailable: payload.updateAvailable,
        lastError: "",
        installedModules,
      },
    });
    return payload;
  } catch (error) {
    const installedModules = await getCloudInstalledModules();
    const payload = {
      ...fallback,
      checking: false,
      lastError: error.message,
      installedModules,
    };
    cacheState.cloudStatus = payload;
    cacheState.cloudStatusAt = Date.now();
    await updateSystemState({
      upstreamCloud: {
        checking: false,
        lastCheckedAt: new Date().toISOString(),
        lastError: error.message,
        installedModules,
      },
    });
    return payload;
  }
}

async function cloneCloudRepository(config, cloneDir) {
  await runGit([
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--branch",
    config.branch,
    buildCloudRemoteUrl(config),
    cloneDir,
  ], {
    cwd: tempDir,
  });
}

async function restoreSyncedUpstreams(backupDir) {
  await fsPromises.rm(syncedUpstreamsDir, { recursive: true, force: true });
  if (fs.existsSync(backupDir)) {
    await fsPromises.mkdir(path.dirname(syncedUpstreamsDir), { recursive: true });
    await fsPromises.cp(backupDir, syncedUpstreamsDir, { recursive: true });
  }
  reloadUpstreamModules();
}

function isSyncedDiagnostic(item) {
  return trimGitRefValue(item?.modulePath).startsWith(syncedUpstreamsDir);
}

async function syncCloudUpstreams() {
  if (cacheState.syncPromise) {
    return cacheState.syncPromise;
  }

  cacheState.syncPromise = (async () => {
    const config = await getUpstreamCloudConfig();
    if (!config.enabled) {
      return {
        synced: false,
        status: await buildUpstreamCloudStatus(true),
        diagnostics: listUpstreamModuleDiagnostics(),
      };
    }

    await updateSystemState({
      upstreamCloud: {
        syncing: true,
        lastError: "",
      },
    });

    const status = await buildUpstreamCloudStatus(true);
    if (status.lastError) {
      await updateSystemState({
        upstreamCloud: {
          syncing: false,
          lastError: status.lastError,
        },
      });
      invalidateCaches();
      throw new Error(status.lastError);
    }

    if (!status.updateAvailable) {
      await updateSystemState({
        upstreamCloud: {
          syncing: false,
          lastError: "",
        },
      });
      invalidateCaches();
      return {
        synced: false,
        status: await buildUpstreamCloudStatus(true),
        diagnostics: listUpstreamModuleDiagnostics(),
      };
    }

    const syncRoot = path.join(
      tempDir,
      `upstream-sync-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    );
    const cloneDir = path.join(syncRoot, "repo");
    const stageDir = path.join(syncRoot, "stage");
    const backupDir = path.join(syncRoot, "backup");
    const sourceDir = path.join(cloneDir, ...config.directory.split("/"));

    try {
      await fsPromises.mkdir(tempDir, { recursive: true });
      await cloneCloudRepository(config, cloneDir);

      if (!fs.existsSync(sourceDir)) {
        throw new Error(`Cloud directory not found: ${config.directory}`);
      }

      await fsPromises.cp(sourceDir, stageDir, { recursive: true });
      const moduleIds = await getCloudInstalledModulesFrom(stageDir);
      if (moduleIds.length === 0) {
        throw new Error("No upstream modules were found in the cloud directory.");
      }

      if (fs.existsSync(syncedUpstreamsDir)) {
        await fsPromises.cp(syncedUpstreamsDir, backupDir, { recursive: true });
      }

      await fsPromises.rm(syncedUpstreamsDir, { recursive: true, force: true });
      await fsPromises.mkdir(path.dirname(syncedUpstreamsDir), { recursive: true });
      await fsPromises.cp(stageDir, syncedUpstreamsDir, { recursive: true });
      reloadUpstreamModules();

      const diagnostics = listUpstreamModuleDiagnostics().filter(isSyncedDiagnostic);
      if (diagnostics.length > 0) {
        await restoreSyncedUpstreams(backupDir);
        throw new Error(
          `Synced upstream modules failed validation: ${diagnostics.map((item) => item.id).join(", ")}`,
        );
      }

      const syncedAt = new Date().toISOString();
      await updateSystemState({
        upstreamCloud: {
          syncing: false,
          lastCheckedAt: status.checkedAt || syncedAt,
          lastSyncedAt: syncedAt,
          latestCommitSha: status.latest.commit,
          lastSyncedCommitSha: status.latest.commit,
          lastSyncedSourceKey: buildCloudSourceKey(config),
          updateAvailable: false,
          lastError: "",
          installedModules: moduleIds,
        },
      });
      invalidateCaches();

      return {
        synced: true,
        syncedAt,
        syncedModuleIds: moduleIds,
        diagnostics: listUpstreamModuleDiagnostics(),
        status: await buildUpstreamCloudStatus(true),
      };
    } catch (error) {
      await restoreSyncedUpstreams(backupDir);
      await updateSystemState({
        upstreamCloud: {
          syncing: false,
          lastError: error.message,
        },
      });
      invalidateCaches();
      throw error;
    } finally {
      await fsPromises.rm(syncRoot, { recursive: true, force: true });
    }
  })();

  try {
    return await cacheState.syncPromise;
  } finally {
    cacheState.syncPromise = null;
  }
}

async function getCloudInstalledModulesFrom(rootDir) {
  const entries = await fsPromises.readdir(rootDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function ensureCloudUpstreamsReady() {
  const config = await getUpstreamCloudConfig();
  const status = await buildUpstreamCloudStatus(false);
  if (!config.enabled || !config.autoSync || !status.updateAvailable || status.lastError) {
    return status;
  }

  try {
    const result = await syncCloudUpstreams();
    return result.status;
  } catch (error) {
    return buildUpstreamCloudStatus(true);
  }
}

function scheduleProcessRestart() {
  const helperScript = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const nodePath = process.argv[1];
const args = JSON.parse(process.argv[2]);
const cwd = process.argv[3];
const dataDir = process.argv[4];
setTimeout(() => {
  const outPath = path.join(dataDir, "server-update.out.log");
  const errPath = path.join(dataDir, "server-update.err.log");
  const stdout = fs.openSync(outPath, "a");
  const stderr = fs.openSync(errPath, "a");
  const child = spawn(nodePath, args, {
    cwd,
    detached: true,
    stdio: ["ignore", stdout, stderr],
    env: process.env,
  });
  child.unref();
}, 1500);
`;

  const helper = execFile(
    process.execPath,
    ["-e", helperScript, process.execPath, JSON.stringify(process.argv.slice(1)), repoRoot, dataDir],
    {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    },
  );
  helper.unref();
}

module.exports = {
  buildAppUpdateStatus,
  buildUpstreamCloudStatus,
  ensureCloudUpstreamsReady,
  getLocalRepositoryInfo,
  invalidateCaches,
  runSystemUpdate,
  scheduleProcessRestart,
  syncCloudUpstreams,
};
