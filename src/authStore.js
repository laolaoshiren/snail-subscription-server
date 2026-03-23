"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { dataDir } = require("./registrationStore");

const accountFile = path.join(dataDir, "account.json");
const DEFAULT_PASSWORD = "admin";

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createSecurityState(password, relayToken = crypto.randomBytes(24).toString("hex")) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt),
    relayToken,
    updatedAt: new Date().toISOString(),
  };
}

async function saveSecurityState(state) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(accountFile, JSON.stringify(state, null, 2), "utf8");
}

async function loadSecurityState() {
  try {
    const content = await fs.readFile(accountFile, "utf8");
    const state = JSON.parse(content);

    if (!state.passwordSalt || !state.passwordHash) {
      throw new Error("Security file is invalid.");
    }

    if (!state.relayToken) {
      const migratedState = {
        passwordSalt: state.passwordSalt,
        passwordHash: state.passwordHash,
        relayToken: crypto.randomBytes(24).toString("hex"),
        updatedAt: new Date().toISOString(),
      };
      await saveSecurityState(migratedState);
      return migratedState;
    }

    return {
      passwordSalt: state.passwordSalt,
      passwordHash: state.passwordHash,
      relayToken: state.relayToken,
      updatedAt: state.updatedAt || new Date().toISOString(),
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    const defaultState = createSecurityState(DEFAULT_PASSWORD);
    await saveSecurityState(defaultState);
    return defaultState;
  }
}

async function verifyPasswordLogin(password) {
  const state = await loadSecurityState();
  const valid = safeCompare(hashPassword(password, state.passwordSalt), state.passwordHash);

  return {
    valid,
    state,
  };
}

async function updatePassword({ currentPassword, newPassword }) {
  const state = await loadSecurityState();
  const valid = safeCompare(
    hashPassword(currentPassword, state.passwordSalt),
    state.passwordHash,
  );

  if (!valid) {
    throw new Error("Current password is incorrect.");
  }

  const password = (newPassword || "").trim();

  if (!password) {
    throw new Error("New password cannot be empty.");
  }

  if (password.length < 4) {
    throw new Error("New password must be at least 4 characters.");
  }

  const nextState = createSecurityState(password, state.relayToken);
  await saveSecurityState(nextState);
  return {
    updatedAt: nextState.updatedAt,
  };
}

async function validateRelayToken(token) {
  const state = await loadSecurityState();
  return safeCompare((token || "").trim(), state.relayToken);
}

async function getRelayToken() {
  const state = await loadSecurityState();
  return state.relayToken;
}

module.exports = {
  DEFAULT_PASSWORD,
  accountFile,
  getRelayToken,
  loadSecurityState,
  updatePassword,
  validateRelayToken,
  verifyPasswordLogin,
};
