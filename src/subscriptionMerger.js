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

const AGGREGATE_HEALTHCHECK_URL = "http://www.gstatic.com/generate_204";
const AGGREGATE_HEALTHCHECK_INTERVAL_SECONDS = 30;
const AGGREGATE_HEALTHCHECK_TIMEOUT_MS = 5000;
const MAIN_SELECTOR_GROUP_NAME = "\ud83d\udd30 \u8282\u70b9\u9009\u62e9";
const AUTO_SELECT_GROUP_NAME = "\u267b\ufe0f \u81ea\u52a8\u9009\u62e9";
const DIRECT_GROUP_NAME = "\ud83c\udfaf \u5168\u7403\u76f4\u8fde";
const FALLBACK_GROUP_NAME = "\u2699\ufe0f \u6545\u969c\u8f6c\u79fb";
const HONG_KONG_LOAD_BALANCE_GROUP_NAME = "\ud83c\udded\ud83c\uddf0 \u9999\u6e2f\u8d1f\u8f7d\u5747\u8861";
const TOP_PRIORITY_GROUP_NAMES = [
  MAIN_SELECTOR_GROUP_NAME,
  AUTO_SELECT_GROUP_NAME,
  FALLBACK_GROUP_NAME,
];
const CLASH_COUNTRY_GROUP_DEFINITIONS = [
  {
    key: "hong-kong",
    name: "\ud83c\udded\ud83c\uddf0 \u9999\u6e2f\u8282\u70b9",
    match: ({ rawName, normalizedName, tokenSet }) =>
      rawName.includes("\ud83c\udded\ud83c\uddf0") ||
      normalizedName.includes("\u9999\u6e2f") ||
      normalizedName.includes("hong kong") ||
      normalizedName.includes("hongkong") ||
      normalizedName.includes("\u4e5d\u9f99") ||
      normalizedName.includes("\u4e5d\u9f8d") ||
      normalizedName.includes("kowloon") ||
      tokenSet.has("hk") ||
      tokenSet.has("hkg"),
  },
  {
    key: "taiwan",
    name: "\ud83c\uddf9\ud83c\uddfc \u53f0\u6e7e\u8282\u70b9",
    match: ({ rawName, normalizedName, tokenSet }) =>
      rawName.includes("\ud83c\uddf9\ud83c\uddfc") ||
      normalizedName.includes("\u53f0\u6e7e") ||
      normalizedName.includes("\u53f0\u7063") ||
      normalizedName.includes("taiwan") ||
      normalizedName.includes("\u53f0\u5317") ||
      normalizedName.includes("\u81fa\u5317") ||
      normalizedName.includes("\u9ad8\u96c4") ||
      normalizedName.includes("\u65b0\u7af9") ||
      normalizedName.includes("taipei") ||
      normalizedName.includes("kaohsiung") ||
      normalizedName.includes("hsinchu") ||
      tokenSet.has("tw") ||
      tokenSet.has("twn"),
  },
  {
    key: "japan",
    name: "\ud83c\uddef\ud83c\uddf5 \u65e5\u672c\u8282\u70b9",
    match: ({ rawName, normalizedName, tokenSet }) =>
      rawName.includes("\ud83c\uddef\ud83c\uddf5") ||
      normalizedName.includes("\u65e5\u672c") ||
      normalizedName.includes("japan") ||
      normalizedName.includes("\u4e1c\u4eac") ||
      normalizedName.includes("\u6771\u4eac") ||
      normalizedName.includes("\u5927\u962a") ||
      normalizedName.includes("tokyo") ||
      normalizedName.includes("osaka") ||
      tokenSet.has("jp"),
  },
  {
    key: "united-states",
    name: "\ud83c\uddfa\ud83c\uddf8 \u7f8e\u56fd\u8282\u70b9",
    match: ({ rawName, normalizedName, tokenSet }) =>
      rawName.includes("\ud83c\uddfa\ud83c\uddf8") ||
      normalizedName.includes("\u7f8e\u56fd") ||
      normalizedName.includes("\u7f8e\u570b") ||
      normalizedName.includes("united states") ||
      normalizedName.includes("unitedstates") ||
      normalizedName.includes("america") ||
      normalizedName.includes("los angeles") ||
      normalizedName.includes("new york") ||
      normalizedName.includes("seattle") ||
      normalizedName.includes("silicon valley") ||
      normalizedName.includes("\u5723\u4f55\u585e") ||
      normalizedName.includes("\u8056\u4f55\u585e") ||
      normalizedName.includes("\u6d1b\u6749\u77f6") ||
      normalizedName.includes("\u6d1b\u6749\u78ef") ||
      normalizedName.includes("\u7ebd\u7ea6") ||
      normalizedName.includes("\u7d10\u7d04") ||
      normalizedName.includes("\u897f\u96c5\u56fe") ||
      normalizedName.includes("\u897f\u96c5\u5716") ||
      normalizedName.includes("\u7845\u8c37") ||
      tokenSet.has("us") ||
      tokenSet.has("usa"),
  },
  {
    key: "singapore",
    name: "\ud83c\uddf8\ud83c\uddec \u72ee\u57ce\u8282\u70b9",
    match: ({ rawName, normalizedName, tokenSet }) =>
      rawName.includes("\ud83c\uddf8\ud83c\uddec") ||
      normalizedName.includes("\u65b0\u52a0\u5761") ||
      normalizedName.includes("\u72ee\u57ce") ||
      normalizedName.includes("\u7345\u57ce") ||
      normalizedName.includes("singapore") ||
      tokenSet.has("sg") ||
      tokenSet.has("sgp"),
  },
  {
    key: "south-korea",
    name: "\ud83c\uddf0\ud83c\uddf7 \u97e9\u56fd\u8282\u70b9",
    match: ({ rawName, normalizedName, tokenSet }) =>
      rawName.includes("\ud83c\uddf0\ud83c\uddf7") ||
      normalizedName.includes("\u97e9\u56fd") ||
      normalizedName.includes("\u97d3\u570b") ||
      normalizedName.includes("\u9996\u5c14") ||
      normalizedName.includes("\u9996\u723e") ||
      normalizedName.includes("\u91dc\u5c71") ||
      normalizedName.includes("korea") ||
      normalizedName.includes("south korea") ||
      normalizedName.includes("southkorea") ||
      normalizedName.includes("seoul") ||
      normalizedName.includes("busan") ||
      tokenSet.has("kr") ||
      tokenSet.has("kor"),
  },
  {
    key: "united-kingdom",
    name: "\ud83c\uddec\ud83c\udde7 \u82f1\u56fd\u8282\u70b9",
    match: ({ rawName, normalizedName, tokenSet }) =>
      rawName.includes("\ud83c\uddec\ud83c\udde7") ||
      normalizedName.includes("\u82f1\u56fd") ||
      normalizedName.includes("\u82f1\u570b") ||
      normalizedName.includes("\u4f26\u6566") ||
      normalizedName.includes("\u502b\u6566") ||
      normalizedName.includes("\u66fc\u5f7b\u65af\u7279") ||
      normalizedName.includes("united kingdom") ||
      normalizedName.includes("unitedkingdom") ||
      normalizedName.includes("britain") ||
      normalizedName.includes("england") ||
      normalizedName.includes("london") ||
      normalizedName.includes("manchester") ||
      tokenSet.has("uk") ||
      tokenSet.has("gb") ||
      tokenSet.has("gbr"),
  },
  {
    key: "russia",
    name: "\ud83c\uddf7\ud83c\uddfa \u4fc4\u7f57\u65af\u8282\u70b9",
    match: ({ rawName, normalizedName, tokenSet }) =>
      rawName.includes("\ud83c\uddf7\ud83c\uddfa") ||
      normalizedName.includes("\u4fc4\u7f57\u65af") ||
      normalizedName.includes("\u4fc4\u7f85\u65af") ||
      normalizedName.includes("russia") ||
      normalizedName.includes("\u83ab\u65af\u79d1") ||
      normalizedName.includes("moscow") ||
      tokenSet.has("ru") ||
      tokenSet.has("rus"),
  },
  {
    key: "india",
    name: "\ud83c\uddee\ud83c\uddf3 \u5370\u5ea6\u8282\u70b9",
    match: ({ rawName, normalizedName, tokenSet }) =>
      rawName.includes("\ud83c\uddee\ud83c\uddf3") ||
      normalizedName.includes("\u5370\u5ea6") ||
      normalizedName.includes("india") ||
      normalizedName.includes("\u5b5f\u4e70") ||
      normalizedName.includes("mumbai") ||
      normalizedName.includes("\u65b0\u5fb7\u91cc") ||
      normalizedName.includes("\u5fb7\u91cc") ||
      normalizedName.includes("delhi") ||
      normalizedName.includes("\u73ed\u52a0\u7f57\u5c14") ||
      normalizedName.includes("\u73ed\u52a0\u7f85\u723e") ||
      normalizedName.includes("bangalore") ||
      normalizedName.includes("bengaluru") ||
      tokenSet.has("in") ||
      tokenSet.has("ind"),
  },
];

