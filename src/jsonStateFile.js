"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

function findFirstJsonDocumentEnd(content) {
  const source = typeof content === "string" ? content : "";
  let index = 0;
  while (index < source.length && /\s/.test(source[index])) {
    index += 1;
  }

  if (index >= source.length || !["{", "["].includes(source[index])) {
    return -1;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let cursor = index; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{" || character === "[") {
      depth += 1;
      continue;
    }

    if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
  }

  return -1;
}

function parseJsonWithRecovery(content) {
  const source = typeof content === "string" ? content : "";
  try {
    return {
      value: JSON.parse(source),
      recovered: false,
      trailingContent: "",
    };
  } catch (error) {
    const end = findFirstJsonDocumentEnd(source);
    if (end <= 0) {
      throw error;
    }

    const candidate = source.slice(0, end);
    const trailingContent = source.slice(end).trim();
    if (!trailingContent) {
      throw error;
    }

    return {
      value: JSON.parse(candidate),
      recovered: true,
      trailingContent,
    };
  }
}

async function backupCorruptedJsonFile(filePath, content) {
  const backupPath = `${filePath}.corrupt-${Date.now()}.bak`;
  await fs.writeFile(backupPath, content, "utf8");
  return backupPath;
}

async function writeJsonFileAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  const temporaryFilePath =
    `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const content = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporaryFilePath, content, "utf8");
  await fs.rename(temporaryFilePath, filePath);
}

module.exports = {
  backupCorruptedJsonFile,
  parseJsonWithRecovery,
  writeJsonFileAtomic,
};
