import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { extractCoord } from "./coord.js";
import { crossmatchCatalogs } from "./crossmatch.js";
import { applyFilter } from "./filter.js";
import { resolveHumanFilter } from "./human-gate.js";
import { createRunDir, ensureDir, writeCsv, writeJson, writeReport } from "./io.js";
import { queryCatalogMcp, queryDesiMcpWithDetails } from "./mcp.js";
import { loadPlaybook } from "./playbook.js";
import type { Coord, Playbook, RunRequest } from "./types.js";

interface RunnerOptions {
  configPath: string;
  playbookPath: string;
  requestPath: string;
  progress?: (line: string) => void;
}

interface RunArtifacts {
  statusJson: string;
  inputManifestJson: string;
  euclidQueryCsv?: string;
  desiQueryCsv?: string;
  desiOriginJson?: string;
  desiSearchQueryJson?: string;
  desiSearchInitialRawJson?: string;
  desiSearchSampleRawJson?: string;
  desiSearchRetryRawJson?: string;
  desiSearchRetrySampleRawJson?: string;
  crossmatchCsv?: string;
  previewCsv?: string;
  previewSummaryJson?: string;
  filteredCsv?: string;
  statsJson: string;
  reportMd: string;
  resultIndexJson: string;
  humanGateRequestJson?: string;
  regionAdjustRequestJson?: string;
}

interface RunSummary {
  mode: "pipeline";
  raDeg?: number;
  decDeg?: number;
  radiusArcsec?: number;
  topK?: number;
  desiHits?: number;
  crossmatchRows?: number;
  previewRows?: number;
  filteredRows?: number;
  availableFilterFields?: string[];
  previewSample?: Record<string, unknown>[];
  humanGateMode?: "filter" | "filter_confirm" | "region_adjust" | "none";
  executionMode: "ts_orchestrator";
}

