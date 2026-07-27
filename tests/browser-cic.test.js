const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const context = {
  console,
  importScripts() {},
  postMessage() {},
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Float64Array,
  Map,
  Math,
  Blob,
};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "browser-worker.js"), "utf8"),
  context
);

const width = 120;
const height = 120;
const defaults = {
  min_enclosure_coverage: 0.75,
  ring_width_px: 20,
  min_ring_contrast: 0.05,
  max_candidates: 50,
  red_quantile: 0.72,
  sector_positive_fraction: 0.18,
  homotypic_enabled: true,
  homotypic_min_coverage: 0.88,
  homotypic_host_max_circularity: 0.78,
  host_max_distance_px: 60,
};

function ringImage(fullRing = true) {
  const red = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - 60;
      const dy = y - 60;
      const radius = Math.hypot(dx, dy);
      const allowedAngle = fullRing || x >= 60;
      if (radius >= 10 && radius <= 28 && allowedAngle) red[y * width + x] = 210;
    }
  }
  return red;
}

const nk = [{id: "nk-1", x: 60, y: 60, radius: 8, circularity: 0.9}];
const tumors = [
  {id: "tumor-inner", x: 60, y: 60, radius: 8, circularity: 0.9},
  {id: "tumor-host", x: 85, y: 60, radius: 14, circularity: 0.55},
];

const events = context.analyzeCicCandidates(
  ringImage(true), width, height, nk, tumors, defaults
);
assert(events.some(event => event.type_hint === "heterotypic"));
assert(events.some(event => event.type_hint === "homotypic"));
assert(events.every(event => event.classification === "pending"));

const oneSided = context.analyzeCicCandidates(
  ringImage(false), width, height, nk, tumors,
  {...defaults, homotypic_enabled: false}
);
assert.equal(oneSided.length, 0);

console.log("browser CIC candidate tests passed");
