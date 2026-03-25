"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { PNG } = require("pngjs");
const { createWorker } = require("tesseract.js");

const BACKGROUND_DISTANCE_THRESHOLD = 36;
const MIN_COMPONENT_WIDTH = 4;
const MIN_COMPONENT_HEIGHT = 10;
const COMPONENT_PADDING = 2;
const MAX_CANDIDATE_COMBINATIONS = 36;
const TESSERACT_INIT_TIMEOUT_MS = Number.parseInt(
  process.env.TESSERACT_INIT_TIMEOUT_MS || "2500",
  10,
);
const TESSERACT_RECOGNIZE_TIMEOUT_MS = Number.parseInt(
  process.env.TESSERACT_RECOGNIZE_TIMEOUT_MS || "1200",
  10,
);

let workerPromise = null;

function createTimeoutError(label, timeoutMs) {
  return new Error(`${label} timed out after ${timeoutMs}ms.`);
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutHandle = null;
  return Promise.race([
    promise.finally(() => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }),
    new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(createTimeoutError(label, timeoutMs));
      }, timeoutMs);
    }),
  ]);
}

function uniqueStrings(values) {
  return Array.from(
    new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value)),
  );
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await withTimeout(
        createWorker("eng"),
        TESSERACT_INIT_TIMEOUT_MS,
        "Tesseract worker initialization",
      );
      await withTimeout(worker.setParameters({
        tessedit_pageseg_mode: "10",
        tessedit_char_whitelist: "0123456789",
        classify_bln_numeric_mode: "1",
      }), TESSERACT_INIT_TIMEOUT_MS, "Tesseract worker parameter setup");
      return worker;
    })().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }

  return workerPromise;
}

async function shutdownNumericCaptchaSolver() {
  if (!workerPromise) {
    return;
  }

  const worker = await workerPromise;
  workerPromise = null;
  await worker.terminate();
}

function decodePngFromDataUrl(dataUrl) {
  const normalized =
    typeof dataUrl === "string"
      ? dataUrl
        .replace(/\u0000/g, "")
        .replace(/^\uFEFF/, "")
        .replace(/^\uFFFD+/, "")
        .trim()
      : "";
  const commaIndex = normalized.indexOf(",");
  if (!/^data:image\//i.test(normalized) || commaIndex <= 0) {
    throw new Error("Unsupported captcha image format.");
  }

  return PNG.sync.read(Buffer.from(normalized.slice(commaIndex + 1), "base64"));
}

function isDarkPixel(image, x, y) {
  const index = (image.width * y + x) << 2;
  const red = image.data[index];
  const green = image.data[index + 1];
  const blue = image.data[index + 2];
  const background = image.__relayhubBackground
    || (image.__relayhubBackground = [image.data[0], image.data[1], image.data[2]]);
  const distance = Math.sqrt(
    ((red - background[0]) ** 2)
      + ((green - background[1]) ** 2)
      + ((blue - background[2]) ** 2),
  );

  return distance >= BACKGROUND_DISTANCE_THRESHOLD;
}

function findCharacterBoxes(image) {
  const occupiedColumns = [];

  for (let x = 0; x < image.width; x += 1) {
    let hasInk = false;
    for (let y = 0; y < image.height; y += 1) {
      if (isDarkPixel(image, x, y)) {
        hasInk = true;
        break;
      }
    }
    occupiedColumns[x] = hasInk;
  }

  const boxes = [];
  let runStart = -1;
  for (let x = 0; x <= image.width; x += 1) {
    const hasInk = x < image.width ? occupiedColumns[x] : false;
    if (hasInk && runStart < 0) {
      runStart = x;
      continue;
    }

    if (hasInk || runStart < 0) {
      continue;
    }

    let top = image.height;
    let bottom = -1;
    for (let column = runStart; column < x; column += 1) {
      for (let y = 0; y < image.height; y += 1) {
        if (!isDarkPixel(image, column, y)) {
          continue;
        }
        if (y < top) {
          top = y;
        }
        if (y > bottom) {
          bottom = y;
        }
      }
    }

    const width = x - runStart;
    const height = bottom - top + 1;
    if (width >= MIN_COMPONENT_WIDTH && height >= MIN_COMPONENT_HEIGHT) {
      boxes.push({
        x: runStart,
        y: top,
        width,
        height,
      });
    }

    runStart = -1;
  }

  return boxes;
}

