"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const yaml = require("js-yaml");

const templateFile = path.join(__dirname, "templates", "aggregate-clash-template.yaml");
let templateCachePromise = null;

async function readAggregateClashTemplate() {
  const content = await fs.readFile(templateFile, "utf8");
  const parsed = yaml.load(content);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Aggregate Clash template is invalid.");
  }

  return parsed;
}

async function loadAggregateClashTemplate() {
  if (!templateCachePromise) {
    templateCachePromise = readAggregateClashTemplate();
  }

  const parsedTemplate = await templateCachePromise;
  return JSON.parse(JSON.stringify(parsedTemplate));
}

module.exports = {
  loadAggregateClashTemplate,
  templateFile,
};
