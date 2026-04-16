import type { CrossmatchRecord, SelectionConditionConfig, SelectionConditionId, SelectionPlan } from "./types.js";

interface RowWithClass {
  row: CrossmatchRecord;
  classKind: "star" | "galaxy" | "unknown";
  mag: number | null;
}

interface SelectionCounts {
  total: number;
  star: number;
  galaxy: number;
  unknown: number;
}

export interface SelectionStepLog {
  condition_id: SelectionConditionId;
  params: Record<string, unknown>;
  before: SelectionCounts;
  after: SelectionCounts;
}

export interface SelectionResult {
  requested_conditions: SelectionConditionConfig[];
  effective_order: SelectionConditionId[];
  enabled: boolean;
  selected_rows: CrossmatchRecord[];
  candidate_rows_after_quality: CrossmatchRecord[];
  steps: SelectionStepLog[];
}

const DEFAULT_CONDITIONS: SelectionConditionConfig[] = [];

const KNOWN_CONDITIONS = new Set<SelectionConditionId>([
  "galaxy_fraction",
  "bright_maskbits_filter",
  "faint_mag_limit",
  "small_dim_galaxy_filter",
  "oversized_galaxy_filter",
  "uniform_mag_sampling"
]);

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeClassLabel(value: string): "star" | "galaxy" | "unknown" {
  const v = value.trim().toLowerCase();
  if (v.length === 0) {
    return "unknown";
  }
  if (v.includes("star") || v === "psf" || v === "point" || v === "point_source") {
    return "star";
  }
  if (v.includes("gal") || v.includes("extended") || v === "rex") {
    return "galaxy";
  }
  return "unknown";
}

function inferClassKind(row: CrossmatchRecord): "star" | "galaxy" | "unknown" {
  const candidates = [
    String(row.type ?? ""),
    String(row.class_label ?? "")
  ];

  for (const candidate of candidates) {
    const klass = normalizeClassLabel(candidate);
    if (klass !== "unknown") {
      return klass;
    }
  }

  if (row.euclid_extended_flag !== null && row.euclid_extended_flag !== undefined) {
    return Number(row.euclid_extended_flag) > 0 ? "galaxy" : "star";
  }
  if (row.euclid_point_like_flag !== null && row.euclid_point_like_flag !== undefined) {
    return Number(row.euclid_point_like_flag) > 0 ? "star" : "galaxy";
  }
  return "unknown";
}

function inferMag(row: CrossmatchRecord): number | null {
  const options = [row.mag_proxy, row.desi_mag, row.euclid_mag];
  for (const item of options) {
    if (typeof item === "number" && Number.isFinite(item)) {
      return item;
    }
  }
  return null;
}

function asRowsWithClass(rows: CrossmatchRecord[]): RowWithClass[] {
  return rows.map((row) => ({
    row,
    classKind: inferClassKind(row),
    mag: inferMag(row)
  }));
}

