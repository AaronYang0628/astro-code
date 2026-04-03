import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { extractCoord } from "./coord.js";
import { crossmatchCatalogs } from "./crossmatch.js";
import { applyFilter } from "./filter.js";
import { resolveHumanFilter } from "./human-gate.js";
import { createRunDir, ensureDir, writeCsv, writeJson, writeReport } from "./io.js";
import { queryCatalogMcp } from "./mcp.js";
import { loadPlaybook } from "./playbook.js";
import type { Playbook, RunRequest } from "./types.js";

interface RunnerOptions {
  configPath: string;
  playbookPath: string;
  requestPath: string;
}

interface RunArtifacts {
  euclidQueryCsv: string;
  desiQueryCsv: string;
  crossmatchCsv: string;
  previewCsv: string;
  previewSummaryJson: string;
  filteredCsv: string;
  statsJson: string;
  reportMd: string;
  resultIndexJson: string;
  humanGateRequestJson?: string;
  regionAdjustRequestJson?: string;
}

interface RunSummary {
  raDeg: number;
  decDeg: number;
  radiusArcsec: number;
  topK: number;
  desiHits: number;
  crossmatchRows: number;
  previewRows: number;
  filteredRows: number;
  availableFilterFields: string[];
  previewSample: Record<string, unknown>[];
  humanGateMode: "filter" | "filter_confirm" | "region_adjust" | "none";
}

function validatePlaybook(playbook: Playbook): void {
  const required = [
    "input-router",
    "coord-extractor",
    "euclid-query",
    "desi-query",
    "crossmatch",
    "preview-export",
    "human-filter-gate",
    "filtered-export"
  ];

  const existing = new Set(playbook.steps.map((s) => s.id));
  for (const id of required) {
    if (!existing.has(id)) {
      throw new Error(`Playbook missing required step: ${id}`);
    }
  }
}

