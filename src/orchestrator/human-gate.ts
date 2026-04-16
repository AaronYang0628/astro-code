import fs from "node:fs";
import path from "node:path";
import type {
  InteractionBackend,
  InteractionMode,
  SelectionConditionConfig,
  SelectionConditionId,
  SelectionPlan
} from "./types.js";

interface HumanGateContext {
  runId: string;
  candidatePoolRows: number;
  desiRows: number;
  retryApplied: boolean;
  retryScale: number;
  availableFields: string[];
  previewSample: Record<string, unknown>[];
  queryCenter: {
    ra_deg: number;
    dec_deg: number;
  };
}

interface SelectionGateContext {
  runId: string;
  candidatePoolRows: number;
  previewSample: Record<string, unknown>[];
}

export interface HumanGateResult {
  mode: "region_adjust" | "mock_continue" | "none";
  requestFile?: string;
}

export interface SelectionGateResult {
  mode: "selected" | "default";
  plan: SelectionPlan;
  requestFile?: string;
  responseFile?: string;
}

const SELECTION_CONDITION_IDS: SelectionConditionId[] = [
  "galaxy_fraction",
  "bright_maskbits_filter",
  "faint_mag_limit",
  "small_dim_galaxy_filter",
  "oversized_galaxy_filter",
  "uniform_mag_sampling"
];

const DEFAULT_SELECTION_PLAN: SelectionPlan = {
  conditions: []
};

function parseZeroResultAction(response: unknown): "region_adjust" | "mock_continue" | undefined {
  if (typeof response !== "object" || response === null) {
    return undefined;
  }

  const record = response as Record<string, unknown>;
  const direct = record.action;
  if (typeof direct === "string") {
    const v = direct.trim().toLowerCase();
    if (v === "region_adjust" || v === "mock_continue") {
      return v;
    }
  }

  const selected = record.selected;
  if (Array.isArray(selected) && selected.length > 0) {
    const labels = selected.map((item) => String(item).toLowerCase());
    if (labels.some((label) => label.includes("mock"))) {
      return "mock_continue";
    }
    if (labels.some((label) => label.includes("region") || label.includes("adjust") || label.includes("real"))) {
      return "region_adjust";
    }
  }

  return undefined;
}

function normalizeSelectionConditionId(value: unknown): SelectionConditionId | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const raw = value.trim().toLowerCase();
  if (SELECTION_CONDITION_IDS.includes(raw as SelectionConditionId)) {
    return raw as SelectionConditionId;
  }

  if (raw.includes("fraction") || raw.includes("占比") || raw.includes("数量")) {
    return "galaxy_fraction";
  }
  if (raw.includes("maskbits") || raw.includes("过亮") || raw.includes("bright")) {
    return "bright_maskbits_filter";
  }
  if (raw.includes("过暗") || raw.includes("faint") || raw.includes("mag")) {
    return "faint_mag_limit";
  }
  if (raw.includes("尺寸小") || raw.includes("small") || raw.includes("seg_area")) {
    return "small_dim_galaxy_filter";
  }
  if (raw.includes("过大") || raw.includes("stamp") || raw.includes("oversized")) {
    return "oversized_galaxy_filter";
  }
  if (raw.includes("均匀") || raw.includes("uniform") || raw.includes("sampling")) {
    return "uniform_mag_sampling";
  }
  return undefined;
}

function parseSelectionPlan(response: unknown): SelectionPlan | undefined {
  if (typeof response !== "object" || response === null) {
    return undefined;
  }

  const record = response as Record<string, unknown>;
  const out: SelectionConditionConfig[] = [];

  const fromConditions = record.conditions;
  if (Array.isArray(fromConditions)) {
    for (const item of fromConditions) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const cond = item as Record<string, unknown>;
      const id = normalizeSelectionConditionId(cond.id);
      if (!id) {
        continue;
      }
      out.push({
        id,
        params: (typeof cond.params === "object" && cond.params !== null)
          ? (cond.params as Record<string, unknown>)
          : {}
      });
    }
  }

  const selected = record.selected;
  if (Array.isArray(selected) && selected.length > 0) {
    const paramsMap = (typeof record.params === "object" && record.params !== null)
      ? (record.params as Record<string, unknown>)
      : {};

    for (const label of selected) {
      const id = normalizeSelectionConditionId(label);
      if (!id) {
        continue;
      }
      const params = paramsMap[id];
      out.push({
        id,
        params: (typeof params === "object" && params !== null)
          ? (params as Record<string, unknown>)
          : {}
      });
    }
  }

  if (out.length === 0) {
    return undefined;
  }

  const unique: SelectionConditionConfig[] = [];
  const seen = new Set<string>();
  for (const cond of out) {
    if (!seen.has(cond.id)) {
      seen.add(cond.id);
      unique.push(cond);
    }
  }

  const order = record.order;
  if (Array.isArray(order) && order.length > 0) {
    const rank = new Map<SelectionConditionId, number>();
    let index = 0;
    for (const item of order) {
      const id = normalizeSelectionConditionId(item);
      if (!id || rank.has(id)) {
        continue;
      }
      rank.set(id, index);
      index += 1;
    }

    unique.sort((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      if (ra === undefined && rb === undefined) {
        return 0;
      }
      if (ra === undefined) {
        return 1;
      }
      if (rb === undefined) {
        return -1;
      }
      return ra - rb;
    });
  }

  return { conditions: unique };
}