function normalizeCountryMatchName(value) {
  return (value || "")
    .toString()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_|/\\()[\]{}<>【】《》「」『』"'`~!@#$%^&*+=:;,.?，。！？、]+/gu, " ")
    .trim();
}

function detectAggregateCountryGroup(name) {
  const rawName = (name || "").toString().normalize("NFKC");
  const normalizedName = normalizeCountryMatchName(rawName);
  const tokenSet = new Set(normalizedName.split(" ").filter(Boolean));
  const matchedGroup = CLASH_COUNTRY_GROUP_DEFINITIONS.find((definition) =>
    definition.match({ rawName, normalizedName, tokenSet }),
  );

  return matchedGroup ? matchedGroup.key : "";
}

function setAggregateCountryGroup(proxy, countryGroupKey) {
  if (!proxy || typeof proxy !== "object" || !countryGroupKey) {
    return;
  }

  Object.defineProperty(proxy, "__aggregateCountryGroup", {
    configurable: true,
    enumerable: false,
    value: countryGroupKey,
    writable: true,
  });
}

function buildAggregateCountryGroups(proxies) {
  return CLASH_COUNTRY_GROUP_DEFINITIONS.map((definition) => {
    const matchingProxyNames = proxies
      .filter((proxy) => proxy?.__aggregateCountryGroup === definition.key)
      .map((proxy) => proxy?.name)
      .filter(Boolean);

    if (matchingProxyNames.length === 0) {
      return null;
    }

    return {
      name: definition.name,
      type: "url-test",
      url: AGGREGATE_HEALTHCHECK_URL,
      interval: AGGREGATE_HEALTHCHECK_INTERVAL_SECONDS,
      lazy: false,
      timeout: AGGREGATE_HEALTHCHECK_TIMEOUT_MS,
      tolerance: 50,
      proxies: collectUniqueValues(matchingProxyNames),
    };
  }).filter(Boolean);
}