function buildComponentBinaryMatrix(image, box) {
  const outputWidth = box.width + COMPONENT_PADDING * 2;
  const outputHeight = box.height + COMPONENT_PADDING * 2;
  const matrix = Array.from({ length: outputHeight }, () => Array(outputWidth).fill(0));

  for (let y = 0; y < outputHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      const sourceX = box.x + x - COMPONENT_PADDING;
      const sourceY = box.y + y - COMPONENT_PADDING;
      if (
        sourceX < 0
        || sourceY < 0
        || sourceX >= image.width
        || sourceY >= image.height
      ) {
        continue;
      }
      matrix[y][x] = isDarkPixel(image, sourceX, sourceY) ? 1 : 0;
    }
  }

  return matrix;
}

function createPngFromMatrix(matrix) {
  const height = matrix.length;
  const width = matrix[0]?.length || 0;
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = matrix[y][x] ? 0 : 255;
      const index = (y * width + x) << 2;
      png.data[index] = value;
      png.data[index + 1] = value;
      png.data[index + 2] = value;
      png.data[index + 3] = 255;
    }
  }

  return PNG.sync.write(png);
}

function measureHoles(matrix) {
  const height = matrix.length;
  const width = matrix[0]?.length || 0;
  const visited = Array.from({ length: height }, () => Array(width).fill(false));
  const holes = [];
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (matrix[y][x] || visited[y][x]) {
        continue;
      }

      const queue = [[x, y]];
      visited[y][x] = true;
      let touchesBoundary = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      let sumX = 0;
      let sumY = 0;
      let pixels = 0;
      let head = 0;

      while (head < queue.length) {
        const [currentX, currentY] = queue[head];
        head += 1;
        sumX += currentX;
        sumY += currentY;
        pixels += 1;

        directions.forEach(([dx, dy]) => {
          const nextX = currentX + dx;
          const nextY = currentY + dy;
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
            return;
          }
          if (nextX === 0 || nextY === 0 || nextX === width - 1 || nextY === height - 1) {
            touchesBoundary = true;
          }
          if (matrix[nextY][nextX] || visited[nextY][nextX]) {
            return;
          }
          visited[nextY][nextX] = true;
          queue.push([nextX, nextY]);
        });
      }

      if (!touchesBoundary) {
        holes.push({
          pixels,
          centerX: sumX / pixels,
          centerY: sumY / pixels,
        });
      }
    }
  }

  return holes;
}

function getRowInkRatio(matrix, y) {
  if (!matrix[y]) {
    return 0;
  }
  return matrix[y].reduce((total, value) => total + value, 0) / matrix[y].length;
}

function getColumnInkRatio(matrix, x) {
  let total = 0;
  for (let y = 0; y < matrix.length; y += 1) {
    total += matrix[y][x] || 0;
  }
  return matrix.length > 0 ? total / matrix.length : 0;
}

