/* global UTIF */
importScripts("https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.min.js");

const COMPONENT = {dapi: 2, nk: 1, tumor: 0};

function postProgress(phase, progress) {
  postMessage({type: "progress", phase, progress});
}

async function decode(buffer, extension, channel) {
  extension = extension.toLowerCase();
  if (extension === ".tif" || extension === ".tiff") {
    const ifds = UTIF.decode(buffer);
    if (!ifds.length) throw new Error("TIFF 中没有可读取的图像");
    const ifd = ifds[0];
    if ((ifd["t273"] || []).length > 1 && ifds.length > 1) {
      throw new Error("暂不支持多页 TIFF 或 Z-stack");
    }
    UTIF.decodeImage(buffer, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    const output = new Uint8Array(ifd.width * ifd.height);
    const component = COMPONENT[channel];
    for (let i = 0, j = component; i < output.length; i++, j += 4) output[i] = rgba[j];
    return {data: output, width: ifd.width, height: ifd.height};
  }
  const blob = new Blob([buffer], {type: extension === ".png" ? "image/png" : "image/jpeg"});
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", {willReadFrequently: true});
  context.drawImage(bitmap, 0, 0);
  const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  bitmap.close();
  const output = new Uint8Array(bitmap.width * bitmap.height);
  const component = COMPONENT[channel];
  for (let i = 0, j = component; i < output.length; i++, j += 4) output[i] = rgba[j];
  return {data: output, width: canvas.width, height: canvas.height};
}

function boxBlur(input, width, height, radius) {
  radius = Math.max(0, Math.round(radius));
  if (!radius) return input;
  const horizontal = new Uint8Array(input.length);
  const output = new Uint8Array(input.length);
  const span = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += input[row + Math.max(0, Math.min(width - 1, k))];
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = Math.round(sum / span);
      const removeX = Math.max(0, x - radius);
      const addX = Math.min(width - 1, x + radius + 1);
      sum += input[row + addX] - input[row + removeX];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += horizontal[Math.max(0, Math.min(height - 1, k)) * width + x];
    for (let y = 0; y < height; y++) {
      output[y * width + x] = Math.round(sum / span);
      const removeY = Math.max(0, y - radius);
      const addY = Math.min(height - 1, y + radius + 1);
      sum += horizontal[addY * width + x] - horizontal[removeY * width + x];
    }
  }
  return output;
}

function otsuThreshold(data) {
  const histogram = new Uint32Array(256);
  let total = 0, sum = 0;
  for (const value of data) {
    if (value > 0) { histogram[value]++; total++; sum += value; }
  }
  if (!total) return 255;
  let backgroundWeight = 0, backgroundSum = 0, bestVariance = -1, best = 0;
  for (let value = 0; value < 256; value++) {
    backgroundWeight += histogram[value];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += value * histogram[value];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) { bestVariance = variance; best = value; }
  }
  return best;
}

function thresholdMask(data, params) {
  const mask = new Uint8Array(data.length);
  if (params.threshold_mode === "auto") {
    const threshold = otsuThreshold(data);
    for (let i = 0; i < data.length; i++) mask[i] = data[i] >= threshold ? 1 : 0;
  } else {
    const low = Math.max(0, Number(params.threshold_low));
    const high = Math.min(255, Number(params.threshold_high));
    for (let i = 0; i < data.length; i++) mask[i] = data[i] >= low && data[i] <= high ? 1 : 0;
  }
  return mask;
}

function opening(mask, width, height, iterations) {
  iterations = Math.max(0, Math.min(2, Math.round(iterations)));
  let current = mask;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const eroded = new Uint8Array(mask.length);
    for (let y = 1; y < height - 1; y++) {
      let index = y * width + 1;
      for (let x = 1; x < width - 1; x++, index++) {
        eroded[index] = current[index] && current[index - 1] && current[index + 1] &&
          current[index - width] && current[index + width] ? 1 : 0;
      }
    }
    const dilated = new Uint8Array(mask.length);
    for (let y = 1; y < height - 1; y++) {
      let index = y * width + 1;
      for (let x = 1; x < width - 1; x++, index++) {
        dilated[index] = eroded[index] || eroded[index - 1] || eroded[index + 1] ||
          eroded[index - width] || eroded[index + width] ? 1 : 0;
      }
    }
    current = dilated;
  }
  return current;
}