function buildAggregateRegionalLoadBalanceGroups(proxies) {
  const hongKongProxyNames = proxies
    .filter((proxy) => proxy?.__aggregateCountryGroup === "hong-kong")
    .map((proxy) => proxy?.name)
    .filter(Boolean);

  if (hongKongProxyNames.length < 2) {
    return [];
  }

  return [
    {
      name: HONG_KONG_LOAD_BALANCE_GROUP_NAME,
      type: "load-balance",
      url: AGGREGATE_HEALTHCHECK_URL,
      interval: AGGREGATE_HEALTHCHECK_INTERVAL_SECONDS,
      lazy: false,
      timeout: AGGREGATE_HEALTHCHECK_TIMEOUT_MS,
      strategy: "consistent-hashing",
      proxies: collectUniqueValues(hongKongProxyNames),
    },
  ];
}

function prioritizeValues(values, priorityValues, additions = []) {
  const nextValues = collectUniqueValues(Array.isArray(values) ? values : []).filter(Boolean);
  const uniquePriorityValues = collectUniqueValues(priorityValues).filter((value) => nextValues.includes(value));
  const uniqueAdditions = collectUniqueValues(additions).filter(Boolean);

  if (uniquePriorityValues.length === 0 && uniqueAdditions.length === 0) {
    return nextValues;
  }

  const remaining = nextValues.filter(
    (value) => !uniquePriorityValues.includes(value) && !uniqueAdditions.includes(value),
  );
  return collectUniqueValues([...uniquePriorityValues, ...uniqueAdditions, ...remaining]);
}

function tuneAggregateHealthCheckGroup(group) {
  if (!group || typeof group !== "object") {
    return group;
  }

  if (group.type !== "url-test" && group.type !== "fallback" && group.type !== "load-balance") {
    return group;
  }

  return {
    ...cloneSerializable(group),
    interval: AGGREGATE_HEALTHCHECK_INTERVAL_SECONDS,
    lazy: false,
    timeout: AGGREGATE_HEALTHCHECK_TIMEOUT_MS,
  };
}

