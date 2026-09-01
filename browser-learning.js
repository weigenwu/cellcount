/*
 * CellScope local correction memory.
 *
 * This is deliberately a small, explainable binary classifier.  It stores only
 * the numeric shape/signal features and optional small JSON metadata supplied
 * by the caller; image pixels never enter localStorage.
 */
(function attachCellScopeLearning(root) {
  "use strict";

  const VERSION = 1;
  const STORAGE_KEY = "cellscope-learning-v1";
  const MIN_SAMPLES_PER_CLASS = 4;
  const MAX_SAMPLES_PER_CLASS = 256;
  const K_NEIGHBOURS = 7;
  const MISMATCH_CONFIDENCE = 0.8;
  const FEATURE_KEYS = Object.freeze([
    "area_px",
    "area_um2",
    "circularity",
    "radius",
    "positive_fraction",
    "positive_fraction_min",
    "positive_fraction_max",
    "signal_area_px",
    "signal_background",
    "signal_mad",
    "signal_threshold_actual",
    "ring_radius_px_resolved",
    "nuclei_per_cell",
    "nucleus_count",
    "anchor_area_px",
    "edge_touching",
  ]);

  let memoryStore = null;

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function finiteNumber(value) {
    if (value == null) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string" && value.trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function mean(values) {
    const usable = values.filter(Number.isFinite);
    return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
  }

  function standardDeviation(values, center) {
    const usable = values.filter(Number.isFinite);
    if (usable.length < 2) return 1;
    const average = Number.isFinite(center) ? center : mean(usable);
    const variance = usable.reduce((sum, value) => sum + (value - average) ** 2, 0) / usable.length;
    return Math.sqrt(variance) || 1;
  }

  function normaliseProfileKey(profileKey) {
    const key = String(profileKey == null ? "default" : profileKey).trim();
    return key || "default";
  }

  function normaliseLabel(label) {
    if (label === true || label === 1) return "positive";
    if (label === false || label === 0) return "negative";
    const value = String(label == null ? "" : label).trim().toLowerCase();
    const compact = value.replace(/[\s_-]+/g, "");
    if (["positive", "pos", "yes", "true", "1", "阳性", "是", "cic", "samecic", "heterocic", "同质cic", "异质cic"].includes(compact)) return "positive";
    if (["negative", "neg", "no", "false", "0", "阴性", "否", "notcic", "noncic", "非cic", "非cic细胞"].includes(compact)) return "negative";
    return null;
  }

  function cloneJson(value) {
    if (value == null) return value;
    try {
      return JSON.parse(JSON.stringify(value, function replacer(key, item) {
        if (typeof item === "number" && !Number.isFinite(item)) return null;
        if (typeof item === "bigint") return String(item);
        if (typeof item === "function" || typeof item === "symbol") return undefined;
        return item;
      }));
    } catch (_) {
      return undefined;
    }
  }

  function safeMetadata(meta) {
    if (meta == null) return undefined;
    const clone = cloneJson(meta);
    if (clone === undefined) return undefined;
    // Metadata is for provenance only.  Keep storage bounded even if a caller
    // accidentally passes an entire application state object.
    try {
      const encoded = JSON.stringify(clone);
      if (encoded.length > 32768) return { truncated: true };
    } catch (_) {
      return undefined;
    }
    return clone;
  }

  function medianEvidence(detection, key) {
    const evidence = Array.isArray(detection?.nucleus_evidence) ? detection.nucleus_evidence : [];
    return median(evidence.map(item => finiteNumber(item?.[key])).filter(Number.isFinite));
  }

  function nucleiCount(detection) {
    const direct = finiteNumber(detection?.nuclei_per_cell ?? detection?.nucleus_count);
    if (direct != null) return direct;
    if (Array.isArray(detection?.nucleus_ids)) return detection.nucleus_ids.length;
    if (Array.isArray(detection?.nucleus_labels)) return detection.nucleus_labels.length;
    return null;
  }

  /** Return a fixed set of stable numeric morphology/signal features. */
  function extractFeatures(detection) {
    const item = detection && typeof detection === "object" ? detection : {};
    const fraction = finiteNumber(item.positive_fraction) ?? medianEvidence(item, "positive_fraction");
    const signalArea = finiteNumber(item.signal_area_px) ?? medianEvidence(item, "signal_area_px");
    const background = finiteNumber(item.signal_background) ?? medianEvidence(item, "signal_background");
    const mad = finiteNumber(item.signal_mad) ?? medianEvidence(item, "signal_mad");
    const actualThreshold = finiteNumber(item.signal_threshold_actual) ?? medianEvidence(item, "signal_threshold_actual");
    const count = nucleiCount(item);
    const values = {
      area_px: finiteNumber(item.area_px),
      area_um2: finiteNumber(item.area_um2),
      circularity: finiteNumber(item.circularity),
      radius: finiteNumber(item.radius),
      positive_fraction: fraction,
      positive_fraction_min: finiteNumber(item.positive_fraction_min),
      positive_fraction_max: finiteNumber(item.positive_fraction_max),
      signal_area_px: signalArea,
      signal_background: background,
      signal_mad: mad,
      signal_threshold_actual: actualThreshold,
      ring_radius_px_resolved: finiteNumber(item.ring_radius_px_resolved),
      nuclei_per_cell: count,
      nucleus_count: count,
      anchor_area_px: finiteNumber(item.anchor_area_px),
      edge_touching: item.edge_touching == null ? null : (item.edge_touching ? 1 : 0),
    };
    return FEATURE_KEYS.reduce((output, key) => {
      output[key] = values[key] == null ? null : values[key];
      return output;
    }, {});
  }

  function storage() {
    try {
      if (root && root.localStorage) return root.localStorage;
    } catch (_) {
      // Private browsing and disabled storage are allowed; use a session memory.
    }
    return {
      getItem() { return memoryStore; },
      setItem(_, value) { memoryStore = value; },
      removeItem() { memoryStore = null; },
    };
  }

  function emptyState() {
    return { version: VERSION, profiles: {} };
  }

  function readState() {
    const source = storage();
    let parsed;
    try {
      parsed = JSON.parse(source.getItem(STORAGE_KEY) || "null");
    } catch (_) {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") return emptyState();
    const state = emptyState();
    const profiles = parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {};
    for (const [key, profile] of Object.entries(profiles)) {
      if (!profile || typeof profile !== "object") continue;
      state.profiles[key] = {
        positive: sanitiseSamples(profile.positive),
        negative: sanitiseSamples(profile.negative),
        updatedAt: typeof profile.updatedAt === "string" ? profile.updatedAt : undefined,
      };
    }
    return state;
  }

  function sanitiseSamples(samples) {
    if (!Array.isArray(samples)) return [];
    return samples.slice(-MAX_SAMPLES_PER_CLASS).map(sample => {
      const label = normaliseLabel(sample?.label);
      const features = sample?.features && typeof sample.features === "object" ? extractFeatures(sample.features) : null;
      if (!label || !features) return null;
      const output = { label, features };
      if (sample.createdAt) output.createdAt = String(sample.createdAt);
      if (sample.meta !== undefined) output.meta = safeMetadata(sample.meta);
      return output;
    }).filter(Boolean);
  }

  function writeState(state) {
    const serialised = JSON.stringify(state);
    try {
      storage().setItem(STORAGE_KEY, serialised);
    } catch (_) {
      // A full/blocked localStorage should never stop counting or review.
      memoryStore = serialised;
    }
    return state;
  }

  function mergeSamples(existing, incoming) {
    const unique = new Map();
    for (const sample of existing.concat(incoming)) {
      const signature = JSON.stringify([sample.label, sample.createdAt || "", sample.features]);
      unique.set(signature, sample);
    }
    return [...unique.values()].slice(-MAX_SAMPLES_PER_CLASS);
  }

  function getProfile(state, profileKey, create) {
    const key = normaliseProfileKey(profileKey);
    if (!state.profiles[key] && create) state.profiles[key] = { positive: [], negative: [] };
    return state.profiles[key] || null;
  }

  function sampleCount(profile) {
    return (profile?.positive?.length || 0) + (profile?.negative?.length || 0);
  }

  function profileStats(profileKey) {
    const profile = getProfile(readState(), profileKey, false);
    const positive = profile?.positive?.length || 0;
    const negative = profile?.negative?.length || 0;
    return {
      profileKey: normaliseProfileKey(profileKey),
      positive,
      negative,
      total: positive + negative,
      minSamplesPerClass: MIN_SAMPLES_PER_CLASS,
      maxSamplesPerClass: MAX_SAMPLES_PER_CLASS,
      trained: positive >= MIN_SAMPLES_PER_CLASS && negative >= MIN_SAMPLES_PER_CLASS,
      featureKeys: FEATURE_KEYS.slice(),
      updatedAt: profile?.updatedAt || null,
    };
  }

  function record(profileKey, detection, label, meta) {
    const normalisedLabel = normaliseLabel(label);
    if (!normalisedLabel) throw new TypeError("label must be positive/negative (or true/false)");
    const features = extractFeatures(detection);
    const state = readState();
    const key = normaliseProfileKey(profileKey);
    const profile = getProfile(state, key, true);
    const sample = { label: normalisedLabel, features, createdAt: new Date().toISOString() };
    const metadata = safeMetadata(meta);
    if (metadata !== undefined) sample.meta = metadata;
    profile[normalisedLabel].push(sample);
    if (profile[normalisedLabel].length > MAX_SAMPLES_PER_CLASS) {
      profile[normalisedLabel].splice(0, profile[normalisedLabel].length - MAX_SAMPLES_PER_CLASS);
    }
    profile.updatedAt = sample.createdAt;
    writeState(state);
    return { ...sample, profileKey: key, stats: profileStats(key) };
  }

  function featureStatistics(samples) {
    return FEATURE_KEYS.reduce((output, key) => {
      const values = samples.map(sample => finiteNumber(sample?.features?.[key])).filter(Number.isFinite);
      const center = mean(values);
      output[key] = { mean: center == null ? 0 : center, scale: standardDeviation(values, center), count: values.length };
      return output;
    }, {});
  }

  function distance(candidate, sample, statistics) {
    let squared = 0;
    let dimensions = 0;
    for (const key of FEATURE_KEYS) {
      const left = finiteNumber(candidate[key]);
      const right = finiteNumber(sample?.features?.[key]);
      if (left == null || right == null) continue;
      const scale = statistics[key]?.scale || 1;
      const delta = (left - right) / scale;
      squared += delta * delta;
      dimensions++;
    }
    if (!dimensions) return null;
    return { value: Math.sqrt(squared / dimensions), dimensions };
  }

  function predict(profileKey, detection) {
    const state = readState();
    const profile = getProfile(state, profileKey, false);
    const positive = profile?.positive || [];
    const negative = profile?.negative || [];
    const result = {
      trained: positive.length >= MIN_SAMPLES_PER_CLASS && negative.length >= MIN_SAMPLES_PER_CLASS,
      score: null,
      confidence: 0,
      decision: "unknown",
    };
    if (!result.trained) return result;

    const candidate = extractFeatures(detection);
    const samples = positive.concat(negative);
    const statistics = featureStatistics(samples);
    const neighbours = samples.map(sample => {
      const measurement = distance(candidate, sample, statistics);
      return measurement ? { sample, ...measurement } : null;
    }).filter(Boolean).sort((left, right) => left.value - right.value).slice(0, K_NEIGHBOURS);
    if (!neighbours.length) return result;
    let positiveWeight = 0;
    let negativeWeight = 0;
    let dimensionCoverage = 0;
    let candidateDimensions = 0;
    for (const key of FEATURE_KEYS) if (finiteNumber(candidate[key]) != null) candidateDimensions++;
    for (const neighbour of neighbours) {
      const weight = 1 / (0.25 + neighbour.value);
      if (neighbour.sample.label === "positive") positiveWeight += weight;
      else negativeWeight += weight;
      dimensionCoverage += candidateDimensions ? neighbour.dimensions / candidateDimensions : 0;
    }
    const totalWeight = positiveWeight + negativeWeight;
    const score = totalWeight ? (positiveWeight - negativeWeight) / totalWeight : 0;
    const coverage = Math.min(1, dimensionCoverage / neighbours.length);
    // A prediction based on one unusually discriminative field should remain
    // visibly less certain than one supported by several independent fields.
    const featureCoverage = Math.min(1, candidateDimensions / 4);
    result.score = Math.max(-1, Math.min(1, score));
    result.confidence = Math.max(0, Math.min(1, Math.abs(result.score) * coverage * featureCoverage));
    result.decision = result.score > 0 ? "positive" : result.score < 0 ? "negative" : "unknown";
    return result;
  }

  function currentBinaryLabel(detection) {
    const item = detection && typeof detection === "object" ? detection : {};
    const candidates = [item.learning_label, item.label, item.is_positive, item.positive, item.classification, item.class, item.status];
    for (const value of candidates) {
      const label = normaliseLabel(value);
      if (label) return label;
    }
    return null;
  }

  function apply(profileKey, detections) {
    if (!Array.isArray(detections)) return detections;
    for (const detection of detections) {
      if (!detection || typeof detection !== "object") continue;
      const prediction = predict(profileKey, detection);
      detection.learning_score = prediction.score;
      detection.confidence = prediction.confidence;
      if (!prediction.trained || prediction.decision === "unknown" || prediction.confidence < MISMATCH_CONFIDENCE) continue;
      const current = currentBinaryLabel(detection);
      if (!current || current === prediction.decision) continue;
      detection.review_required = true;
      const reasons = Array.isArray(detection.review_reasons) ? detection.review_reasons : [];
      if (!reasons.includes("learned_mismatch")) reasons.push("learned_mismatch");
      detection.review_reasons = reasons;
    }
    return detections;
  }

  function exportData() {
    const state = readState();
    return cloneJson({
      version: VERSION,
      exportedAt: new Date().toISOString(),
      maxSamplesPerClass: MAX_SAMPLES_PER_CLASS,
      profiles: state.profiles,
    });
  }

  function importData(data, options) {
    let incoming = data;
    if (typeof incoming === "string") {
      try { incoming = JSON.parse(incoming); } catch (_) { throw new TypeError("Invalid learning JSON"); }
    }
    if (!incoming || typeof incoming !== "object" || !incoming.profiles || typeof incoming.profiles !== "object") {
      throw new TypeError("Learning data must contain a profiles object");
    }
    const replace = options === true || options?.replace === true;
    const state = replace ? emptyState() : readState();
    for (const [key, profile] of Object.entries(incoming.profiles)) {
      const target = getProfile(state, key, true);
      const importedPositive = sanitiseSamples(profile?.positive);
      const importedNegative = sanitiseSamples(profile?.negative);
      if (replace) {
        target.positive = importedPositive.slice(-MAX_SAMPLES_PER_CLASS);
        target.negative = importedNegative.slice(-MAX_SAMPLES_PER_CLASS);
      } else {
        target.positive = mergeSamples(target.positive, importedPositive);
        target.negative = mergeSamples(target.negative, importedNegative);
      }
      target.updatedAt = profile?.updatedAt || new Date().toISOString();
    }
    writeState(state);
    return stats();
  }

  function clearProfile(profileKey) {
    const state = readState();
    delete state.profiles[normaliseProfileKey(profileKey)];
    writeState(state);
    return profileStats(profileKey);
  }

  function stats(profileKey) {
    if (profileKey !== undefined) return profileStats(profileKey);
    const state = readState();
    return Object.keys(state.profiles).sort().map(key => profileStats(key));
  }

  const api = Object.freeze({
    version: VERSION,
    featureKeys: FEATURE_KEYS.slice(),
    minSamplesPerClass: MIN_SAMPLES_PER_CLASS,
    maxSamplesPerClass: MAX_SAMPLES_PER_CLASS,
    extractFeatures,
    record,
    predict,
    apply,
    stats,
    exportData,
    importData,
    clearProfile,
  });
  root.CellScopeLearning = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
