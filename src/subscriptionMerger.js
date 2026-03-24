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

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
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

function collectUniqueValues(values) {
  const seen = new Set();
  const result = [];

  values.forEach((value) => {
    const normalized = (value || "").toString();
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    result.push(normalized);
  });

  return result;
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

function normalizeSourceEntry(entry) {
  if (Buffer.isBuffer(entry)) {
    return {
      bodyBuffer: entry,
      sourceLabel: "",
    };
  }

  const bodyBuffer = Buffer.isBuffer(entry?.body)
    ? entry.body
    : Buffer.isBuffer(entry?.bodyBuffer)
      ? entry.bodyBuffer
      : null;

  if (!bodyBuffer) {
    return null;
  }

  return {
    bodyBuffer,
    sourceLabel: (entry.sourceLabel || entry.instanceLabel || "").toString().trim(),
  };
}

function normalizeSourceEntries(entries) {
  return (Array.isArray(entries) ? entries : []).map(normalizeSourceEntry).filter(Boolean);
}

function appendSourceLabel(name, sourceLabel) {
  const baseName = (name || "node").toString().trim() || "node";
  if (!sourceLabel) {
    return baseName;
  }

  return `${baseName} · ${sourceLabel}`;
}

function extractBodyBuffers(entries) {
  return normalizeSourceEntries(entries).map((entry) => entry.bodyBuffer);
}

function mergeUniversalBodies(entries) {
  const decodedSegments = extractBodyBuffers(entries)
    .map((bodyBuffer) => bodyBuffer.toString("utf8").trim())
    .map((body) => tryDecodeBase64(body) || body)
    .filter(Boolean);
  const lines = collectUniqueLines(decodedSegments);
  return Buffer.from(encodeBase64(lines.join("\n")), "utf8");
}

function replaceTemplateProxyNames(values, templateProxyNameSet, mergedProxyNames) {
  const nextValues = [];
  let insertedMergedProxies = false;

  values.forEach((value) => {
    if (templateProxyNameSet.has(value)) {
      if (!insertedMergedProxies) {
        nextValues.push(...mergedProxyNames);
        insertedMergedProxies = true;
      }
      return;
    }

    nextValues.push(value);
  });

  return collectUniqueValues(nextValues);
}

function mergeClashTemplate(template, proxies) {
  const nextTemplate = cloneSerializable(template);
  const templateProxyNames = collectUniqueValues(
    (Array.isArray(nextTemplate?.proxies) ? nextTemplate.proxies : []).map((proxy) =>
      proxy && typeof proxy === "object" ? proxy.name : "",
    ),
  );
  const templateProxyNameSet = new Set(templateProxyNames);
  const mergedProxyNames = proxies.map((proxy) => proxy.name).filter(Boolean);

  nextTemplate.proxies = proxies;

  if (Array.isArray(nextTemplate["proxy-groups"])) {
    nextTemplate["proxy-groups"] = nextTemplate["proxy-groups"].map((group) => {
      if (!group || typeof group !== "object" || !Array.isArray(group.proxies)) {
        return group;
      }

      if (!group.proxies.some((value) => templateProxyNameSet.has(value))) {
        return group;
      }

      return {
        ...cloneSerializable(group),
        proxies: replaceTemplateProxyNames(group.proxies, templateProxyNameSet, mergedProxyNames),
      };
    });
  }

  return nextTemplate;
}

function mergeClashBodies(entries, options = {}) {
  const usedNames = new Set();
  const proxies = [];

  normalizeSourceEntries(entries).forEach((entry) => {
    const parsed = yaml.load(entry.bodyBuffer.toString("utf8"));
    const sourceProxies = Array.isArray(parsed?.proxies)
      ? parsed.proxies
      : Array.isArray(parsed)
        ? parsed
        : [];

    sourceProxies.forEach((proxy) => {
      if (!proxy || typeof proxy !== "object") {
        return;
      }

      const nextProxy = cloneSerializable(proxy);
      nextProxy.name = buildUniqueName(
        appendSourceLabel(nextProxy.name, entry.sourceLabel),
        usedNames,
      );
      proxies.push(nextProxy);
    });
  });

  const mergedConfig =
    options.clashTemplate && typeof options.clashTemplate === "object"
      ? mergeClashTemplate(options.clashTemplate, proxies)
      : {
          proxies,
        };

  return Buffer.from(
    yaml.dump(mergedConfig, {
      noRefs: true,
      lineWidth: -1,
    }),
    "utf8",
  );
}

function mergeSingBoxBodies(entries) {
  const usedTags = new Set();
  const outbounds = [];

  extractBodyBuffers(entries).forEach((bodyBuffer) => {
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

function mergePlainTextBodies(entries) {
  const lines = collectUniqueLines(extractBodyBuffers(entries).map((bodyBuffer) => bodyBuffer.toString("utf8")));
  return Buffer.from(lines.join("\n"), "utf8");
}

function mergeSubscriptionBodies(type, entries, options = {}) {
  const normalizedType = (type || "").toString().trim().toLowerCase();
  const sourceEntries = normalizeSourceEntries(entries);
  if (sourceEntries.length === 0) {
    return Buffer.from("", "utf8");
  }

  if (normalizedType === "universal") {
    return mergeUniversalBodies(sourceEntries);
  }

  if (normalizedType === "clash") {
    return mergeClashBodies(sourceEntries, options);
  }

  if (normalizedType === "sing-box") {
    return mergeSingBoxBodies(sourceEntries);
  }

  return mergePlainTextBodies(sourceEntries);
}

module.exports = {
  mergeSubscriptionBodies,
};