function prioritizeAggregateGeneratedGroups(groups, generatedGroups) {
  if (!Array.isArray(groups) || generatedGroups.length === 0) {
    return Array.isArray(groups) ? groups : [];
  }

  const existingGroupNames = new Set(
    groups
      .map((group) => (group && typeof group === "object" ? group.name : ""))
      .filter(Boolean),
  );
  const uniqueGeneratedGroups = generatedGroups.filter((group) => !existingGroupNames.has(group.name));

  if (uniqueGeneratedGroups.length === 0) {
    return groups;
  }

  const generatedGroupNameSet = new Set(uniqueGeneratedGroups.map((group) => group.name).filter(Boolean));
  const groupByName = new Map();

  groups.forEach((group) => {
    if (!group || typeof group !== "object" || !group.name || groupByName.has(group.name)) {
      return;
    }

    groupByName.set(group.name, group);
  });

  uniqueGeneratedGroups.forEach((group) => {
    if (group?.name && !groupByName.has(group.name)) {
      groupByName.set(group.name, group);
    }
  });

  const topGroupNames = [...TOP_PRIORITY_GROUP_NAMES, ...uniqueGeneratedGroups.map((group) => group.name)];
  const prioritizedNames = topGroupNames.filter((name) => groupByName.has(name));
  const prioritizedNameSet = new Set(prioritizedNames);
  const prioritizedGroups = prioritizedNames.map((name) => groupByName.get(name)).filter(Boolean);
  const remainingGroups = groups.filter((group) => {
    const groupName = group && typeof group === "object" ? group.name : "";
    return !groupName || (!prioritizedNameSet.has(groupName) && !generatedGroupNameSet.has(groupName));
  });

  return [...prioritizedGroups, ...remainingGroups];
}

function shouldInjectCountryGroupsIntoSelector(group) {
  return Boolean(
    group
    && typeof group === "object"
    && group.type === "select"
    && Array.isArray(group.proxies)
    && (group.name === MAIN_SELECTOR_GROUP_NAME || group.proxies.includes(MAIN_SELECTOR_GROUP_NAME)),
  );
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
  const countryGroups = buildAggregateCountryGroups(proxies);
  const regionalLoadBalanceGroups = buildAggregateRegionalLoadBalanceGroups(proxies);
  const generatedSelectorGroups = [...regionalLoadBalanceGroups, ...countryGroups];
  const generatedSelectorGroupNames = generatedSelectorGroups.map((group) => group.name).filter(Boolean);

  nextTemplate.proxies = proxies;

  if (Array.isArray(nextTemplate["proxy-groups"])) {
    let nextProxyGroups = nextTemplate["proxy-groups"].map((group) => {
      if (!group || typeof group !== "object" || !Array.isArray(group.proxies)) {
        return tuneAggregateHealthCheckGroup(group);
      }

      const shouldInjectCountryGroups =
        generatedSelectorGroupNames.length > 0 && shouldInjectCountryGroupsIntoSelector(group);
      const selectorPriorityNames =
        group.name === MAIN_SELECTOR_GROUP_NAME
          ? [AUTO_SELECT_GROUP_NAME, DIRECT_GROUP_NAME, FALLBACK_GROUP_NAME]
          : [MAIN_SELECTOR_GROUP_NAME, AUTO_SELECT_GROUP_NAME, DIRECT_GROUP_NAME, FALLBACK_GROUP_NAME];

      if (!group.proxies.some((value) => templateProxyNameSet.has(value))) {
        if (shouldInjectCountryGroups) {
          return tuneAggregateHealthCheckGroup({
            ...cloneSerializable(group),
            proxies: prioritizeValues(
              group.proxies,
              selectorPriorityNames,
              generatedSelectorGroupNames,
            ),
          });
        }

        return tuneAggregateHealthCheckGroup(group);
      }

      return {
        ...tuneAggregateHealthCheckGroup(group),
        proxies: shouldInjectCountryGroups
          ? prioritizeValues(
              replaceTemplateProxyNames(group.proxies, templateProxyNameSet, mergedProxyNames),
              selectorPriorityNames,
              generatedSelectorGroupNames,
            )
          : replaceTemplateProxyNames(group.proxies, templateProxyNameSet, mergedProxyNames),
      };
    });

    nextProxyGroups = prioritizeAggregateGeneratedGroups(nextProxyGroups, generatedSelectorGroups);
    nextTemplate["proxy-groups"] = nextProxyGroups;
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
      setAggregateCountryGroup(nextProxy, detectAggregateCountryGroup(nextProxy.name));
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
