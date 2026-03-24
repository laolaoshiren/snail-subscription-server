"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const password = (process.env.PANEL_PASSWORD || "").trim();
const dataDir =
  process.env.ACCOUNT_DATA_DIR ||
  process.env.SNAIL_DATA_DIR ||
  path.join(__dirname, "..", "data");
const accountFile = path.join(dataDir, "account.json");

if (password.length < 4) {
  console.error("PANEL_PASSWORD must be at least 4 characters.");
  process.exit(1);
}

let relayToken = crypto.randomBytes(24).toString("hex");

try {
  const existing = JSON.parse(fs.readFileSync(accountFile, "utf8"));
  if (typeof existing.relayToken === "string" && existing.relayToken.trim()) {
    relayToken = existing.relayToken.trim();
  }
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}

const salt = crypto.randomBytes(16).toString("hex");
const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  accountFile,
  JSON.stringify(
    {
      passwordSalt: salt,
      passwordHash,
      relayToken,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
  "utf8",
);

console.log(accountFile);
