"use strict";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

function normalizeString(value) {
  return (value || "").toString().trim();
}

function normalizeUrlBase(input, fallback = "") {
  const value = normalizeString(input) || normalizeString(fallback);
  if (!value) {
    return "";
  }

  const url = new URL(value);
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

function buildUrl(base, pathName, fallback = "") {
  const normalizedBase = normalizeUrlBase(base, fallback);
  const normalizedPath = normalizeString(pathName).replace(/^\/+/, "");
  return new URL(normalizedPath, `${normalizedBase}/`).toString();
}

function toIsoDate(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "";
  }

  const normalized = value > 9_999_999_999 ? value : value * 1000;
  return new Date(normalized).toISOString();
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => normalizeString(value))
        .filter(Boolean),
    ),
  );
}

function splitStringList(value) {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }

  return uniqueStrings(
    normalizeString(value)
      .split(/[\r\n,]+/)
      .map((item) => item.trim()),
  );
}

function buildBrowserHeaders(siteUrl, extraHeaders = {}) {
  const normalizedSite = normalizeUrlBase(siteUrl, siteUrl);
  const nextHeaders = {
    Accept: "application/json, text/plain, */*",
    "User-Agent": BROWSER_UA,
    ...extraHeaders,
  };

  if (normalizedSite) {
    nextHeaders.Origin = normalizeString(extraHeaders.Origin) || normalizedSite;
    nextHeaders.Referer = normalizeString(extraHeaders.Referer) || `${normalizedSite}/`;
  }

  return nextHeaders;
}

function generateRandomPassword() {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const special = "@#$%&*!";
  const all = upper + lower + digits + special;

  let password = "";
  password += upper.charAt(Math.floor(Math.random() * upper.length));
  password += lower.charAt(Math.floor(Math.random() * lower.length));
  password += digits.charAt(Math.floor(Math.random() * digits.length));
  password += special.charAt(Math.floor(Math.random() * special.length));

  for (let index = 0; index < 8; index += 1) {
    password += all.charAt(Math.floor(Math.random() * all.length));
  }

  return password
    .split("")
    .sort(() => Math.random() - 0.5)
    .join("");
}

function generateRandomEmail(options = {}) {
  const prefix = normalizeString(options.prefix) || "relay";
  const whitelist = uniqueStrings(options.whitelist);
  const domain = whitelist[0] || normalizeString(options.defaultDomain) || "gmail.com";
  const local = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 48);

  return `${local}@${domain}`;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }

  return Boolean(value);
}

module.exports = {
  BROWSER_UA,
  buildBrowserHeaders,
  buildUrl,
  generateRandomEmail,
  generateRandomPassword,
  normalizeString,
  normalizeUrlBase,
  parseBoolean,
  splitStringList,
  toIsoDate,
  uniqueStrings,
};