export async function runMvpPipeline(options: RunnerOptions): Promise<{ runId: string; runDir: string; artifacts: RunArtifacts; summary: RunSummary }> {
  const config = loadConfig(options.configPath);
  const request = JSON.parse(fs.readFileSync(path.resolve(options.requestPath), "utf8")) as RunRequest;
  const playbook = loadPlaybook(path.resolve(options.playbookPath));

  if (config.runtime.strict_playbook_validation) {
    validatePlaybook(playbook);
  }

  ensureDir(config.paths.runs_dir);
  const { runId, runDir } = createRunDir(config.paths.runs_dir);

  const radiusArcsec = request.radiusArcsec ?? playbook.defaults?.radius_arcsec ?? config.defaults.default_radius_arcsec;
  const topK = request.topK ?? playbook.defaults?.top_k ?? config.defaults.top_k;
  const previewRows = request.previewRows ?? playbook.defaults?.preview_rows ?? config.defaults.preview_rows;
  const interaction = request.interaction ?? config.defaults.interaction_primary;
  const maxResultRows = config.defaults.max_result_rows;

  const coord = await extractCoord(request.input, config.runtime.python_bin);
  const euclidRows = await queryCatalogMcp("euclid", coord, topK);

  const retryScale = Number(process.env.DESI_RETRY_SCALE ?? "20");
  let desiRows = await queryCatalogMcp("desi", coord, topK, { windowScale: 1 });
  const desiRowsInitial = desiRows.length;
  let desiRetryApplied = false;

  if (desiRows.length === 0 && Number.isFinite(retryScale) && retryScale > 1) {
    desiRows = await queryCatalogMcp("desi", coord, topK, { windowScale: retryScale });
    desiRetryApplied = true;
  }

  const crossmatched = crossmatchCatalogs(euclidRows, desiRows, radiusArcsec);

  const crossmatchTruncated = crossmatched.slice(0, maxResultRows);
  const preview = crossmatchTruncated.slice(0, previewRows);
  const previewSample = preview.slice(0, 10) as unknown as Record<string, unknown>[];
  const availableFilterFields = crossmatchTruncated.length > 0
    ? Object.keys(crossmatchTruncated[0] as unknown as Record<string, unknown>)
    : [];

  const euclidQueryCsv = path.join(runDir, "euclid_query.csv");
  const desiQueryCsv = path.join(runDir, "desi_query.csv");
  const crossmatchCsv = path.join(runDir, "crossmatch.csv");
  const previewCsv = path.join(runDir, `preview_${previewRows}.csv`);
  const previewSummaryJson = path.join(runDir, "preview_summary.json");
  const filteredCsv = path.join(runDir, "filtered.csv");
  const statsJson = path.join(runDir, "stats.json");
  const reportMd = path.join(runDir, "report.md");
  const resultIndexJson = path.join(runDir, "result_index.json");

  writeCsv(euclidQueryCsv, euclidRows as unknown as Record<string, unknown>[]);
  writeCsv(desiQueryCsv, desiRows as unknown as Record<string, unknown>[]);
  writeCsv(crossmatchCsv, crossmatchTruncated as unknown as Record<string, unknown>[]);
  writeCsv(previewCsv, preview as unknown as Record<string, unknown>[]);
  writeJson(previewSummaryJson, {
    run_id: runId,
    crossmatch_rows: crossmatchTruncated.length,
    preview_rows: preview.length,
    available_filter_fields: availableFilterFields,
    preview_sample: previewSample
  });

  const humanGate = await resolveHumanFilter(
    runDir,
    interaction,
    {
      runId,
      crossmatchRows: crossmatchTruncated.length,
      desiRows: desiRows.length,
      retryApplied: desiRetryApplied,
      retryScale,
      queryCenter: {
        ra_deg: coord.ra_deg,
        dec_deg: coord.dec_deg
      },
      availableFields: availableFilterFields,
      previewSample
    },
    request.filter
  );
  const filtered = applyFilter(crossmatchTruncated, humanGate.filter);
  writeCsv(filteredCsv, filtered as unknown as Record<string, unknown>[]);

  const stats = {
    run_id: runId,
    input_type: request.input.type,
    interaction,
    radius_arcsec: radiusArcsec,
    top_k: topK,
    preview_rows: previewRows,
    euclid_rows: euclidRows.length,
    desi_rows: desiRows.length,
    desi_rows_initial: desiRowsInitial,
    desi_retry_applied: desiRetryApplied,
    desi_retry_scale: desiRetryApplied ? retryScale : null,
    crossmatch_rows_total: crossmatched.length,
    crossmatch_rows_written: crossmatchTruncated.length,
    filtered_rows: filtered.length,
    truncated: crossmatched.length > maxResultRows,
    human_gate_mode: humanGate.mode,
    human_gate_request_file: humanGate.requestFile ?? null,
    filter: humanGate.filter ?? null,
    artifact_paths: {
      euclid_query_csv: euclidQueryCsv,
      desi_query_csv: desiQueryCsv,
      crossmatch_csv: crossmatchCsv,
      preview_csv: previewCsv,
      preview_summary_json: previewSummaryJson,
      filtered_csv: filteredCsv,
      report_md: reportMd
    }
  };
  writeJson(statsJson, stats);

  const artifacts: RunArtifacts = {
    euclidQueryCsv,
    desiQueryCsv,
    crossmatchCsv,
    previewCsv,
    previewSummaryJson,
    filteredCsv,
    statsJson,
    reportMd,
    resultIndexJson,
    humanGateRequestJson: (humanGate.mode === "filter" || humanGate.mode === "filter_confirm")
      ? humanGate.requestFile
      : undefined,
    regionAdjustRequestJson: humanGate.mode === "region_adjust" ? humanGate.requestFile : undefined
  };

  writeJson(resultIndexJson, {
    run_id: runId,
    output_dir: runDir,
    crossmatch_rows: crossmatchTruncated.length,
    preview_rows: preview.length,
    desi_rows: desiRows.length,
    zero_result: crossmatchTruncated.length === 0,
    available_filter_fields: availableFilterFields,
    artifacts
  });

  writeReport(reportMd, [
    "# Run Report",
    "",
    `- run_id: ${runId}`,
    `- input_type: ${request.input.type}`,
    `- coordinate_source: ${coord.source}`,
    `- ra_deg: ${coord.ra_deg}`,
    `- dec_deg: ${coord.dec_deg}`,
    `- radius_arcsec: ${radiusArcsec}`,
    `- euclid_rows: ${euclidRows.length}`,
    `- desi_rows: ${desiRows.length}`,
    `- desi_rows_initial: ${desiRowsInitial}`,
    `- desi_retry_applied: ${desiRetryApplied ? "yes" : "no"}`,
    `- desi_retry_scale: ${desiRetryApplied ? retryScale : "n/a"}`,
    `- crossmatch_rows_total: ${crossmatched.length}`,
    `- crossmatch_rows_written: ${crossmatchTruncated.length}`,
    `- preview_file: preview_${previewRows}.csv`,
    `- preview_rows_written: ${preview.length}`,
    `- filtered_rows: ${filtered.length}`,
    `- filter_applied: ${humanGate.filter ? "yes" : "no"}`,
    `- human_gate_mode: ${humanGate.mode}`,
    `- crossmatch_csv: ${crossmatchCsv}`,
    `- preview_csv: ${previewCsv}`,
    `- preview_summary_json: ${previewSummaryJson}`,
    `- filtered_csv: ${filteredCsv}`,
    `- result_index_json: ${resultIndexJson}`,
    `- region_adjust_request: ${artifacts.regionAdjustRequestJson ?? "n/a"}`,
    `- human_filter_request: ${artifacts.humanGateRequestJson ?? "n/a"}`
  ]);

  const summary: RunSummary = {
    raDeg: coord.ra_deg,
    decDeg: coord.dec_deg,
    radiusArcsec,
    topK,
    desiHits: desiRows.length,
    crossmatchRows: crossmatchTruncated.length,
    previewRows: preview.length,
    filteredRows: filtered.length,
    availableFilterFields,
    previewSample,
    humanGateMode: humanGate.mode
  };

  return { runId, runDir, artifacts, summary };
}
