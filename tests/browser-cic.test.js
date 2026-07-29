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
  evidence_profile: "ppt_annotated",
  min_enclosure_coverage: 0.55,
  ring_width_px: 20,
  min_ring_contrast: 0.05,
  max_candidates: 50,
  red_quantile: 0.72,
  sector_positive_fraction: 0.18,
  homotypic_enabled: true,
  homotypic_min_coverage: 0.88,
  homotypic_host_max_circularity: 0.78,
  host_max_distance_px: 60,
  min_host_separation_factor: 0.58,
  host_radius_allowance: 1.8,
  max_inner_host_area_ratio: 1.5,
};

function ringImage(mode = "full") {
  const red = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - 60;
      const dy = y - 60;
      const radius = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const allowedAngle = mode === "full"
        || (mode === "one-sided" && x >= 60)
        || (mode === "partial" && !(angle > -Math.PI / 3 && angle < Math.PI / 3));
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
  ringImage("full"), width, height, nk, tumors, defaults
);
assert(events.some(event => event.type_hint === "heterotypic"));
assert(events.some(event => event.type_hint === "homotypic"));
assert(events.every(event => event.classification === "pending"));
assert(events.find(event => event.type_hint === "heterotypic").evidence_grade === "A");

const oneSided = context.analyzeCicCandidates(
  ringImage("one-sided"), width, height, nk, tumors,
  {...defaults, homotypic_enabled: false}
);
assert.equal(oneSided.length, 0);

const partial = context.analyzeCicCandidates(
  ringImage("partial"), width, height, nk, tumors,
  {...defaults, homotypic_enabled: false}
);
assert.equal(partial.length, 1);
assert.equal(partial[0].evidence_grade, "B");
assert(partial[0].opposite_pairs >= 2);
assert(partial[0].quadrant_count >= 3);

const strictPartial = context.analyzeCicCandidates(
  ringImage("partial"), width, height, nk, tumors,
  {...defaults, evidence_profile: "strict_complete", homotypic_enabled: false}
);
assert.equal(strictPartial.length, 0);

const doublePositiveOnly = context.analyzeCicCandidates(
  ringImage("full"), width, height, nk, [tumors[0]],
  {...defaults, homotypic_enabled: false}
);
assert.equal(doublePositiveOnly.length, 0);

console.log("browser CIC candidate tests passed");