interface RunStatus {
  run_id: string;
  state: "running" | "completed" | "failed";
  execution_mode: "ts_orchestrator";
  started_at: string;
  updated_at: string;
  current_phase: string;
  current_step: string;
  request: {
    input_type: string;
    input_value: string;
    interaction: string;
    interaction_backend: string;
    radius_arcsec: number;
    top_k: number;
    preview_rows: number;
  };
  metrics?: {
    euclid_rows?: number;
    desi_rows?: number;
    desi_hits_total?: number;
    crossmatch_rows?: number;
    filtered_rows?: number;
  };
  artifacts?: Record<string, string | null | undefined>;
  error?: {
    message: string;
    step: string;
  };
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

function writeRunStatus(statusPath: string, status: RunStatus): void {
  status.updated_at = new Date().toISOString();
  writeJson(statusPath, status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runMvpPipeline(options: RunnerOptions): Promise<{ runId: string; runDir: string; artifacts: RunArtifacts; summary: RunSummary }> {
  const config = loadConfig(options.configPath);
  const requestPath = path.resolve(options.requestPath);
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8")) as RunRequest;
  const playbook = loadPlaybook(path.resolve(options.playbookPath));

  if (config.runtime.strict_playbook_validation) {
    validatePlaybook(playbook);
  }

  ensureDir(config.paths.runs_dir);
  const { runId, runDir } = createRunDir(config.paths.runs_dir);
  const statusJson = path.join(runDir, "status.json");
  const progress = options.progress;

  const step = (index: number, total: number, message: string): void => {
    progress?.(`[${index}/${total}] ${message}`);
  };

  progress?.(`Run started: ${runId}`);
  progress?.(`Run dir: ${runDir}`);

  const interaction = request.interaction ?? config.defaults.interaction_primary;
  const radiusArcsec = request.radiusArcsec ?? playbook.defaults?.radius_arcsec ?? config.defaults.default_radius_arcsec;
  const topK = request.topK ?? playbook.defaults?.top_k ?? config.defaults.top_k;
  const previewRows = request.previewRows ?? playbook.defaults?.preview_rows ?? config.defaults.preview_rows;
  const maxResultRows = config.defaults.max_result_rows;

  const runStatus: RunStatus = {
    run_id: runId,
    state: "running",
    execution_mode: "ts_orchestrator",
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    current_phase: "init",
    current_step: "prepare_run",
    request: {
      input_type: request.input.type,
      input_value: request.input.value,
      interaction,
      interaction_backend: config.runtime.interaction_backend,
      radius_arcsec: radiusArcsec,
      top_k: topK,
      preview_rows: previewRows
    }
  };
  writeRunStatus(statusJson, runStatus);

  try {
    if (request.input.type !== "radec_text" && request.input.type !== "s3_uri") {
      throw new Error(`Input type ${String(request.input.type)} is disabled by policy. Supported input types: radec_text, s3_uri.`);
    }

    const inputManifestJson = path.join(runDir, "input_manifest.json");
    const effectiveRequest: RunRequest = request;

    writeJson(inputManifestJson, {
      run_id: runId,
      request_path: requestPath,
      input_type: request.input.type,
      input_original_value: request.input.value,
      input_effective_value: effectiveRequest.input.value
    });

  runStatus.current_phase = "prepare";
  runStatus.current_step = "resolve_request";
  runStatus.request = {
    input_type: effectiveRequest.input.type,
    input_value: effectiveRequest.input.value,
    interaction,
    interaction_backend: config.runtime.interaction_backend,
    radius_arcsec: radiusArcsec,
    top_k: topK,
    preview_rows: previewRows
  };
  writeRunStatus(statusJson, runStatus);

  const statsJson = path.join(runDir, "stats.json");
  const reportMd = path.join(runDir, "report.md");
  const resultIndexJson = path.join(runDir, "result_index.json");

  progress?.("Execution mode: ts_orchestrator (single pipeline for web/cli)");
  progress?.(`Task: input=${effectiveRequest.input.type}, interaction=${interaction}, backend=${config.runtime.interaction_backend}, radiusArcsec=${radiusArcsec}, topK=${topK}, previewRows=${previewRows}`);
  if (effectiveRequest.input.type === "radec_text") {
    progress?.(`Input value (RA/DEC text): ${effectiveRequest.input.value}`);
  } else {
    progress?.(`Input value (s3 uri): ${effectiveRequest.input.value}`);
  }

  step(1, 6, "Extracting coordinate from input");
  runStatus.current_phase = "extract_coord";
  runStatus.current_step = "extract_coordinate";
  writeRunStatus(statusJson, runStatus);
  let coord: Coord;
  try {
    coord = await extractCoord(effectiveRequest.input, config.runtime.python_bin);
    progress?.(`Coordinate extraction success: source=${coord.source}, RA=${coord.ra_deg}, DEC=${coord.dec_deg}`);
  } catch (error) {
    progress?.(`Coordinate extraction failed: ${errorMessage(error)}`);
    throw error;
  }

  progress?.(`Matching params: RA=${coord.ra_deg}, DEC=${coord.dec_deg}, radiusArcsec=${radiusArcsec}, topK=${topK}`);

  step(2, 6, "Preparing Euclid query");
  runStatus.current_phase = "query";
  runStatus.current_step = "query_euclid";
  writeRunStatus(statusJson, runStatus);
  progress?.(`MCP call (euclid): server=euclid-catalog|astro_k3s_mcp, tool=get_catalog_info_with_stats|get_catalog_objects|es_query, source=${coord.source}`);
  const euclidRows = await queryCatalogMcp("euclid", coord, topK);
  progress?.(`Euclid rows: ${euclidRows.length}`);
  runStatus.metrics = { ...(runStatus.metrics ?? {}), euclid_rows: euclidRows.length };
  writeRunStatus(statusJson, runStatus);

  const retryScale = Number(process.env.DESI_RETRY_SCALE ?? "20");
  step(3, 6, "Preparing DESI query");
  runStatus.current_phase = "query";
  runStatus.current_step = "query_desi";
  writeRunStatus(statusJson, runStatus);
  progress?.("MCP call (desi): server=astro_k3s_mcp, tool=es_query, mode=search, catalog=desi-dr10-tractor");
  const mcpDir = path.join(runDir, "mcp");
  ensureDir(mcpDir);
  const desiSearchQueryJson = path.join(mcpDir, "desi_search_query.json");
  const desiSearchInitialRawJson = path.join(mcpDir, "desi_search_initial.raw.json");
  const desiSearchSampleRawJson = path.join(mcpDir, "desi_search_sample.raw.json");
  const desiOriginJson = path.join(runDir, "desi_origin.json");

  let desiDetails = await queryDesiMcpWithDetails(coord, topK, { windowScale: 1 });
  let desiRows = desiDetails.rows;
  const desiRowsInitial = desiRows.length;
  const desiHitsTotalInitial = desiDetails.hitsTotal;
  let desiRetryApplied = false;
  let desiRetryRawJson: string | undefined;
  let desiRetrySampleRawJson: string | undefined;

  writeJson(desiSearchQueryJson, {
    catalog: "desi-dr10-tractor",
    mode: "search",
    window: desiDetails.queryWindow,
    query_body: desiDetails.queryBody,
    top_k: topK,
    query_center: {
      ra_deg: coord.ra_deg,
      dec_deg: coord.dec_deg
    }
  });
  writeJson(desiSearchInitialRawJson, desiDetails.rawPayload);
  writeJson(desiSearchSampleRawJson, desiDetails.samplePayload);
  writeJson(desiOriginJson, desiDetails.origin);

  progress?.(`DESI hits (initial): rows=${desiRowsInitial}, hits_total=${desiHitsTotalInitial}`);
  progress?.(`DESI raw response (initial): ${desiSearchInitialRawJson}`);
  progress?.(`DESI sample response (size=3): ${desiSearchSampleRawJson}`);
  progress?.(`DESI source metadata: ${desiOriginJson}`);
  progress?.(`DESI source hint: storage=${desiDetails.origin.storage_hint}, source_path=${desiDetails.origin.source_path ?? "n/a"}`);

  if (desiRows.length === 0 && Number.isFinite(retryScale) && retryScale > 1) {
    progress?.(`DESI retry: enabled, scale=${retryScale}`);
    desiDetails = await queryDesiMcpWithDetails(coord, topK, { windowScale: retryScale });
    desiRows = desiDetails.rows;
    desiRetryRawJson = path.join(mcpDir, "desi_search_retry.raw.json");
    desiRetrySampleRawJson = path.join(mcpDir, "desi_search_retry_sample.raw.json");
    writeJson(desiRetryRawJson, desiDetails.rawPayload);
    writeJson(desiRetrySampleRawJson, desiDetails.samplePayload);
    writeJson(desiOriginJson, desiDetails.origin);
    desiRetryApplied = true;
    progress?.(`DESI hits (retry): rows=${desiRows.length}, hits_total=${desiDetails.hitsTotal}`);
    progress?.(`DESI raw response (retry): ${desiRetryRawJson}`);
    progress?.(`DESI sample response (retry,size=3): ${desiRetrySampleRawJson}`);
  }
  runStatus.metrics = {
    ...(runStatus.metrics ?? {}),
    desi_rows: desiRows.length,
    desi_hits_total: desiDetails.hitsTotal
  };
  writeRunStatus(statusJson, runStatus);

  step(4, 6, "Running crossmatch");
  runStatus.current_phase = "crossmatch";
  runStatus.current_step = "crossmatch_catalogs";
  writeRunStatus(statusJson, runStatus);
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

  progress?.(`Crossmatch rows: ${crossmatchTruncated.length}`);
  progress?.(`Preview rows: ${preview.length}`);
  runStatus.metrics = {
    ...(runStatus.metrics ?? {}),
    crossmatch_rows: crossmatchTruncated.length
  };
  writeRunStatus(statusJson, runStatus);

  step(5, 6, "Resolving human gate");
  runStatus.current_phase = "human_gate";
  runStatus.current_step = "resolve_filter_gate";
  writeRunStatus(statusJson, runStatus);

  const humanGate = await resolveHumanFilter(
    runDir,
    interaction,
    config.runtime.interaction_backend,
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
    effectiveRequest.filter
  );
  const filtered = applyFilter(crossmatchTruncated, humanGate.filter);
  writeCsv(filteredCsv, filtered as unknown as Record<string, unknown>[]);

  progress?.(`Human gate mode: ${humanGate.mode}`);
  progress?.(`Filtered rows: ${filtered.length}`);
  runStatus.metrics = {
    ...(runStatus.metrics ?? {}),
    filtered_rows: filtered.length
  };
  writeRunStatus(statusJson, runStatus);

  const stats = {
    run_id: runId,
    input_type: effectiveRequest.input.type,
    interaction,
    interaction_backend: config.runtime.interaction_backend,
    radius_arcsec: radiusArcsec,
    top_k: topK,
    preview_rows: previewRows,
    euclid_rows: euclidRows.length,
    desi_rows: desiRows.length,
    desi_hits_total: desiDetails.hitsTotal,
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
      status_json: statusJson,
      input_manifest_json: inputManifestJson,
      euclid_query_csv: euclidQueryCsv,
      desi_query_csv: desiQueryCsv,
      desi_origin_json: desiOriginJson,
      desi_search_query_json: desiSearchQueryJson,
      desi_search_initial_raw_json: desiSearchInitialRawJson,
      desi_search_sample_raw_json: desiSearchSampleRawJson,
      desi_search_retry_raw_json: desiRetryRawJson ?? null,
      desi_search_retry_sample_raw_json: desiRetrySampleRawJson ?? null,
      crossmatch_csv: crossmatchCsv,
      preview_csv: previewCsv,
      preview_summary_json: previewSummaryJson,
      filtered_csv: filteredCsv,
      report_md: reportMd
    }
  };
  writeJson(statsJson, stats);

  const artifacts: RunArtifacts = {
    statusJson,
    inputManifestJson,
    euclidQueryCsv,
    desiQueryCsv,
    desiOriginJson,
    desiSearchQueryJson,
    desiSearchInitialRawJson,
    desiSearchSampleRawJson,
    desiSearchRetryRawJson: desiRetryRawJson,
    desiSearchRetrySampleRawJson: desiRetrySampleRawJson,
    crossmatchCsv,
    previewCsv,
    previewSummaryJson,
    filteredCsv,
    statsJson,
    reportMd,
    resultIndexJson,
    humanGateRequestJson: humanGate.mode !== "region_adjust" ? humanGate.requestFile : undefined,
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

  step(6, 6, "Writing final report");
  runStatus.current_phase = "finalize";
  runStatus.current_step = "write_artifacts";
  writeRunStatus(statusJson, runStatus);

  writeReport(reportMd, [
    "# Run Report",
    "",
    `- run_id: ${runId}`,
    `- input_type: ${effectiveRequest.input.type}`,
    `- coordinate_source: ${coord.source}`,
    `- ra_deg: ${coord.ra_deg}`,
    `- dec_deg: ${coord.dec_deg}`,
    `- radius_arcsec: ${radiusArcsec}`,
    `- interaction_backend: ${config.runtime.interaction_backend}`,
    `- euclid_rows: ${euclidRows.length}`,
    `- desi_rows: ${desiRows.length}`,
    `- desi_hits_total: ${desiDetails.hitsTotal}`,
    `- desi_rows_initial: ${desiRowsInitial}`,
    `- desi_source_storage_hint: ${desiDetails.origin.storage_hint}`,
    `- desi_source_path: ${desiDetails.origin.source_path ?? "n/a"}`,
    `- match_strategy: best_per_euclid (single nearest match within radius)`,
    `- filter_note: filtering only narrows current crossmatch rows; it cannot increase row count`,
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
    `- desi_origin_json: ${desiOriginJson}`,
    `- desi_search_query_json: ${desiSearchQueryJson}`,
    `- desi_search_initial_raw_json: ${desiSearchInitialRawJson}`,
    `- desi_search_sample_raw_json: ${desiSearchSampleRawJson}`,
    `- desi_search_retry_raw_json: ${desiRetryRawJson ?? "n/a"}`,
    `- desi_search_retry_sample_raw_json: ${desiRetrySampleRawJson ?? "n/a"}`,
    `- status_json: ${statusJson}`,
    `- preview_csv: ${previewCsv}`,
    `- preview_summary_json: ${previewSummaryJson}`,
    `- filtered_csv: ${filteredCsv}`,
    `- result_index_json: ${resultIndexJson}`,
    `- input_manifest_json: ${inputManifestJson}`,
    `- region_adjust_request: ${artifacts.regionAdjustRequestJson ?? "n/a"}`,
    `- human_filter_request: ${artifacts.humanGateRequestJson ?? "n/a"}`
  ]);

  const summary: RunSummary = {
    mode: "pipeline",
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
    humanGateMode: humanGate.mode,
    executionMode: "ts_orchestrator"
  };

  runStatus.state = "completed";
  runStatus.current_phase = "completed";
  runStatus.current_step = "done";
  runStatus.artifacts = {
    status_json: statusJson,
    input_manifest_json: inputManifestJson,
    desi_origin_json: desiOriginJson,
    desi_search_query_json: desiSearchQueryJson,
    desi_search_initial_raw_json: desiSearchInitialRawJson,
    desi_search_sample_raw_json: desiSearchSampleRawJson,
    desi_search_retry_raw_json: desiRetryRawJson,
    desi_search_retry_sample_raw_json: desiRetrySampleRawJson,
    crossmatch_csv: crossmatchCsv,
    preview_csv: previewCsv,
    preview_summary_json: previewSummaryJson,
    filtered_csv: filteredCsv,
    report_md: reportMd,
    result_index_json: resultIndexJson,
    region_adjust_request: artifacts.regionAdjustRequestJson,
    human_gate_request: artifacts.humanGateRequestJson
  };
  writeRunStatus(statusJson, runStatus);

  progress?.(`Artifacts: crossmatch=${crossmatchCsv}`);
  progress?.(`Artifacts: status=${statusJson}`);
  progress?.(`Artifacts: input_manifest=${inputManifestJson}`);
  progress?.(`Artifacts: desi_origin=${desiOriginJson}`);
  progress?.(`Artifacts: desi_search_query=${desiSearchQueryJson}`);
  progress?.(`Artifacts: desi_search_initial_raw=${desiSearchInitialRawJson}`);
  progress?.(`Artifacts: desi_search_sample_raw=${desiSearchSampleRawJson}`);
  if (desiRetryRawJson) {
    progress?.(`Artifacts: desi_search_retry_raw=${desiRetryRawJson}`);
  }
  if (desiRetrySampleRawJson) {
    progress?.(`Artifacts: desi_search_retry_sample_raw=${desiRetrySampleRawJson}`);
  }
  progress?.(`Artifacts: preview=${previewCsv}`);
  progress?.(`Artifacts: preview_summary=${previewSummaryJson}`);
  progress?.(`Artifacts: filtered=${filteredCsv}`);
  progress?.(`Artifacts: report=${reportMd}`);
  progress?.(`Artifacts: result_index=${resultIndexJson}`);
  if (artifacts.regionAdjustRequestJson) {
    progress?.(`Artifacts: region_adjust_request=${artifacts.regionAdjustRequestJson}`);
  }
  if (artifacts.humanGateRequestJson) {
    progress?.(`Artifacts: human_filter_request=${artifacts.humanGateRequestJson}`);
  }

    return { runId, runDir, artifacts, summary };
  } catch (error) {
    runStatus.state = "failed";
    runStatus.current_phase = "failed";
    runStatus.error = {
      message: error instanceof Error ? error.message : String(error),
      step: runStatus.current_step
    };
    writeRunStatus(statusJson, runStatus);
    throw error;
  }
}