export async function resolveSelectionPlan(
  runDir: string,
  interaction: InteractionMode,
  interactionBackend: InteractionBackend,
  context: SelectionGateContext,
  inlineSelection?: SelectionPlan
): Promise<SelectionGateResult> {
  if (inlineSelection && Array.isArray(inlineSelection.conditions) && inlineSelection.conditions.length > 0) {
    return {
      mode: "selected",
      plan: inlineSelection
    };
  }

  if (interaction !== "web") {
    return {
      mode: "default",
      plan: DEFAULT_SELECTION_PLAN
    };
  }

  const requestPath = path.join(runDir, "selection_plan_request.json");
  const responsePath = path.join(runDir, "selection_plan_response.json");

  const requestBody = {
    title: "Selection plan (6 conditions, any combination)",
    run_id: context.runId,
    interaction_mode: interactionBackend,
    instruction: "Pick any subset and order of the six conditions. You may select only one. Write response JSON to selection_plan_response.json",
    response_file: responsePath,
    notes: [
      "No fixed execution order is required; user-selected order is honored.",
      "Condition #1 uses galaxy_fraction + total_samples.",
      "Condition #6 uniform sampling should normally be used after quality filters."
    ],
    options: [
      {
        id: "galaxy_fraction",
        label: "Condition1 galaxy fraction",
        purpose: "Control star/galaxy ratio and total sample count",
        default_params: { total_samples: 100, galaxy_fraction: 0.5 }
      },
      {
        id: "bright_maskbits_filter",
        label: "Condition2 bright-source filter",
        purpose: "Remove saturated/over-bright sources by maskbits",
        default_params: { mode: "maskbits_eq_0", threshold: 0 }
      },
      {
        id: "faint_mag_limit",
        label: "Condition3 faint-limit filter",
        purpose: "Remove too-faint sources",
        default_params: { mag_max: 24 }
      },
      {
        id: "small_dim_galaxy_filter",
        label: "Condition4 small+dim galaxy",
        purpose: "Drop galaxies that are both too small and too dim",
        default_params: { seg_area_min: 200, galaxy_mag_max: 24 }
      },
      {
        id: "oversized_galaxy_filter",
        label: "Condition5 oversized galaxy",
        purpose: "Drop galaxies larger than stamp coverage",
        default_params: { stamp_size_px: 160 }
      },
      {
        id: "uniform_mag_sampling",
        label: "Condition6 uniform mag sampling",
        purpose: "Uniformly sample by magnitude; star/galaxy independently",
        default_params: { bins: 8, per_bin_per_class: 2 }
      }
    ],
    response_template: {
      selected: ["bright_maskbits_filter", "faint_mag_limit", "galaxy_fraction", "uniform_mag_sampling"],
      order: ["bright_maskbits_filter", "faint_mag_limit", "galaxy_fraction", "uniform_mag_sampling"],
      params: {
        galaxy_fraction: { total_samples: 120, galaxy_fraction: 0.5 },
        faint_mag_limit: { mag_max: 24 },
        bright_maskbits_filter: { mode: "maskbits_eq_0", threshold: 0 },
        uniform_mag_sampling: { bins: 8, per_bin_per_class: 2 }
      }
    },
    current_stats: {
      candidate_pool_rows: context.candidatePoolRows,
      preview_sample: context.previewSample
    }
  };

  fs.writeFileSync(requestPath, JSON.stringify(requestBody, null, 2));

  const parsed = fs.existsSync(responsePath)
    ? parseSelectionPlan(JSON.parse(fs.readFileSync(responsePath, "utf8")))
    : undefined;

  return {
    mode: parsed ? "selected" : "default",
    plan: parsed ?? DEFAULT_SELECTION_PLAN,
    requestFile: requestPath,
    responseFile: fs.existsSync(responsePath) ? responsePath : undefined
  };
}

export async function resolveHumanFilter(
  runDir: string,
  interaction: InteractionMode,
  interactionBackend: InteractionBackend,
  context: HumanGateContext
): Promise<HumanGateResult> {
  if (interaction !== "web") {
    return { mode: "none" };
  }

  if (context.candidatePoolRows === 0) {
    const regionRequestPath = path.join(runDir, "region_adjust_request.json");
    const zeroActionResponsePath = path.join(runDir, "zero_result_action_response.json");
    const regionRequest = {
      title: "No crossmatch results",
      run_id: context.runId,
      interaction_mode: interactionBackend,
      reason: "No matched rows after DESI query and crossmatch",
      decision: {
        action_required: true,
        options: [
          {
            id: "region_adjust",
            label: "Use real-data region adjust",
            description: "Keep real data only; change region/radius and rerun"
          },
          {
            id: "mock_continue",
            label: "Use mock data to continue",
            description: "Development mode: generate mock continuation artifacts"
          }
        ],
        response_file: zeroActionResponsePath
      },
      status: {
        desi_rows: context.desiRows,
        candidate_pool_rows: context.candidatePoolRows,
        retry_applied: context.retryApplied,
        retry_scale: context.retryScale
      },
      query_center: context.queryCenter,
      suggestions: [
        "Widen query window or change RA/DEC center",
        "Try larger match radius (for example 2.0 arcsec)",
        "Retry with alternative sky region for DESI coverage"
      ],
      next_request_template: {
        input: {
          type: "radec_text",
          value: `${context.queryCenter.ra_deg.toFixed(6)},${context.queryCenter.dec_deg.toFixed(6)}`
        },
        radiusArcsec: 2.0,
        topK: 100,
        previewRows: 100,
        interaction: "web"
      }
    };

    fs.writeFileSync(regionRequestPath, JSON.stringify(regionRequest, null, 2));

    const action = fs.existsSync(zeroActionResponsePath)
      ? parseZeroResultAction(JSON.parse(fs.readFileSync(zeroActionResponsePath, "utf8")))
      : undefined;

    if (action === "mock_continue") {
      return {
        mode: "mock_continue",
        requestFile: regionRequestPath
      };
    }

    return {
      mode: "region_adjust",
      requestFile: regionRequestPath
    };
  }

  return { mode: "none" };
}