function distanceTransform(mask, width, height) {
  const max = 65530;
  const distance = new Uint16Array(mask.length);
  for (let i = 0; i < mask.length; i++) distance[i] = mask[i] ? max : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      let best = distance[i];
      if (x) best = Math.min(best, distance[i - 1] + 3);
      if (y) best = Math.min(best, distance[i - width] + 3);
      if (x && y) best = Math.min(best, distance[i - width - 1] + 4);
      if (x < width - 1 && y) best = Math.min(best, distance[i - width + 1] + 4);
      distance[i] = best;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (!mask[i]) continue;
      let best = distance[i];
      if (x < width - 1) best = Math.min(best, distance[i + 1] + 3);
      if (y < height - 1) best = Math.min(best, distance[i + width] + 3);
      if (x < width - 1 && y < height - 1) best = Math.min(best, distance[i + width + 1] + 4);
      if (x && y < height - 1) best = Math.min(best, distance[i + width - 1] + 4);
      distance[i] = best;
    }
  }
  return distance;
}

function selectSeeds(mask, distance, width, height, minDistance) {
  const candidates = [];
  for (let y = 1; y < height - 1; y++) {
    let i = y * width + 1;
    for (let x = 1; x < width - 1; x++, i++) {
      const d = distance[i];
      if (!mask[i] || d < 3) continue;
      if (d >= distance[i - 1] && d >= distance[i + 1] &&
          d >= distance[i - width] && d >= distance[i + width] &&
          d >= distance[i - width - 1] && d >= distance[i - width + 1] &&
          d >= distance[i + width - 1] && d >= distance[i + width + 1]) {
        candidates.push({index: i, x, y, distance: d});
      }
    }
  }
  candidates.sort((a, b) => b.distance - a.distance);
  const cell = Math.max(1, minDistance);
  const grid = new Map();
  const selected = [];
  for (const candidate of candidates) {
    const gx = Math.floor(candidate.x / cell), gy = Math.floor(candidate.y / cell);
    let blocked = false;
    for (let oy = -1; oy <= 1 && !blocked; oy++) {
      for (let ox = -1; ox <= 1 && !blocked; ox++) {
        for (const seed of grid.get(`${gx + ox},${gy + oy}`) || []) {
          if ((seed.x - candidate.x) ** 2 + (seed.y - candidate.y) ** 2 < minDistance ** 2) blocked = true;
        }
      }
    }
    if (!blocked) {
      selected.push(candidate);
      const key = `${gx},${gy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(candidate);
    }
  }
  return selected;
}

function floodLabels(mask, width, height, seeds) {
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  let head = 0, tail = 0;
  seeds.forEach((seed, index) => {
    labels[seed.index] = index + 1;
    queue[tail++] = seed.index;
  });
  while (head < tail) {
    const index = queue[head++];
    const label = labels[index];
    const x = index % width;
    const neighbours = [index - width, index + width];
    if (x) neighbours.push(index - 1);
    if (x < width - 1) neighbours.push(index + 1);
    for (const next of neighbours) {
      if (next >= 0 && next < mask.length && mask[next] && !labels[next]) {
        labels[next] = label;
        queue[tail++] = next;
      }
    }
  }
  return labels;
}

function regionDetections(labels, width, height, params) {
  let maxLabel = 0;
  for (const label of labels) if (label > maxLabel) maxLabel = label;
  const area = new Uint32Array(maxLabel + 1);
  const sumX = new Float64Array(maxLabel + 1);
  const sumY = new Float64Array(maxLabel + 1);
  const perimeter = new Uint32Array(maxLabel + 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x, label = labels[i];
      if (!label) continue;
      area[label]++; sumX[label] += x; sumY[label] += y;
      if (!x || labels[i - 1] !== label) perimeter[label]++;
      if (x === width - 1 || labels[i + 1] !== label) perimeter[label]++;
      if (!y || labels[i - width] !== label) perimeter[label]++;
      if (y === height - 1 || labels[i + width] !== label) perimeter[label]++;
    }
  }
  const detections = [];
  for (let label = 1; label <= maxLabel; label++) {
    if (!area[label]) continue;
    const circularity = Math.min(1, 4 * Math.PI * area[label] / Math.max(1, perimeter[label] ** 2));
    if (area[label] < params.min_area_px || area[label] > params.max_area_px ||
        circularity < params.min_circularity || circularity > params.max_circularity) continue;
    detections.push({
      id: `auto-${detections.length + 1}`,
      _label: label,
      x: sumX[label] / area[label],
      y: sumY[label] / area[label],
      area_px: area[label],
      radius: Math.sqrt(area[label] / Math.PI),
      circularity,
      manual: false,
      deleted: false,
    });
  }
  return detections;
}

function attachMaskRuns(labels, width, height, detections) {
  const byLabel = new Map();
  for (const detection of detections) {
    detection.runs = [];
    byLabel.set(detection._label, detection);
  }
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const label = labels[y * width + x];
      const start = x;
      x++;
      while (x < width && labels[y * width + x] === label) x++;
      const detection = byLabel.get(label);
      if (detection) detection.runs.push(y, start, x - 1);
    }
  }
  for (const detection of detections) delete detection._label;
}

function positivity(signal, width, height, detection, radiusPx, threshold) {
  const innerRadius = detection.radius + radiusPx;
  const bgStart = innerRadius + Math.max(2, radiusPx);
  const bgEnd = bgStart + Math.max(4, radiusPx);
  const x0 = Math.max(0, Math.floor(detection.x - bgEnd));
  const x1 = Math.min(width - 1, Math.ceil(detection.x + bgEnd));
  const y0 = Math.max(0, Math.floor(detection.y - bgEnd));
  const y1 = Math.min(height - 1, Math.ceil(detection.y + bgEnd));
  const inner = [], background = [];
  const inner2 = innerRadius ** 2, bgStart2 = bgStart ** 2, bgEnd2 = bgEnd ** 2;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d2 = (x - detection.x) ** 2 + (y - detection.y) ** 2;
      const value = signal[y * width + x];
      if (d2 <= inner2) inner.push(value);
      else if (d2 >= bgStart2 && d2 <= bgEnd2) background.push(value);
    }
  }
  background.sort((a, b) => a - b);
  const baseline = background.length ? background[Math.floor(background.length / 2)] : 0;
  let positive = 0;
  for (const value of inner) if (value - baseline >= threshold) positive++;
  return {fraction: inner.length ? positive / inner.length : 0, background: baseline};
}

async function analyze(payload) {
  postProgress(`读取 ${payload.targetLabel} 通道`, 0.04);
  const channel = await decode(payload.channelBuffer, payload.channelExtension, payload.target);
  const {width, height} = channel;
  postProgress("平滑与阈值", 0.16);
  const smoothed = boxBlur(channel.data, width, height, payload.params.gaussian_sigma);
  let mask = thresholdMask(smoothed, payload.params);
  mask = opening(mask, width, height, payload.params.opening_radius);
  postProgress("距离变换", 0.34);
  const distance = distanceTransform(mask, width, height);
  postProgress("寻找细胞核", 0.52);
  const seeds = selectSeeds(mask, distance, width, height, payload.params.watershed_min_distance);
  if (!seeds.length) return {detections: [], width, height};
  const labels = floodLabels(mask, width, height, seeds);
  postProgress("筛选颗粒", 0.76);
  const detections = regionDetections(labels, width, height, payload.params);
  attachMaskRuns(labels, width, height, detections);
  for (const detection of detections) {
    detection.classification = payload.target;
    detection.area_um2 = detection.area_px * payload.pixelSizeUm ** 2;
  }
  postProgress("完成颗粒计数", 0.98);
  return {detections, width, height};
}

onmessage = async event => {
  if (event.data.type !== "analyze") return;
  try {
    const result = await analyze(event.data);
    postMessage({type: "result", ...result});
  } catch (error) {
    postMessage({type: "error", error: error.message || String(error)});
  }
};
