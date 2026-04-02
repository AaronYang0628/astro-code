import fs from "node:fs";
import path from "node:path";
import type { FilterCondition, InteractionMode } from "./types.js";

interface HumanGateContext {
  runId: string;
  crossmatchRows: number;
  desiRows: number;
  retryApplied: boolean;
  retryScale: number;
  queryCenter: {
    ra_deg: number;
    dec_deg: number;
  };
}

export interface HumanGateResult {
  filter?: FilterCondition;
  mode: "filter" | "region_adjust" | "none";
  requestFile?: string;
}

export async function resolveHumanFilter(
  runDir: string,
  interaction: InteractionMode,
  context: HumanGateContext,
  inlineFilter?: FilterCondition
): Promise<HumanGateResult> {
  if (inlineFilter) {
    return { filter: inlineFilter, mode: "filter" };
  }

  if (interaction !== "web") {
    return { mode: "none" };
  }

  if (context.crossmatchRows === 0) {
    const regionRequestPath = path.join(runDir, "region_adjust_request.json");
    const regionRequest = {
      title: "No crossmatch results",
      run_id: context.runId,
      interaction_plugin: "octto",
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

  const requestBody = {
    title: "Post-crossmatch filtering",
    run_id: context.runId,
    interaction_plugin: "octto",
    instruction: "Set a field filter and write it into human_gate_response.json",
    format: {
      field: "desi_mag",
      op: "<=",
      value: 20
    }
  };

  fs.writeFileSync(requestPath, JSON.stringify(requestBody, null, 2));

  if (fs.existsSync(responsePath)) {
    const response = JSON.parse(fs.readFileSync(responsePath, "utf8")) as FilterCondition;
    return {
      filter: response,
      mode: "filter",
      requestFile: requestPath
    };
  }

  return {
    mode: "filter",
    requestFile: requestPath
  };
}
