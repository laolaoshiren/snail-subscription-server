"use strict";

const yaml = require("js-yaml");

function normalizeBase64Padding(value) {
  const remainder = value.length % 4;
  if (remainder === 0) {
    return value;
  }

  return value.padEnd(value.length + (4 - remainder), "=");
}

function tryDecodeBase64(value) {
  const normalized = normalizeBase64Padding(value.replace(/-/g, "+").replace(/_/g, "/"));

  try {
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch (error) {
    return "";
  }
}

function encodeBase64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function collectUniqueLines(values) {
  const seen = new Set();
  const lines = [];

  values.forEach((value) => {
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        if (seen.has(line)) {
          return;
        }

        seen.add(line);
        lines.push(line);
      });
  });

  return lines;
}

function buildUniqueName(name, usedNames) {
  const baseName = (name || "node").toString().trim() || "node";
  let candidate = baseName;
  let suffix = 2;

  while (usedNames.has(candidate)) {
    candidate = `${baseName} ${suffix}`;
    suffix += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function mergeUniversalBodies(bodyBuffers) {
  const decodedSegments = bodyBuffers
    .map((bodyBuffer) => bodyBuffer.toString("utf8").trim())
    .map((body) => tryDecodeBase64(body) || body)
    .filter(Boolean);
  const lines = collectUniqueLines(decodedSegments);
  return Buffer.from(encodeBase64(lines.join("\n")), "utf8");
}

function mergeClashBodies(bodyBuffers) {
  const usedNames = new Set();
  const proxies = [];

  bodyBuffers.forEach((bodyBuffer) => {
    const parsed = yaml.load(bodyBuffer.toString("utf8"));
    const sourceProxies = Array.isArray(parsed?.proxies)
      ? parsed.proxies
      : Array.isArray(parsed)
        ? parsed
        : [];

    sourceProxies.forEach((proxy) => {
      if (!proxy || typeof proxy !== "object") {
        return;
      }

      const nextProxy = { ...proxy };
      nextProxy.name = buildUniqueName(nextProxy.name, usedNames);
      proxies.push(nextProxy);
    });
  });

  return Buffer.from(
    yaml.dump(
      {
        proxies,
      },
      {
        noRefs: true,
        lineWidth: -1,
      },
    ),
    "utf8",
  );
}

function mergeSingBoxBodies(bodyBuffers) {
  const usedTags = new Set();
  const outbounds = [];

  bodyBuffers.forEach((bodyBuffer) => {
    const parsed = JSON.parse(bodyBuffer.toString("utf8"));
    const sourceOutbounds = Array.isArray(parsed?.outbounds)
      ? parsed.outbounds
      : Array.isArray(parsed)
        ? parsed
        : [];

    sourceOutbounds.forEach((outbound) => {
      if (!outbound || typeof outbound !== "object") {
        return;
      }

      const nextOutbound = { ...outbound };
      if (typeof nextOutbound.tag === "string" && nextOutbound.tag.trim()) {
        nextOutbound.tag = buildUniqueName(nextOutbound.tag, usedTags);
      } else {
        nextOutbound.tag = buildUniqueName("outbound", usedTags);
      }
      outbounds.push(nextOutbound);
    });
  });

  return Buffer.from(
    JSON.stringify(
      {
        outbounds,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function mergePlainTextBodies(bodyBuffers) {
  const lines = collectUniqueLines(bodyBuffers.map((bodyBuffer) => bodyBuffer.toString("utf8")));
  return Buffer.from(lines.join("\n"), "utf8");
}

function mergeSubscriptionBodies(type, bodyBuffers) {
  const normalizedType = (type || "").toString().trim().toLowerCase();
  if (!Array.isArray(bodyBuffers) || bodyBuffers.length === 0) {
    return Buffer.from("", "utf8");
  }

  if (normalizedType === "universal") {
    return mergeUniversalBodies(bodyBuffers);
  }

  if (normalizedType === "clash") {
    return mergeClashBodies(bodyBuffers);
  }

  if (normalizedType === "sing-box") {
    return mergeSingBoxBodies(bodyBuffers);
  }

  return mergePlainTextBodies(bodyBuffers);
}

module.exports = {
  mergeSubscriptionBodies,
};