function counts(rows: RowWithClass[]): SelectionCounts {
  let star = 0;
  let galaxy = 0;
  let unknown = 0;
  for (const item of rows) {
    if (item.classKind === "star") {
      star += 1;
    } else if (item.classKind === "galaxy") {
      galaxy += 1;
    } else {
      unknown += 1;
    }
  }
  return {
    total: rows.length,
    star,
    galaxy,
    unknown
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sortByMag(items: RowWithClass[]): RowWithClass[] {
  return [...items].sort((a, b) => {
    const ma = a.mag;
    const mb = b.mag;
    if (ma === null && mb === null) return 0;
    if (ma === null) return 1;
    if (mb === null) return -1;
    return ma - mb;
  });
}

function pickEvenlyFromSorted(sorted: RowWithClass[], target: number): RowWithClass[] {
  if (target <= 0 || sorted.length === 0) {
    return [];
  }
  if (target >= sorted.length) {
    return [...sorted];
  }
  if (target === 1) {
    return [sorted[Math.floor((sorted.length - 1) / 2)]];
  }

  const out: RowWithClass[] = [];
  const used = new Set<number>();
  const maxIndex = sorted.length - 1;
  for (let i = 0; i < target; i += 1) {
    const pos = Math.round((i / (target - 1)) * maxIndex);
    const idx = clamp(pos, 0, maxIndex);
    if (!used.has(idx)) {
      used.add(idx);
      out.push(sorted[idx]);
      continue;
    }

    let left = idx - 1;
    let right = idx + 1;
    while (left >= 0 || right <= maxIndex) {
      if (left >= 0 && !used.has(left)) {
        used.add(left);
        out.push(sorted[left]);
        break;
      }
      if (right <= maxIndex && !used.has(right)) {
        used.add(right);
        out.push(sorted[right]);
        break;
      }
      left -= 1;
      right += 1;
    }
  }
  return out;
}

function applyBrightMaskbitsFilter(rows: RowWithClass[], params: Record<string, unknown>): RowWithClass[] {
  const mode = String(params.mode ?? "maskbits_eq_0");
  const threshold = toNumber(params.threshold) ?? 0;
  if (mode === "maskbits_le") {
    return rows.filter((item) => {
      const mask = item.row.maskbits;
      return typeof mask === "number" && Number.isFinite(mask) ? mask <= threshold : false;
    });
  }

  return rows.filter((item) => {
    const mask = item.row.maskbits;
    return typeof mask === "number" && Number.isFinite(mask) ? mask === 0 : false;
  });
}

function applyFaintMagLimit(rows: RowWithClass[], params: Record<string, unknown>): RowWithClass[] {
  const magMax = toNumber(params.mag_max) ?? 24;
  return rows.filter((item) => item.mag !== null && item.mag <= magMax);
}

function applySmallDimGalaxyFilter(rows: RowWithClass[], params: Record<string, unknown>): RowWithClass[] {
  const segAreaMin = toNumber(params.seg_area_min) ?? 200;
  const galaxyMagMax = toNumber(params.galaxy_mag_max) ?? 24;

  return rows.filter((item) => {
    if (item.classKind !== "galaxy") {
      return true;
    }
    const seg = item.row.seg_area;
    if (typeof seg !== "number" || !Number.isFinite(seg)) {
      return false;
    }
    if (seg >= segAreaMin) {
      return true;
    }
    if (item.mag === null) {
      return false;
    }
    return item.mag <= galaxyMagMax;
  });
}

function applyOversizedGalaxyFilter(rows: RowWithClass[], params: Record<string, unknown>): RowWithClass[] {
  const stampSize = toNumber(params.stamp_size_px) ?? 160;
  const maxAxis = stampSize / 2;
  return rows.filter((item) => {
    if (item.classKind !== "galaxy") {
      return true;
    }
    const semimajor = item.row.euclid_semimajor_axis;
    if (typeof semimajor === "number" && Number.isFinite(semimajor)) {
      return semimajor <= maxAxis;
    }
    const shapeR = item.row.shape_r;
    if (typeof shapeR === "number" && Number.isFinite(shapeR)) {
      return shapeR <= maxAxis;
    }
    return true;
  });
}

function applyGalaxyFraction(rows: RowWithClass[], params: Record<string, unknown>): RowWithClass[] {
  const totalSamplesRaw = toNumber(params.total_samples);
  const totalSamples = Math.max(1, Math.floor(totalSamplesRaw ?? rows.length));
  const fraction = clamp(toNumber(params.galaxy_fraction) ?? 0.5, 0, 1);

  const galaxies = sortByMag(rows.filter((item) => item.classKind === "galaxy"));
  const stars = sortByMag(rows.filter((item) => item.classKind === "star"));
  const unknown = sortByMag(rows.filter((item) => item.classKind === "unknown"));

  let targetGalaxy = Math.round(totalSamples * fraction);
  let targetStar = totalSamples - targetGalaxy;

  targetGalaxy = Math.min(targetGalaxy, galaxies.length);
  targetStar = Math.min(targetStar, stars.length);

  let remaining = totalSamples - targetGalaxy - targetStar;
  const bonusGalaxy = Math.min(remaining, Math.max(0, galaxies.length - targetGalaxy));
  targetGalaxy += bonusGalaxy;
  remaining -= bonusGalaxy;

  const bonusStar = Math.min(remaining, Math.max(0, stars.length - targetStar));
  targetStar += bonusStar;
  remaining -= bonusStar;

  const selected = [
    ...pickEvenlyFromSorted(galaxies, targetGalaxy),
    ...pickEvenlyFromSorted(stars, targetStar)
  ];

  if (remaining > 0) {
    selected.push(...pickEvenlyFromSorted(unknown, remaining));
  }

  return selected;
}

function applyUniformMagSampling(rows: RowWithClass[], params: Record<string, unknown>): RowWithClass[] {
  const bins = Math.max(1, Math.floor(toNumber(params.bins) ?? 8));
  const perBinPerClass = Math.max(1, Math.floor(toNumber(params.per_bin_per_class) ?? 2));

  const withMag = rows.filter((item) => item.mag !== null) as Array<RowWithClass & { mag: number }>;
  if (withMag.length === 0) {
    return [];
  }

  const mags = withMag.map((item) => item.mag);
  const minMag = Math.min(...mags);
  const maxMag = Math.max(...mags);
  const span = Math.max(1e-6, maxMag - minMag);

  const selected: RowWithClass[] = [];
  const classes: Array<"star" | "galaxy"> = ["star", "galaxy"];

  for (const klass of classes) {
    const subset = withMag.filter((item) => item.classKind === klass);
    for (let b = 0; b < bins; b += 1) {
      const low = minMag + (span * b) / bins;
      const high = b === bins - 1 ? maxMag + 1e-9 : minMag + (span * (b + 1)) / bins;
      const inBin = subset
        .filter((item) => item.mag >= low && item.mag < high)
        .sort((a, b2) => a.mag - b2.mag);
      selected.push(...pickEvenlyFromSorted(inBin, perBinPerClass));
    }
  }

  const seen = new Set<string>();
  const dedup: RowWithClass[] = [];
  for (const item of selected) {
    const key = `${item.row.euclid_object_id}|${item.row.desi_object_id}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedup.push(item);
    }
  }
  return dedup;
}

function normalizeRequestedConditions(plan?: SelectionPlan): SelectionConditionConfig[] {
  if (!plan || !Array.isArray(plan.conditions) || plan.conditions.length === 0) {
    return DEFAULT_CONDITIONS;
  }
  const out: SelectionConditionConfig[] = [];
  for (const cond of plan.conditions) {
    if (!cond || typeof cond !== "object" || typeof cond.id !== "string") {
      continue;
    }
    const id = cond.id as SelectionConditionId;
    if (!KNOWN_CONDITIONS.has(id)) {
      continue;
    }
    out.push({
      id,
      params: cond.params && typeof cond.params === "object" ? cond.params : {}
    });
  }
  return out.length > 0 ? out : DEFAULT_CONDITIONS;
}

function isQualityCondition(id: SelectionConditionId): boolean {
  return id === "bright_maskbits_filter"
    || id === "faint_mag_limit"
    || id === "small_dim_galaxy_filter"
    || id === "oversized_galaxy_filter";
}

export function applySelectionPlan(rows: CrossmatchRecord[], plan?: SelectionPlan): SelectionResult {
  const requested = normalizeRequestedConditions(plan);
  let current = asRowsWithClass(rows);
  const steps: SelectionStepLog[] = [];
  let candidateRowsAfterQuality = [...current];
  let qualityApplied = false;

  for (const cond of requested) {
    const params = (cond.params ?? {}) as Record<string, unknown>;
    const before = counts(current);

    switch (cond.id) {
      case "bright_maskbits_filter":
        current = applyBrightMaskbitsFilter(current, params);
        break;
      case "faint_mag_limit":
        current = applyFaintMagLimit(current, params);
        break;
      case "small_dim_galaxy_filter":
        current = applySmallDimGalaxyFilter(current, params);
        break;
      case "oversized_galaxy_filter":
        current = applyOversizedGalaxyFilter(current, params);
        break;
      case "galaxy_fraction":
        current = applyGalaxyFraction(current, params);
        break;
      case "uniform_mag_sampling":
        current = applyUniformMagSampling(current, params);
        break;
      default:
        break;
    }

    const after = counts(current);
    steps.push({
      condition_id: cond.id,
      params,
      before,
      after
    });

    if (isQualityCondition(cond.id)) {
      qualityApplied = true;
      candidateRowsAfterQuality = [...current];
    }
  }

  if (!qualityApplied) {
    candidateRowsAfterQuality = [...current];
  }

  return {
    requested_conditions: requested,
    effective_order: requested.map((c) => c.id),
    enabled: requested.length > 0,
    selected_rows: current.map((item) => item.row),
    candidate_rows_after_quality: candidateRowsAfterQuality.map((item) => item.row),
    steps
  };
}
