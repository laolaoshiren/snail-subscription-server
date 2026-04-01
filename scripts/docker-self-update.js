"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function trimValue(value) {
  return (value || "").toString().trim();
}

const HOST_DATA_DIR = trimValue(process.env.SNAIL_DOCKER_HELPER_DATA_MOUNT || "/host-data") || "/host-data";
const SYSTEM_STATE_FILE = path.join(HOST_DATA_DIR, "system-state.json");
const DEFAULT_SOCKET_PATH = trimValue(process.env.SNAIL_DOCKER_SOCKET_PATH || "/var/run/docker.sock") || "/var/run/docker.sock";
const DEFAULT_DOCKER_COMMAND = trimValue(process.env.SNAIL_DOCKER_COMMAND || "docker") || "docker";
function parseCommandArgs(value) {
  const rawValue = trimValue(value);
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

const DEFAULT_DOCKER_COMMAND_ARGS = parseCommandArgs(process.env.SNAIL_DOCKER_COMMAND_ARGS || "");
const UPDATE_ENV_KEYS = [
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
  "SNAIL_DOCKER_NETWORK_MODE",
  "SNAIL_UPDATE_REPO_OWNER",
  "SNAIL_UPDATE_REPO_NAME",
  "SNAIL_UPDATE_BRANCH",
];

function normalizeNetworkMode(value) {
  const normalized = trimValue(value).toLowerCase();
  return normalized === "host" ? "host" : "bridge";
}

function readSystemState() {
  try {
    return JSON.parse(fs.readFileSync(SYSTEM_STATE_FILE, "utf8"));
  } catch (error) {
    return {};
  }
}

function writeSystemState(patch = {}) {
  const currentState = readSystemState();
  const nextState = {
    ...currentState,
    ...patch,
    appUpdate: {
      ...(currentState.appUpdate || {}),
      ...((patch && patch.appUpdate) || {}),
    },
    upstreamCloud: {
      ...(currentState.upstreamCloud || {}),
      ...((patch && patch.upstreamCloud) || {}),
    },
  };

  fs.mkdirSync(HOST_DATA_DIR, { recursive: true });
  fs.writeFileSync(SYSTEM_STATE_FILE, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
}

function runDocker(args, allowFailure = false) {
  try {
    return execFileSync(DEFAULT_DOCKER_COMMAND, [...DEFAULT_DOCKER_COMMAND_ARGS, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFailure) {
      return (error.stdout || "").toString();
    }

    const details = (error.stderr || error.stdout || error.message || "").toString().trim();
    throw new Error(details || `docker ${args[0]} failed.`);
  }
}

function buildMainContainerRunArgs(context) {
  const args = [
    "run",
    "-d",
    "--name",
    context.containerName,
    "--restart",
    "unless-stopped",
    "-v",
    `${context.hostDataDir}:/app/data`,
    "-v",
    `${context.socketPath}:${context.socketPath}`,
  ];

  if (context.networkMode === "host") {
    args.push("--network", "host");
  } else {
    args.push("-p", `${context.port}:${context.port}`);
  }

  UPDATE_ENV_KEYS.forEach((key) => {
    const value = trimValue(process.env[key] || "");
    if (value) {
      args.push("-e", `${key}=${value}`);
    }
  });

  args.push(context.image);
  return args;
}

function getContext() {
  return {
    image: trimValue(process.env.SNAIL_DOCKER_IMAGE || ""),
    containerName: trimValue(process.env.SNAIL_DOCKER_CONTAINER_NAME || ""),
    hostDataDir: trimValue(process.env.SNAIL_DOCKER_HOST_DATA_DIR || ""),
    port: trimValue(process.env.PORT || ""),
    socketPath: DEFAULT_SOCKET_PATH,
    networkMode: normalizeNetworkMode(process.env.SNAIL_DOCKER_NETWORK_MODE || ""),
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const context = getContext();
  if (!context.image || !context.containerName || !context.hostDataDir || !context.port) {
    throw new Error("Missing Docker update context.");
  }

  await sleep(1200);
  runDocker(["rm", "-f", context.containerName], true);
  runDocker(buildMainContainerRunArgs(context));

  writeSystemState({
    appUpdate: {
      updating: false,
      updateAvailable: false,
      lastUpdatedAt: new Date().toISOString(),
      lastError: "",
    },
  });
}

main().catch((error) => {
  writeSystemState({
    appUpdate: {
      updating: false,
      lastError: error.message,
    },
  });
  console.error(error.stack || error.message);
  process.exit(1);
});