function buildDigitCandidates(component, ocrDigit, ocrConfidence = 0) {
  const candidates = [];
  const push = (value) => {
    if (typeof value === "string" && /^\d$/.test(value) && !candidates.includes(value)) {
      candidates.push(value);
    }
  };

  const aspectRatio = component.width / component.height;
  const holes = component.holes;
  const preferOcrFirst = /^\d$/.test(ocrDigit || "")
    && holes.length !== 1
    && (holes.length > 0 || ocrConfidence >= 35);
  const centerRowRatio = getRowInkRatio(component.matrix, Math.floor(component.height / 2));
  const topRowRatio = getRowInkRatio(component.matrix, Math.max(1, Math.floor(component.height * 0.15)));
  const bottomRowRatio = getRowInkRatio(component.matrix, Math.max(0, component.height - 2));
  const leftColumnRatio = getColumnInkRatio(component.matrix, Math.max(1, Math.floor(component.width * 0.15)));
  const rightColumnRatio = getColumnInkRatio(component.matrix, Math.max(0, component.width - 2));

  if (preferOcrFirst) {
    push(ocrDigit);
  }

  if (holes.length >= 2) {
    push("8");
  } else if (holes.length === 1) {
    const holeCenterYRatio = holes[0].centerY / component.height;
    if (holeCenterYRatio < 0.35) {
      push("9");
      push("0");
      push("6");
    } else if (holeCenterYRatio > 0.65) {
      push("6");
      push("0");
      push("9");
    } else {
      push("0");
      push("9");
      push("6");
    }
  } else {
    if (aspectRatio <= 0.4) {
      push("1");
      push("7");
    }

    if (
      rightColumnRatio >= 0.45
      && centerRowRatio >= 0.35
      && leftColumnRatio <= 0.35
      && topRowRatio <= 0.45
    ) {
      push("4");
    }

    if (topRowRatio >= 0.45 && bottomRowRatio <= 0.12 && leftColumnRatio <= 0.28) {
      push("7");
    }
  }

  if (!preferOcrFirst) {
    push(ocrDigit);
  }

  if (holes.length === 0) {
    if (topRowRatio >= 0.35 && centerRowRatio >= 0.18 && bottomRowRatio >= 0.16) {
      push("2");
    }
    ["2", "3", "4", "5", "7", "1"].forEach(push);
  }

  return candidates.length > 0 ? candidates : ["0"];
}

function cartesianProduct(lists, limit = MAX_CANDIDATE_COMBINATIONS) {
  const results = [];

  function walk(index, current) {
    if (results.length >= limit) {
      return;
    }

    if (index >= lists.length) {
      results.push(current.join(""));
      return;
    }

    lists[index].forEach((value) => {
      if (results.length >= limit) {
        return;
      }
      current.push(value);
      walk(index + 1, current);
      current.pop();
    });
  }

  walk(0, []);
  return uniqueStrings(results.filter((value) => /^\d{4}$/.test(value)));
}

async function recognizeDigit(worker, component) {
  const tempPath = path.join(
    os.tmpdir(),
    `relayhub-captcha-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.png`,
  );
  await fs.writeFile(tempPath, createPngFromMatrix(component.matrix));
  const result = await withTimeout(
    worker.recognize(tempPath),
    TESSERACT_RECOGNIZE_TIMEOUT_MS,
    "Tesseract digit recognition",
  );
  await fs.unlink(tempPath).catch(() => undefined);
  const normalized = (result?.data?.text || "").replace(/\D/g, "");
  return {
    digit: normalized[0] || "",
    confidence: Number(result?.data?.confidence || 0) || 0,
  };
}

async function buildNumericCaptchaCandidatesFromDataUrl(dataUrl) {
  const image = decodePngFromDataUrl(dataUrl);
  const boxes = findCharacterBoxes(image);
  if (boxes.length !== 4) {
    return {
      primary: "",
      candidates: [],
      components: [],
    };
  }

  let worker = null;
  if (process.env.RELAYHUB_ENABLE_TESSERACT === "1") {
    worker = await getWorker().catch(() => null);
  }
  const components = [];
  for (const box of boxes) {
    const matrix = buildComponentBinaryMatrix(image, box);
    const component = {
      width: matrix[0]?.length || 0,
      height: matrix.length,
      matrix,
      holes: measureHoles(matrix),
    };
    const recognition = worker
      ? await recognizeDigit(worker, component).catch(() => ({ digit: "", confidence: 0 }))
      : { digit: "", confidence: 0 };
    component.ocrDigit = recognition.digit;
    component.ocrConfidence = recognition.confidence;
    component.candidates = buildDigitCandidates(
      component,
      recognition.digit,
      recognition.confidence,
    );
    components.push(component);
  }

  const primary = components.map((component) => component.candidates[0] || "").join("");
  const candidates = cartesianProduct(
    components.map((component) => component.candidates),
  );

  return {
    primary: /^\d{4}$/.test(primary) ? primary : (candidates[0] || ""),
    candidates,
    components: components.map((component) => ({
      width: component.width,
      height: component.height,
      holes: component.holes.length,
      ocrDigit: component.ocrDigit,
      ocrConfidence: component.ocrConfidence,
      candidates: component.candidates,
    })),
  };
}

module.exports = {
  buildNumericCaptchaCandidatesFromDataUrl,
  shutdownNumericCaptchaSolver,
};
