import fs from "node:fs";
import path from "node:path";
import type { FilterCondition, FilterSpec, InteractionBackend, InteractionMode } from "./types.js";

interface HumanGateContext {
  runId: string;
  crossmatchRows: number;
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

export interface HumanGateResult {
  filter?: FilterSpec;
  mode: "filter" | "filter_confirm" | "region_adjust" | "none";
  requestFile?: string;
}

function normalizeFilter(input: unknown): FilterSpec | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const maybeConditions = record.conditions;
  if (Array.isArray(maybeConditions)) {
    const conditions: FilterCondition[] = [];
    for (const item of maybeConditions) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const cond = item as Record<string, unknown>;
      const field = typeof cond.field === "string" ? cond.field : undefined;
      const op = typeof cond.op === "string" ? cond.op : undefined;
      const value = cond.value;
      if (!field || !op || (typeof value !== "string" && typeof value !== "number")) {
        continue;
      }
      conditions.push({
        field,
        op: op as FilterCondition["op"],
        value
      });
    }

    if (conditions.length === 0) {
      return undefined;
    }

    return {
      logic: record.logic === "or" ? "or" : "and",
      conditions
    };
  }

  const field = typeof record.field === "string" ? record.field : undefined;
  const op = typeof record.op === "string" ? record.op : undefined;
  const value = record.value;
  if (!field || !op || (typeof value !== "string" && typeof value !== "number")) {
    return undefined;
  }

  return {
    logic: "and",
    conditions: [{
      field,
      op: op as FilterCondition["op"],
      value
    }]
  };
}

function parseShouldFilter(response: unknown): boolean | undefined {
  if (typeof response === "boolean") {
    return response;
  }

  if (typeof response !== "object" || response === null) {
    return undefined;
  }

  const record = response as Record<string, unknown>;

  if (typeof record.apply_filter === "boolean") {
    return record.apply_filter;
  }

  const choice = record.choice;
  if (typeof choice === "string") {
    if (choice.toLowerCase() === "yes" || choice.toLowerCase() === "true") {
      return true;
    }
    if (choice.toLowerCase() === "no" || choice.toLowerCase() === "false") {
      return false;
    }
  }

  const selected = record.selected;
  if (Array.isArray(selected) && selected.length > 0) {
    const labels = selected.map((item) => String(item).toLowerCase());
    if (labels.some((label) => label.includes("yes") || label.includes("filter"))) {
      return true;
    }
    if (labels.some((label) => label.includes("no") || label.includes("skip"))) {
      return false;
    }
  }

  return undefined;
}

export async function resolveHumanFilter(
  runDir: string,
  interaction: InteractionMode,
  interactionBackend: InteractionBackend,
  context: HumanGateContext,
  inlineFilter?: FilterCondition | FilterSpec
): Promise<HumanGateResult> {
  if (inlineFilter) {
    return {
      filter: normalizeFilter(inlineFilter),
      mode: "filter"
    };
  }

  if (interaction !== "web") {
    return { mode: "none" };
  }

  if (context.crossmatchRows === 0) {
    const regionRequestPath = path.join(runDir, "region_adjust_request.json");
    const regionRequest = {
      title: "No crossmatch results",
      run_id: context.runId,
      interaction_mode: interactionBackend,
      reason: "No matched rows after DESI query and crossmatch",
      status: {
        desi_rows: context.desiRows,
        crossmatch_rows: context.crossmatchRows,
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

    return {
      mode: "region_adjust",
      requestFile: regionRequestPath
    };
  }

  const requestPath = path.join(runDir, "human_gate_request.json");
  const responsePath = path.join(runDir, "human_gate_response.json");
  const entryRequestPath = path.join(runDir, "filter_entry_request.json");
  const entryResponsePath = path.join(runDir, "filter_entry_response.json");

  const entryRequest = {
      title: "Apply result filter?",
      run_id: context.runId,
      interaction_mode: interactionBackend,
      instruction: "Ask user whether to enter filtering stage via configured interaction backend (native/octto/hybrid). Write response to filter_entry_response.json",
    options: [
      { id: "yes_filter", label: "Yes, start filtering" },
      { id: "no_skip", label: "No, keep current result" }
    ],
    preview_info: {
      crossmatch_rows: context.crossmatchRows,
      available_fields: context.availableFields,
      preview_sample: context.previewSample
    }
  };

  fs.writeFileSync(entryRequestPath, JSON.stringify(entryRequest, null, 2));

  const shouldFilter = fs.existsSync(entryResponsePath)
    ? parseShouldFilter(JSON.parse(fs.readFileSync(entryResponsePath, "utf8")))
    : undefined;
  if (shouldFilter !== true) {
    return {
      mode: "none",
      requestFile: entryRequestPath
    };
  }

  const requestBody = {
      title: "Post-crossmatch filtering",
      run_id: context.runId,
      interaction_mode: interactionBackend,
      instruction: "Use configured interaction backend (native/octto/hybrid) to collect filter logic and multiple conditions, then write JSON to human_gate_response.json",
      preferred_ui: interactionBackend === "octto" ? "octto_form_chain" : interactionBackend === "hybrid" ? "native_then_octto" : "native_popup_chain",
    available_fields: context.availableFields,
    preview_sample: context.previewSample,
    format: {
      logic: "and",
      conditions: [
        {
          field: "desi_mag",
          op: "<=",
          value: 20
        },
        {
          field: "separation_arcsec",
          op: "<=",
          value: 1.0
        }
      ]
    }
  };

  fs.writeFileSync(requestPath, JSON.stringify(requestBody, null, 2));

  const filter = fs.existsSync(responsePath)
    ? normalizeFilter(JSON.parse(fs.readFileSync(responsePath, "utf8")))
    : undefined;
  return {
    filter,
    mode: filter ? "filter" : "none",
    requestFile: requestPath
  };
}
