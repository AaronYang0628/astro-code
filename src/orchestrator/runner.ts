import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { extractCoord } from "./coord.js";
import { buildCandidatePoolFromEuclidOnly, crossmatchCatalogs } from "./crossmatch.js";
import { resolveHumanFilter, resolveSelectionPlan } from "./human-gate.js";
import { createRunDir, ensureDir, writeCsv, writeJson, writeReport } from "./io.js";
import { setMcpCallLogger } from "./mcp-client.js";
import { queryCatalogMcp, queryDesiByBricknamesWithDetails, queryDesiMcpWithDetails, queryDesiSeedRowsMcpWithDetails, resolveEuclidMerVisFitsPathByTile } from "./mcp.js";
import type { DesiQueryDetails } from "./mcp.js";
import { loadPlaybook } from "./playbook.js";
import { applySelectionPlan } from "./selection.js";
import type { CatalogRecord, Coord, CrossmatchRecord, Playbook, RunArtifacts, RunRequest, RunSummary } from "./types.js";

function toBrickPrefix(brickname: string): string {
  return brickname.slice(0, 3);
}

const EUCLID_MER_S3_BASE = "s3://data-and-computing/projects/CSST/shared-data/euclid/aws-mirrors/q1/MER";
const DESI_S3_BASE = "s3://data-and-computing/projects/CSST/shared-data/desi/dr10/south";
const DESI_TRACTOR_S3_BASE = "s3://data-and-computing/projects/projects/CSST/shared-data/desi/dr10/south";

function buildDesiTractorIPath(brickname: string): string {
  const p = toBrickPrefix(brickname);
  return `${DESI_TRACTOR_S3_BASE}/tractor-i/${p}/tractor-i-${brickname}.fits`;
}

function buildDesiTractorPath(brickname: string): string {
  const p = toBrickPrefix(brickname);
  return `${DESI_TRACTOR_S3_BASE}/tractor/${p}/tractor-${brickname}.fits`;
}

function buildDesiImagePath(brickname: string, band: "g" | "r" | "i" | "z"): string {
  const p = toBrickPrefix(brickname);
  return `${DESI_S3_BASE}/coadd/${p}/${brickname}/legacysurvey-${brickname}-image-${band}.fits.fz`;
}

function enrichEuclidOnlyWithDesiContext(
  rows: CatalogRecord[],
  desiRows: CatalogRecord[]
): CatalogRecord[] {
  if (rows.length === 0 || desiRows.length === 0) {
    return rows;
  }

  const byBrick = new Map<string, CatalogRecord>();
  for (const row of desiRows) {
    const brick = row.brickname?.trim();
    if (brick && !byBrick.has(brick)) {
      byBrick.set(brick, row);
    }
  }

  return rows.map((row) => {
    const brick = row.brickname?.trim();
    if (!brick) {
      return row;
    }
    const desi = byBrick.get(brick);
    if (!desi) {
      return row;
    }
    return {
      ...row,
      flux_g: row.flux_g ?? desi.flux_g,
      flux_r: row.flux_r ?? desi.flux_r,
      flux_i: row.flux_i ?? desi.flux_i,
      flux_z: row.flux_z ?? desi.flux_z,
      flux_w1: row.flux_w1 ?? desi.flux_w1,
      flux_w2: row.flux_w2 ?? desi.flux_w2,
      shape_r: row.shape_r ?? desi.shape_r,
      shape_e1: row.shape_e1 ?? desi.shape_e1,
      shape_e2: row.shape_e2 ?? desi.shape_e2,
      sersic: row.sersic ?? desi.sersic,
      ref_id: row.ref_id ?? desi.ref_id,
      release: row.release ?? desi.release,
      brick_primary: row.brick_primary ?? desi.brick_primary,
      allmask_r: row.allmask_r ?? desi.allmask_r,
      anymask_r: row.anymask_r ?? desi.anymask_r,
      fracmasked_r: row.fracmasked_r ?? desi.fracmasked_r,
      fracin_r: row.fracin_r ?? desi.fracin_r,
      fracflux_r: row.fracflux_r ?? desi.fracflux_r,
      fiberflux_r: row.fiberflux_r ?? desi.fiberflux_r,
      source_path: row.source_path ?? desi.source_path,
      source_system: row.source_system ?? desi.source_system
    };
  });
}

function isPathLike(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return value.startsWith("s3://") || value.startsWith("http://") || value.startsWith("https://") || value.startsWith("/");
}

function normalizeEuclidFitsPath(value: string | null | undefined, tileId: string | null): string | null {
  if (isPathLike(value)) {
    return value as string;
  }
  if (tileId) {
    return `${EUCLID_MER_S3_BASE}/${tileId}/VIS/EUC_MER_BGSUB-MOSAIC-VIS_TILE${tileId}-*.fits`;
  }
  return null;
}

function normalizeDesiFitsPath(value: string | null | undefined, brickname: string | null, kind: "tractor_i" | "tractor" | "g" | "r" | "i" | "z"): string | null {
  if (isPathLike(value)) {
    return value as string;
  }
  if (!brickname) {
    return null;
  }
  if (kind === "tractor_i") {
    return buildDesiTractorIPath(brickname);
  }
  if (kind === "tractor") {
    return buildDesiTractorPath(brickname);
  }
  return buildDesiImagePath(brickname, kind);
}

function normalizeCandidatePaths(rows: CrossmatchRecord[]): CrossmatchRecord[] {
  return rows.map((row) => {
    const tileId = typeof row.tile_id === "string" && row.tile_id.trim().length > 0
      ? row.tile_id
      : (typeof row.tile_index === "string" && row.tile_index.trim().length > 0 ? row.tile_index : null);
    const brickname = typeof row.brickname === "string" && row.brickname.trim().length > 0
      ? row.brickname
      : null;

    const euclidFits = normalizeEuclidFitsPath(
      typeof row.euclid_fits_path === "string" ? row.euclid_fits_path : null,
      tileId
    );

    const tractorIFits = normalizeDesiFitsPath(
      typeof row.desi_tractor_i_fits_path === "string" ? row.desi_tractor_i_fits_path : null,
      brickname,
      "tractor_i"
    );
    const tractor = normalizeDesiFitsPath(
      typeof row.desi_tractor_fits_path === "string" ? row.desi_tractor_fits_path : null,
      brickname,
      "tractor"
    );
    const g = normalizeDesiFitsPath(typeof row.desi_image_g_path === "string" ? row.desi_image_g_path : null, brickname, "g");
    const r = normalizeDesiFitsPath(typeof row.desi_image_r_path === "string" ? row.desi_image_r_path : null, brickname, "r");
    const i = normalizeDesiFitsPath(typeof row.desi_image_i_path === "string" ? row.desi_image_i_path : null, brickname, "i");
    const z = normalizeDesiFitsPath(typeof row.desi_image_z_path === "string" ? row.desi_image_z_path : null, brickname, "z");

    return {
      ...row,
      euclid_fits_path: euclidFits,
      euclid_vis_path_pattern: typeof row.euclid_vis_path_pattern === "string" && row.euclid_vis_path_pattern.trim().length > 0
        ? row.euclid_vis_path_pattern
        : euclidFits,
      euclid_path_source: null,
      desi_tractor_i_fits_path: tractorIFits,
      desi_tractor_fits_path: tractor,
      desi_image_g_path: g,
      desi_image_r_path: r,
      desi_image_i_path: i,
      desi_image_z_path: z
    };
  });
}

function appendMissingReason(base: string, reason: string): string {
  const existing = base
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== "none");
  if (!existing.includes(reason)) {
    existing.push(reason);
  }
  return existing.length > 0 ? existing.join(";") : "none";
}

async function hydrateEuclidFitsPaths(rows: CrossmatchRecord[]): Promise<CrossmatchRecord[]> {
  const uniqueTileIds = [...new Set(rows
    .map((row) => {
      if (typeof row.tile_id === "string" && row.tile_id.trim().length > 0) {
        return row.tile_id.trim();
      }
      if (typeof row.tile_index === "string" && row.tile_index.trim().length > 0) {
        return row.tile_index.trim();
      }
      return null;
    })
    .filter((value): value is string => value !== null))];

  if (uniqueTileIds.length === 0) {
    return rows;
  }

  const byTile = new Map<string, { path: string; source: "catalog_match" | "fallback_pattern" } | null>();
  await Promise.all(uniqueTileIds.map(async (tileId) => {
    const resolved = await resolveEuclidMerVisFitsPathByTile(tileId);
    byTile.set(tileId, resolved);
  }));

  return rows.map((row) => {
    const tileId = typeof row.tile_id === "string" && row.tile_id.trim().length > 0
      ? row.tile_id.trim()
      : (typeof row.tile_index === "string" && row.tile_index.trim().length > 0 ? row.tile_index.trim() : null);
    if (!tileId) {
      return row;
    }

    const resolved = byTile.get(tileId);
    if (!resolved) {
      return row;
    }

    const pathSource = resolved.source === "catalog_match"
      ? "euclid-catalog.list_catalogs:BGSUB-MOSAIC-VIS"
      : "euclid-catalog.list_catalogs:fallback_pattern";
    const missingReasons = resolved.source === "fallback_pattern"
      ? appendMissingReason(row.missing_reasons, "euclid_fits_path_generated_pattern")
      : row.missing_reasons;

    return {
      ...row,
      euclid_fits_path: resolved.path,
      euclid_vis_path_pattern: resolved.path,
      euclid_path_source: pathSource,
      missing_reasons: missingReasons
    };
  });
}

interface RunnerOptions {
  configPath: string;
  playbookPath: string;
  requestPath: string;
  progress?: (line: string) => void;
}

interface BrickResolveResult {
  backend?: string;
  error?: string | null;
  rows?: Array<{
    object_id: string;
    brickid: number | null;
    brickname: string | null;
    status?: string;
  }>;
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
    execution_mode: string;
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
    candidate_pool_rows?: number;
    filtered_rows?: number;
    selection_candidate_rows?: number;
    selection_rows?: number;
    t1_rows_with_missing?: number;
    mock_child_run_id?: string;
  };
  artifacts?: Record<string, string | null | undefined>;
  error?: {
    message: string;
    step: string;
  };
}

function validatePlaybook(playbook: Playbook): void {
  if (!Array.isArray(playbook.steps) || playbook.steps.length === 0) {
    throw new Error("Playbook must contain at least one step.");
  }
}

function writeRunStatus(statusPath: string, status: RunStatus): void {
  status.updated_at = new Date().toISOString();
  writeJson(statusPath, status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

function toFluxFromMagNanomaggy(mag: number): number {
  return Number((10 ** ((22.5 - mag) / 2.5)).toFixed(6));
}

function buildMockEuclidRowsForMinimum(
  sourceRows: CatalogRecord[],
  minRows: number
): CatalogRecord[] {
  if (sourceRows.length === 0 || minRows <= sourceRows.length) {
    return sourceRows;
  }

  const out: CatalogRecord[] = [...sourceRows];
  const base = sourceRows[0];
  const jitterArcsec = 0.15;
  const jitterDeg = jitterArcsec / 3600;
  const fallbackTile = process.env.DESI_MOCK_TILE_INDEX?.trim() || "102018211";

  for (let i = sourceRows.length; i < minRows; i += 1) {
    const seed = (i + 1) * 0.7548776662;
    const dx = Math.sin(seed) * jitterDeg;
    const dy = Math.cos(seed) * jitterDeg;
    out.push({
      ...base,
      object_id: `${base.object_id}_M${i + 1}`,
      obj_id: `${base.obj_id ?? base.object_id}_M${i + 1}`,
      ra_deg: base.ra_deg + dx,
      dec_deg: base.dec_deg + dy,
      tile_index: base.tile_index ?? fallbackTile,
      tile_index_source: base.tile_index ? (base.tile_index_source ?? "euclid.native_field") : "mock.tile_index_default",
      source_system: "mock_seeded"
    });
  }

  return out;
}

function toJsonLiteral(value: unknown): string {
  return JSON.stringify(value);
}

function buildArtifactPathMap(artifacts: RunArtifacts): Record<string, string | null | undefined> {
  return {
    status_json: artifacts.statusJson,
    input_manifest_json: artifacts.inputManifestJson,
    euclid_query_csv: artifacts.euclidQueryCsv,
    desi_query_csv: artifacts.desiQueryCsv,
    desi_origin_json: artifacts.desiOriginJson,
    desi_search_query_json: artifacts.desiSearchQueryJson,
    desi_search_initial_raw_json: artifacts.desiSearchInitialRawJson,
    desi_search_sample_raw_json: artifacts.desiSearchSampleRawJson,
    desi_search_retry_raw_json: artifacts.desiSearchRetryRawJson,
    desi_search_retry_sample_raw_json: artifacts.desiSearchRetrySampleRawJson,
    candidate_pool_csv: artifacts.candidatePoolCsv,
    preview_csv: artifacts.previewCsv,
    preview_summary_json: artifacts.previewSummaryJson,
    filtered_csv: artifacts.filteredCsv,
    selection_candidates_csv: artifacts.selectionCandidatesCsv,
    selection_final_csv: artifacts.selectionFinalCsv,
    selection_report_json: artifacts.selectionReportJson,
    selection_plan_request_json: artifacts.selectionPlanRequestJson,
    selection_plan_response_json: artifacts.selectionPlanResponseJson,
    stats_json: artifacts.statsJson,
    report_md: artifacts.reportMd,
    result_index_json: artifacts.resultIndexJson,
    t1_schema_report_json: artifacts.t1SchemaReportJson,
    qc_report_json: artifacts.qcReportJson,
    field_lineage_md: artifacts.fieldLineageDocMd,
    human_gate_request_json: artifacts.humanGateRequestJson,
    region_adjust_request_json: artifacts.regionAdjustRequestJson,
    mock_continue_handoff_json: artifacts.mockContinueHandoffJson
  };
}

function runPipelineViaNpm(
  requestPath: string,
  playbookPath: string,
  configPath: string,
  envPatch: Record<string, string>
): {
  runId: string;
  runDir: string;
  candidatePoolCsv: string;
  resultIndexJson: string;
} {
  const envExpr = Object.entries(envPatch)
    .map(([k, v]) => `${k}=${toJsonLiteral(v)}`)
    .join(" ");
  const cmd = `${envExpr} npm run run -- --request ${toJsonLiteral(requestPath)} --playbook ${toJsonLiteral(playbookPath)} --config ${toJsonLiteral(configPath)}`;
  const out = execSync(cmd, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  const runIdMatch = out.match(/Run complete:\s*(\S+)/);
  const runDirMatch = out.match(/Output dir:\s*(\S+)/);
  const candidatePoolMatch = out.match(/Candidate pool CSV:\s*(\S+)/);
  const resultIndexMatch = out.match(/Result index:\s*(\S+)/);

  if (!runIdMatch || !runDirMatch || !candidatePoolMatch || !resultIndexMatch) {
    throw new Error("Mock handoff pipeline run succeeded but required artifact paths were not detected from output.");
  }

  return {
    runId: runIdMatch[1],
    runDir: runDirMatch[1],
    candidatePoolCsv: candidatePoolMatch[1],
    resultIndexJson: resultIndexMatch[1]
  };
}

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function resolveDesiBricksForEuclidRows(
  euclidRows: CatalogRecord[],
  pythonBin: string,
  runDir: string
): { byObjectId: Record<string, { brickid?: number | null; brickname?: string | null }>; reportPath?: string } {
  const workerPath = path.resolve("py/workers/compute_desi_brick.py");
  if (!fs.existsSync(workerPath) || euclidRows.length === 0) {
    return { byObjectId: {} };
  }

  const inputPath = path.join(runDir, "brick_resolve_request.json");
  const reportPath = path.join(runDir, "brick_resolve_report.json");
  const req = euclidRows.map((row) => ({
    object_id: row.object_id,
    ra_deg: row.ra_deg,
    dec_deg: row.dec_deg
  }));
  writeJson(inputPath, req);

  try {
    const cmd = `${toJsonLiteral(pythonBin)} ${toJsonLiteral(workerPath)} --input-json ${toJsonLiteral(inputPath)}`;
    const out = execSync(cmd, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const parsed = JSON.parse(out) as BrickResolveResult;
    writeJson(reportPath, parsed);

    const byObjectId: Record<string, { brickid?: number | null; brickname?: string | null }> = {};
    for (const row of parsed.rows ?? []) {
      if (!row.object_id || typeof row.object_id !== "string") {
        continue;
      }
      byObjectId[row.object_id] = {
        brickid: Number.isFinite(row.brickid ?? Number.NaN) ? Number(row.brickid) : null,
        brickname: typeof row.brickname === "string" && row.brickname.trim().length > 0 ? row.brickname : null
      };
    }
    return { byObjectId, reportPath };
  } catch (error) {
    writeJson(reportPath, {
      backend: "unavailable",
      error: errorMessage(error),
      rows: []
    });
    return { byObjectId: {}, reportPath };
  }
}

function findChildArtifactPath(childResultIndex: Record<string, unknown>, key: string): string | undefined {
  const artifacts = childResultIndex.artifacts;
  if (typeof artifacts !== "object" || artifacts === null) {
    return undefined;
  }
  const record = artifacts as Record<string, unknown>;
  const snake = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const value = record[key] ?? record[snake];
  return typeof value === "string" ? value : undefined;
}

function writeMockContinueRequest(baseRequest: RunRequest, outPath: string): void {
  const nextRequest: RunRequest = {
    ...baseRequest,
    interaction: "cli",
    workflow: "euclid_desi_crossmatch"
  };
  fs.writeFileSync(outPath, JSON.stringify(nextRequest, null, 2));
}

function buildMockDesiRowsFromSeeds(
  euclidRows: CatalogRecord[],
  seedDesiRows: CatalogRecord[],
  topK: number,
  radiusArcsec: number
): CatalogRecord[] {
  if (seedDesiRows.length === 0) {
    return [];
  }

  const maxRows = Math.max(1, Math.floor(envNumber("DESI_MOCK_MAX_ROWS", topK)));
  const rows = euclidRows.slice(0, Math.min(maxRows, topK));
  const jitterArcsecDefault = Math.min(Math.max(radiusArcsec * 0.2, 0.05), 0.8);
  const jitterArcsec = Math.max(0, envNumber("DESI_MOCK_JITTER_ARCSEC", jitterArcsecDefault));
  const jitterDeg = jitterArcsec / 3600;

  return rows.map((e, index) => {
    const seedRow = seedDesiRows[index % seedDesiRows.length];
    const seed = (index + 1) * 0.61803398875 + e.ra_deg * 0.01 + e.dec_deg * 0.01;
    const dx = Math.sin(seed) * jitterDeg;
    const dy = Math.cos(seed) * jitterDeg;
    const mag = Number.isFinite(seedRow.mag) ? Number(seedRow.mag) : (Number.isFinite(e.mag) ? Number((e.mag + 0.2).toFixed(6)) : 22.5);
    const fluxR = toFluxFromMagNanomaggy(mag);
    const brickid = seedRow.brickid ?? (990000 + index);
    const brickname = seedRow.brickname ?? `mock${String(index % 10000).padStart(4, "0")}`;

    return {
      catalog: "desi",
      object_id: seedRow.object_id,
      obj_id: seedRow.obj_id ?? seedRow.object_id,
      ra_deg: e.ra_deg + dx,
      dec_deg: e.dec_deg + dy,
      mag,
      mag_proxy: Number.isFinite(seedRow.mag_proxy ?? Number.NaN) ? seedRow.mag_proxy : mag,
      type: seedRow.type ?? "REX",
      class_label: seedRow.class_label,
      brickname,
      brickid,
      maskbits: Number.isFinite(seedRow.maskbits ?? Number.NaN) ? seedRow.maskbits : 0,
      seg_area: seedRow.seg_area ?? e.seg_area,
      source_system: "mock_seeded",
      source_index: seedRow.source_index,
      source_id: seedRow.source_id,
      source_path: seedRow.source_path,
      flux_r: Number.isFinite(seedRow.flux_r ?? Number.NaN) ? seedRow.flux_r : fluxR,
      flux_g: Number.isFinite(seedRow.flux_g ?? Number.NaN) ? seedRow.flux_g : Number((fluxR * 0.85).toFixed(6)),
      flux_i: Number.isFinite(seedRow.flux_i ?? Number.NaN) ? seedRow.flux_i : Number((fluxR * 1.05).toFixed(6)),
      flux_z: Number.isFinite(seedRow.flux_z ?? Number.NaN) ? seedRow.flux_z : Number((fluxR * 1.1).toFixed(6)),
      flux_w1: seedRow.flux_w1,
      flux_w2: seedRow.flux_w2,
      shape_r: seedRow.shape_r,
      shape_e1: seedRow.shape_e1,
      shape_e2: seedRow.shape_e2,
      sersic: seedRow.sersic,
      ref_id: seedRow.ref_id,
      release: seedRow.release ?? 9999,
      brick_primary: typeof seedRow.brick_primary === "boolean" ? seedRow.brick_primary : true,
      allmask_r: Number.isFinite(seedRow.allmask_r ?? Number.NaN) ? seedRow.allmask_r : 0,
      anymask_r: Number.isFinite(seedRow.anymask_r ?? Number.NaN) ? seedRow.anymask_r : 0,
      fracmasked_r: Number.isFinite(seedRow.fracmasked_r ?? Number.NaN) ? seedRow.fracmasked_r : 0,
      fracin_r: Number.isFinite(seedRow.fracin_r ?? Number.NaN) ? seedRow.fracin_r : 1,
      fracflux_r: Number.isFinite(seedRow.fracflux_r ?? Number.NaN) ? seedRow.fracflux_r : 0,
      fiberflux_r: Number.isFinite(seedRow.fiberflux_r ?? Number.NaN) ? seedRow.fiberflux_r : Number((fluxR * 0.7).toFixed(6))
    };
  });
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
  const mcpCallLogFile = path.join(runDir, "mcp_call_log.txt");
  const progress = options.progress;

  const step = (index: number, total: number, message: string): void => {
    progress?.(`[${index}/${total}] ${message}`);
  };

  progress?.(`Run started: ${runId}`);
  progress?.(`Run dir: ${runDir}`);

  setMcpCallLogger((line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    fs.appendFileSync(mcpCallLogFile, `${stamped}\n`);
    progress?.(stamped);
  });

  const interaction = request.interaction ?? config.defaults.interaction_primary;
  const executionMode = request.execution_mode ?? "pipeline_strict";
  const workflow = (request.workflow ?? "").toString().trim().toLowerCase();
  const isEuclidSingleWorkflow = options.playbookPath.includes("euclid_cutout");
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
      execution_mode: executionMode,
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
    execution_mode: executionMode,
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
  progress?.(`Pipeline mode: ${executionMode}`);
  progress?.(`Task: input=${effectiveRequest.input.type}, interaction=${interaction}, backend=${config.runtime.interaction_backend}, radiusArcsec=${radiusArcsec}, topK=${topK}, previewRows=${previewRows}`);
  if (workflow.length > 0) {
    progress?.(`Workflow: ${workflow}`);
  }
  if (effectiveRequest.input.type === "radec_text") {
    progress?.(`Input value (RA/DEC text): ${effectiveRequest.input.value}`);
  } else {
    progress?.(`Input value (s3 uri): ${effectiveRequest.input.value}`);
  }

  step(1, 7, "Extracting coordinate from input");
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

  step(2, 7, "Preparing Euclid query");
  runStatus.current_phase = "query";
  runStatus.current_step = "query_euclid";
  writeRunStatus(statusJson, runStatus);
  progress?.(`MCP call (euclid): server=euclid-catalog|astro_k3s_mcp, tool=get_catalog_info_with_stats|get_catalog_objects|es_query, source=${coord.source}`);
  let euclidRows = await queryCatalogMcp("euclid", coord, topK);
  progress?.(`Euclid rows: ${euclidRows.length}`);
  runStatus.metrics = { ...(runStatus.metrics ?? {}), euclid_rows: euclidRows.length };
  writeRunStatus(statusJson, runStatus);

  const retryScale = Number(process.env.DESI_RETRY_SCALE ?? "20");
  step(3, 7, "Preparing DESI query");
  runStatus.current_phase = "query";
  runStatus.current_step = "query_desi";
  writeRunStatus(statusJson, runStatus);
  const mcpDir = path.join(runDir, "mcp");
  ensureDir(mcpDir);
  const desiSearchQueryJson = path.join(mcpDir, "desi_search_query.json");
  const desiSearchInitialRawJson = path.join(mcpDir, "desi_search_initial.raw.json");
  const desiSearchSampleRawJson = path.join(mcpDir, "desi_search_sample.raw.json");
  const desiOriginJson = path.join(runDir, "desi_origin.json");

  let desiDetails: DesiQueryDetails = {
    rows: [],
    hitsTotal: 0,
    queryWindow: {
      ra_min: Number.NaN,
      ra_max: Number.NaN,
      dec_min: Number.NaN,
      dec_max: Number.NaN
    },
    queryBody: {},
    rawPayload: {},
    samplePayload: {},
    sampleRows: [],
    origin: {
      source_system: "astro_k3s_mcp",
      catalog: "desi-dr10-tractor",
      backend_type: "mcp_es_index",
      storage_hint: "unknown",
      source_path: null,
      source_path_field: null,
      note: "DESI query not executed"
    }
  };
  let desiRows: CatalogRecord[] = [];
  let desiRowsInitial = 0;
  let desiHitsTotalInitial = 0;
  let desiRetryApplied = false;
  let desiMockApplied = false;
  let desiMockReason: string | null = null;
  let desiRetryRawJson: string | undefined;
  let desiRetrySampleRawJson: string | undefined;

  {
    progress?.("MCP call (desi): server=astro_k3s_mcp, tool=es_query, mode=search, catalog=desi-dr10-tractor");
    desiDetails = await queryDesiMcpWithDetails(coord, topK, { windowScale: 1 });
    desiRows = desiDetails.rows;
    desiRowsInitial = desiRows.length;
    desiHitsTotalInitial = desiDetails.hitsTotal;

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

    if (!isEuclidSingleWorkflow && desiRows.length === 0 && envFlag("DESI_MOCK_ENABLE")) {
      progress?.("DESI mock fallback: querying seed rows from ES for realistic fields");
      const seedDetails = await queryDesiSeedRowsMcpWithDetails(topK);
      const minRows = Math.max(10, Math.floor(envNumber("DESI_MOCK_MIN_CROSSMATCH_ROWS", 10)));
      euclidRows = buildMockEuclidRowsForMinimum(euclidRows, minRows);
      const mockRows = buildMockDesiRowsFromSeeds(euclidRows, seedDetails.rows, topK, radiusArcsec);
      if (mockRows.length > 0) {
        desiRows = mockRows;
        desiMockApplied = true;
        desiMockReason = `DESI_MOCK_ENABLE=true; no overlap rows; seeded from real DESI rows=${seedDetails.rows.length}; min_crossmatch_rows=${minRows}`;
        writeJson(desiOriginJson, {
          source_system: "mock",
          catalog: "desi-dr10-tractor",
          backend_type: "mock_seeded_from_real_desi",
          storage_hint: "unknown",
          source_path: null,
          source_path_field: null,
          note: desiMockReason,
          mock_config: {
            max_rows: envNumber("DESI_MOCK_MAX_ROWS", topK),
            jitter_arcsec: envNumber("DESI_MOCK_JITTER_ARCSEC", Math.min(Math.max(radiusArcsec * 0.2, 0.05), 0.8)),
            min_crossmatch_rows: minRows,
            tile_index_default: process.env.DESI_MOCK_TILE_INDEX?.trim() || "102018211"
          },
          seed_source: {
            rows: seedDetails.rows.length,
            hits_total: seedDetails.hitsTotal,
            note: "Fields cloned from real DESI ES rows; RA/DEC repositioned near Euclid for development"
          }
        });
        progress?.(`DESI mock fallback applied: rows=${desiRows.length}, euclidRows=${euclidRows.length}`);
      } else {
        progress?.("DESI mock fallback requested but no DESI seed rows available");
      }
    }
  }

  runStatus.metrics = {
    ...(runStatus.metrics ?? {}),
    desi_rows: desiRows.length,
    desi_hits_total: desiDetails.hitsTotal
  };
  writeRunStatus(statusJson, runStatus);

  step(4, 7, isEuclidSingleWorkflow ? "Building candidate pool" : "Running crossmatch");
  runStatus.current_phase = "crossmatch";
  runStatus.current_step = "crossmatch_catalogs";
  writeRunStatus(statusJson, runStatus);
  const brickResolve = isEuclidSingleWorkflow
    ? resolveDesiBricksForEuclidRows(euclidRows, config.runtime.python_bin, runDir)
    : { byObjectId: {} as Record<string, { brickid?: number | null; brickname?: string | null }>, reportPath: undefined as string | undefined };

  let crossmatched = isEuclidSingleWorkflow
    ? buildCandidatePoolFromEuclidOnly(
      euclidRows,
      {
        ra_deg: coord.ra_deg,
        dec_deg: coord.dec_deg
      },
      radiusArcsec,
      { byObjectId: brickResolve.byObjectId }
    )
    : crossmatchCatalogs(euclidRows, desiRows, radiusArcsec, {
      ra_deg: coord.ra_deg,
      dec_deg: coord.dec_deg
    });

  if (isEuclidSingleWorkflow) {
    const bricknames = [...new Set(crossmatched
      .map((row) => row.brickname)
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
    if (bricknames.length > 0) {
      progress?.(`MCP call (desi by brickname): count=${bricknames.length}`);
      const desiByBrick = await queryDesiByBricknamesWithDetails(bricknames, topK);
      desiRows = desiByBrick.rows;
      desiDetails = desiByBrick;
      desiRowsInitial = desiRows.length;
      desiHitsTotalInitial = desiDetails.hitsTotal;
      writeJson(desiSearchQueryJson, {
        catalog: "desi-dr10-tractor",
        mode: "search",
        strategy: "brickname_terms",
        bricknames,
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
      progress?.(`DESI by brickname hits: rows=${desiRows.length}, hits_total=${desiDetails.hitsTotal}`);

      const enrichedEuclidRows = enrichEuclidOnlyWithDesiContext(euclidRows, desiRows);
      const recrossmatched = buildCandidatePoolFromEuclidOnly(
        enrichedEuclidRows,
        {
          ra_deg: coord.ra_deg,
          dec_deg: coord.dec_deg
        },
        radiusArcsec,
        { byObjectId: brickResolve.byObjectId }
      );
      crossmatched = recrossmatched;
    }
  }
  const requiredT1Fields = ["obj_id", "ra", "dec", "tile_index", "brickname", "maskbits", "mag_proxy", "seg_area"] as const;
  const t1MissingCounts: Record<string, number> = {
    obj_id: 0,
    ra: 0,
    dec: 0,
    tile_index: 0,
    brickname: 0,
    maskbits: 0,
    mag_proxy: 0,
    seg_area: 0
  };

  for (const row of crossmatched) {
    if (!row.obj_id || row.obj_id.trim() === "") {
      t1MissingCounts.obj_id += 1;
    }
    if (!Number.isFinite(row.ra)) {
      t1MissingCounts.ra += 1;
    }
    if (!Number.isFinite(row.dec)) {
      t1MissingCounts.dec += 1;
    }
    if (row.tile_index === null || row.tile_index.trim() === "") {
      t1MissingCounts.tile_index += 1;
    }
    if (row.brickname === null || row.brickname.trim() === "") {
      t1MissingCounts.brickname += 1;
    }
    if (row.maskbits === null || !Number.isFinite(row.maskbits)) {
      t1MissingCounts.maskbits += 1;
    }
    if (row.mag_proxy === null || !Number.isFinite(row.mag_proxy)) {
      t1MissingCounts.mag_proxy += 1;
    }
    if (row.seg_area === null || !Number.isFinite(row.seg_area)) {
      t1MissingCounts.seg_area += 1;
    }
  }

  const euclidQueryCsv = path.join(runDir, "euclid_query.csv");
  const desiQueryCsv = path.join(runDir, "desi_query.csv");
  const candidatePoolCsv = path.join(runDir, "candidate_pool.csv");
  const previewCsv = path.join(runDir, `preview_${previewRows}.csv`);
  const previewSummaryJson = path.join(runDir, "preview_summary.json");
  const filteredCsv = path.join(runDir, "filtered.csv");

  const t1RowsWithMissing = crossmatched.filter((row) => row.missing_reasons !== "none").length;
  const fieldLineageDocMd = path.join(runDir, "field_lineage.md");
  const t1SchemaReportJson = path.join(runDir, "t1_schema_report.json");
  const qcReportJson = path.join(runDir, "qc_report.json");
  writeJson(t1SchemaReportJson, {
    run_id: runId,
    required_fields: requiredT1Fields,
    total_rows: crossmatched.length,
    rows_with_missing: t1RowsWithMissing,
    missing_counts: t1MissingCounts,
    acceptance: {
      has_missing: t1RowsWithMissing > 0,
      note: "T1 schema freeze target requires all required fields or explicit missing reasons per row."
    },
    lineage_doc: fieldLineageDocMd
  });
  writeJson(qcReportJson, {
    run_id: runId,
    stage: "t1_schema_freeze",
    t1_schema: {
      required_fields: requiredT1Fields,
      total_rows: crossmatched.length,
      rows_with_missing: t1RowsWithMissing,
      missing_counts: t1MissingCounts
    },
    enrichment: {
      brick_resolve_report: brickResolve.reportPath ?? null
    }
  });
  writeReport(fieldLineageDocMd, [
    "# Field Lineage",
    "",
    `- run_id: ${runId}`,
    "- scope: current output schema used by candidate_pool / selection / filtered",
    "",
    "## Output Fields (current strict MVP)",
    "",
    "| output field | source | rule |",
    "| --- | --- | --- |",
    "| obj_id | euclid OBJECT_ID | direct mapping |",
    "| tile_index | euclid TILE_INDEX/TILEID or s3 filename | numeric tile id extraction |",
    "| brickname | py/workers/compute_desi_brick.py | desiutil brickname from RA/DEC |",
    "| type | euclid TYPE (if exists) | missing allowed -> null |",
    "| RIGHT_ASCENSION | euclid RIGHT_ASCENSION | direct mapping |",
    "| DECLINATION | euclid DECLINATION | direct mapping |",
    "| SEMIMAJOR_AXIS | euclid SEMIMAJOR_AXIS | direct mapping |",
    "| SEGMENTATION_AREA | euclid SEGMENTATION_AREA | direct mapping |",
    "| FLUX_SEGMENTATION | euclid FLUX_SEGMENTATION | direct mapping |",
    "| FLUX_VIS_1FWHM_APER..FLUX_VIS_4FWHM_APER | euclid FLUX_VIS_* | direct mapping |",
    "| euclid_fits_path | euclid-catalog.list_catalogs | prefer BGSUB-MOSAIC-VIS under tile VIS dir |",
    "| euclid_path_source | derived | `euclid-catalog.list_catalogs:BGSUB-MOSAIC-VIS` or `euclid-catalog.list_catalogs:fallback_pattern` |",
    "| desi_tractor_i_fits_path | derived from brickname | s3://.../tractor-i/<pre>/tractor-i-<brick>.fits |",
    "| desi_tractor_fits_path | derived from brickname | s3://.../tractor/<pre>/tractor-<brick>.fits |",
    "| desi_image_g/r/i/z_path | derived from brickname | s3://.../coadd/<pre>/<brick>/legacysurvey-<brick>-image-<band>.fits.fz |",
    "| path_source | derived | `derived` (or `mock` when DESI mock is enabled) |",
    "| missing_reasons | derived | semicolon-joined missing reason tags |",
    "",
    "## Fallback Behavior",
    "",
    "- If euclid-catalog list_catalogs has no BGSUB-MOSAIC-VIS match, euclid_fits_path is generated as TILE pattern with wildcard.",
    "- In fallback pattern case, `euclid_path_source=euclid-catalog.list_catalogs:fallback_pattern` and `missing_reasons` includes `euclid_fits_path_generated_pattern`.",
    "",
    "## Runtime Evidence Files",
    "",
    `- Euclid rows snapshot: ${euclidQueryCsv}`,
    `- DESI rows snapshot: ${desiQueryCsv}`,
    `- T1 schema report: ${t1SchemaReportJson}`,
    `- QC report: ${qcReportJson}`,
    `- Brick resolve report: ${brickResolve.reportPath ?? "n/a"}`
  ]);

  let crossmatchTruncated = normalizeCandidatePaths(crossmatched.slice(0, maxResultRows));
  crossmatchTruncated = await hydrateEuclidFitsPaths(crossmatchTruncated);
  const preview = crossmatchTruncated.slice(0, previewRows);
  const previewSample = preview.slice(0, 10) as unknown as Record<string, unknown>[];
  const outputColumns = [
    "obj_id",
    "tile_index",
    "brickname",
    "type",
    "RIGHT_ASCENSION",
    "DECLINATION",
    "SEMIMAJOR_AXIS",
    "SEGMENTATION_AREA",
    "FLUX_SEGMENTATION",
    "FLUX_VIS_1FWHM_APER",
    "FLUX_VIS_2FWHM_APER",
    "FLUX_VIS_3FWHM_APER",
    "FLUX_VIS_4FWHM_APER",
    "path_source",
    "missing_reasons",
    "euclid_path_source",
    "euclid_fits_path",
    "desi_tractor_fits_path",
    "desi_tractor_i_fits_path",
    "desi_image_g_path",
    "desi_image_r_path",
    "desi_image_i_path",
    "desi_image_z_path"
  ] as const;
  const availableFilterFields = [...outputColumns];

  writeCsv(euclidQueryCsv, euclidRows as unknown as Record<string, unknown>[]);
  writeCsv(desiQueryCsv, desiRows as unknown as Record<string, unknown>[]);
  writeCsv(candidatePoolCsv, crossmatchTruncated as unknown as Record<string, unknown>[], [...outputColumns]);
  writeCsv(previewCsv, preview as unknown as Record<string, unknown>[], [...outputColumns]);
  writeJson(previewSummaryJson, {
    run_id: runId,
    candidate_pool_rows: crossmatchTruncated.length,
    preview_rows: preview.length,
    available_filter_fields: availableFilterFields,
    preview_sample: previewSample
  });

  progress?.(`Candidate pool rows: ${crossmatchTruncated.length}`);
  progress?.(`Preview rows: ${preview.length}`);
  runStatus.metrics = {
    ...(runStatus.metrics ?? {}),
    candidate_pool_rows: crossmatchTruncated.length,
    t1_rows_with_missing: t1RowsWithMissing
  };
  runStatus.artifacts = {
    ...(runStatus.artifacts ?? {}),
    t1_schema_report_json: t1SchemaReportJson,
    qc_report_json: qcReportJson
  };
  writeRunStatus(statusJson, runStatus);

  step(5, 7, "Resolving zero-result gate");
  runStatus.current_phase = "human_gate";
  runStatus.current_step = "resolve_zero_result_gate";
  writeRunStatus(statusJson, runStatus);

  const humanGate = crossmatchTruncated.length === 0
    ? await resolveHumanFilter(
      runDir,
      interaction,
      config.runtime.interaction_backend,
      {
        runId,
        candidatePoolRows: crossmatchTruncated.length,
        desiRows: desiRows.length,
        retryApplied: desiRetryApplied,
        retryScale,
        queryCenter: {
          ra_deg: coord.ra_deg,
          dec_deg: coord.dec_deg
        },
        availableFields: availableFilterFields,
        previewSample
      }
    )
    : { mode: "none" as const };

  if (crossmatchTruncated.length > 0) {
    progress?.("Zero-result gate skipped: candidate pool has rows; proceeding to six-condition selection");
  }

  const mockContinueHandoffJson = path.join(runDir, "mock_continue_handoff.json");
  if (humanGate.mode === "mock_continue") {
    const mockRequestPath = path.join(runDir, "mock_continue_request.json");
    writeMockContinueRequest(effectiveRequest, mockRequestPath);

    progress?.("Human gate selected mock_continue: launching local mock-enabled pipeline for artifact handoff");
    const child = runPipelineViaNpm(
      mockRequestPath,
      options.playbookPath,
      options.configPath,
      {
        DESI_MOCK_ENABLE: "true",
        DESI_MOCK_MIN_CROSSMATCH_ROWS: process.env.DESI_MOCK_MIN_CROSSMATCH_ROWS ?? "10",
        DESI_MOCK_MAX_ROWS: process.env.DESI_MOCK_MAX_ROWS ?? String(topK),
        DESI_MOCK_JITTER_ARCSEC: process.env.DESI_MOCK_JITTER_ARCSEC ?? "0.2",
        DESI_MOCK_TILE_INDEX: process.env.DESI_MOCK_TILE_INDEX ?? "102018211"
      }
    );

    const childResultIndex = readJsonFile(child.resultIndexJson);
    const childPreviewSummaryPath = findChildArtifactPath(childResultIndex, "previewSummaryJson");
    const childPreviewCsvPath = findChildArtifactPath(childResultIndex, "previewCsv");
    const childFilteredCsvPath = findChildArtifactPath(childResultIndex, "filteredCsv");
    const childStatsJsonPath = findChildArtifactPath(childResultIndex, "statsJson");
    const childReportMdPath = findChildArtifactPath(childResultIndex, "reportMd");
    const childSelectionCandidatesPath = findChildArtifactPath(childResultIndex, "selectionCandidatesCsv");
    const childSelectionFinalPath = findChildArtifactPath(childResultIndex, "selectionFinalCsv");
    const childSelectionReportPath = findChildArtifactPath(childResultIndex, "selectionReportJson");
    const childSelectionPlanRequestPath = findChildArtifactPath(childResultIndex, "selectionPlanRequestJson");
    const childSelectionPlanResponsePath = findChildArtifactPath(childResultIndex, "selectionPlanResponseJson");

    const childPreviewSummary = childPreviewSummaryPath ? readJsonFile(childPreviewSummaryPath) : {};
    const childCandidatePoolRows = Number(childPreviewSummary.candidate_pool_rows ?? 0);
    const childPreviewRows = Number(childPreviewSummary.preview_rows ?? 0);
    const childAvailableFields = Array.isArray(childPreviewSummary.available_filter_fields)
      ? childPreviewSummary.available_filter_fields.map((v) => String(v))
      : [];
    const childPreviewSample = Array.isArray(childPreviewSummary.preview_sample)
      ? (childPreviewSummary.preview_sample as Record<string, unknown>[])
      : [];

    writeJson(mockContinueHandoffJson, {
      run_id: runId,
      action: "mock_continue",
      child_run_id: child.runId,
      child_run_dir: child.runDir,
      handoff_artifacts: {
        candidate_pool_csv: child.candidatePoolCsv,
        preview_summary_json: childPreviewSummaryPath ?? null,
        preview_csv: childPreviewCsvPath ?? null,
        filtered_csv: childFilteredCsvPath ?? null,
        stats_json: childStatsJsonPath ?? null,
        report_md: childReportMdPath ?? null,
        result_index_json: child.resultIndexJson
      },
      handoff_preview: {
        candidate_pool_rows: childCandidatePoolRows,
        preview_rows: childPreviewRows,
        available_filter_fields: childAvailableFields,
        preview_sample: childPreviewSample
      }
    });

    writeJson(statsJson, {
      run_id: runId,
      mode: "mock_continue_handoff",
      input_type: effectiveRequest.input.type,
      interaction,
      interaction_backend: config.runtime.interaction_backend,
      query_center: {
        ra_deg: coord.ra_deg,
        dec_deg: coord.dec_deg
      },
      child_run_id: child.runId,
      child_run_dir: child.runDir,
      child_candidate_pool_rows: childCandidatePoolRows,
      child_preview_rows: childPreviewRows,
      artifact_paths: {
        status_json: statusJson,
        input_manifest_json: inputManifestJson,
        mock_continue_handoff_json: mockContinueHandoffJson,
        child_preview_summary_json: childPreviewSummaryPath ?? null,
        child_preview_csv: childPreviewCsvPath ?? null,
        child_filtered_csv: childFilteredCsvPath ?? null,
        stats_json: statsJson,
        report_md: reportMd,
        result_index_json: resultIndexJson
      }
    });

    writeReport(reportMd, [
      "# Run Report",
      "",
      `- run_id: ${runId}`,
      "- mode: mock_continue_handoff",
      `- input_type: ${effectiveRequest.input.type}`,
      `- coordinate_source: ${coord.source}`,
      `- ra_deg: ${coord.ra_deg}`,
      `- dec_deg: ${coord.dec_deg}`,
      "- human_gate_mode: mock_continue",
      `- child_run_id: ${child.runId}`,
      `- child_run_dir: ${child.runDir}`,
      `- child_candidate_pool_csv: ${child.candidatePoolCsv}`,
      `- child_preview_summary_json: ${childPreviewSummaryPath ?? "n/a"}`,
      `- child_preview_csv: ${childPreviewCsvPath ?? "n/a"}`,
      `- child_filtered_csv: ${childFilteredCsvPath ?? "n/a"}`,
      `- child_result_index_json: ${child.resultIndexJson}`,
      `- mock_continue_handoff_json: ${mockContinueHandoffJson}`,
      `- status_json: ${statusJson}`,
      `- stats_json: ${statsJson}`,
      `- result_index_json: ${resultIndexJson}`
    ]);

    const handoffSelectionReportJson = path.join(runDir, "selection_report.json");
    writeJson(handoffSelectionReportJson, {
      run_id: runId,
      mode: "mock_continue_handoff",
      note: "Selection outputs are inherited from child run when available.",
      child_run_id: child.runId,
      child_run_dir: child.runDir,
      child_candidate_pool_rows: childCandidatePoolRows,
      child_preview_rows: childPreviewRows,
      child_selection_candidates_csv: childSelectionCandidatesPath ?? null,
      child_selection_final_csv: childSelectionFinalPath ?? null,
      child_selection_report_json: childSelectionReportPath ?? null
    });

    const handoffArtifacts: RunArtifacts = {
      statusJson,
      inputManifestJson,
      candidatePoolCsv: child.candidatePoolCsv,
      previewCsv: childPreviewCsvPath,
      previewSummaryJson: childPreviewSummaryPath,
      filteredCsv: childFilteredCsvPath,
      selectionCandidatesCsv: childSelectionCandidatesPath,
      selectionFinalCsv: childSelectionFinalPath,
      selectionReportJson: handoffSelectionReportJson,
      selectionPlanRequestJson: childSelectionPlanRequestPath,
      selectionPlanResponseJson: childSelectionPlanResponsePath,
      statsJson,
      reportMd,
      resultIndexJson,
      mockContinueHandoffJson
    };

    const handoffSummary: RunSummary = {
      mode: "pipeline",
      raDeg: coord.ra_deg,
      decDeg: coord.dec_deg,
      radiusArcsec,
      topK,
      desiHits: childCandidatePoolRows,
      candidatePoolRows: childCandidatePoolRows,
      previewRows: childPreviewRows,
      filteredRows: childCandidatePoolRows,
      availableFilterFields: childAvailableFields,
      previewSample: childPreviewSample,
      humanGateMode: "mock_continue",
      executionMode: "ts_orchestrator",
      mockChildRunId: child.runId
    };

    writeJson(resultIndexJson, {
      run_id: runId,
      output_dir: runDir,
      mode: "mock_continue_handoff",
      child_run_id: child.runId,
      child_run_dir: child.runDir,
      candidate_pool_rows: childCandidatePoolRows,
      preview_rows: childPreviewRows,
      desi_rows: childCandidatePoolRows,
      zero_result: childCandidatePoolRows === 0,
      available_filter_fields: childAvailableFields,
      preview_sample: childPreviewSample,
      human_gate_mode: "mock_continue",
      artifacts: {
        ...buildArtifactPathMap(handoffArtifacts),
        childResultIndexJson: child.resultIndexJson
      },
      handoff_artifacts: {
        mock_continue_handoff_json: mockContinueHandoffJson,
        child_result_index_json: child.resultIndexJson,
        child_candidate_pool_csv: child.candidatePoolCsv,
        child_preview_summary_json: childPreviewSummaryPath,
        child_preview_csv: childPreviewCsvPath,
        child_filtered_csv: childFilteredCsvPath
      }
    });

    runStatus.metrics = {
      ...(runStatus.metrics ?? {}),
      mock_child_run_id: child.runId
    };
    runStatus.artifacts = {
      ...(runStatus.artifacts ?? {}),
      mock_continue_handoff_json: mockContinueHandoffJson
    };
    writeRunStatus(statusJson, runStatus);

    progress?.(`Mock handoff child run: ${child.runId}`);
    progress?.(`Mock handoff artifacts: candidate_pool=${child.candidatePoolCsv}`);
    if (childPreviewSummaryPath) {
      progress?.(`Mock handoff artifacts: preview_summary=${childPreviewSummaryPath}`);
    }
    if (childPreviewCsvPath) {
      progress?.(`Mock handoff artifacts: preview=${childPreviewCsvPath}`);
    }
    progress?.(`Mock handoff metadata: ${mockContinueHandoffJson}`);

    runStatus.state = "completed";
    runStatus.current_phase = "completed";
    runStatus.current_step = "mock_continue_handoff";
    runStatus.artifacts = {
      ...(runStatus.artifacts ?? {}),
      candidate_pool_csv: child.candidatePoolCsv,
      preview_summary_json: childPreviewSummaryPath,
      preview_csv: childPreviewCsvPath,
      filtered_csv: childFilteredCsvPath,
      mock_continue_handoff_json: mockContinueHandoffJson,
      result_index_json: resultIndexJson,
      status_json: statusJson,
      report_md: reportMd,
      stats_json: statsJson
    };
    writeRunStatus(statusJson, runStatus);

    return {
      runId,
      runDir,
      artifacts: handoffArtifacts,
      summary: handoffSummary
    };
  }

  step(6, 7, "Selection and filtering");
  runStatus.current_phase = "selection";
  runStatus.current_step = "apply_selection";
  writeRunStatus(statusJson, runStatus);

  const selectionCandidatesCsv = path.join(runDir, "selection_candidates.csv");
  const selectionFinalCsv = path.join(runDir, "selection_final.csv");
  const selectionReportJson = path.join(runDir, "selection_report.json");

  const selectionGate = await resolveSelectionPlan(
    runDir,
    interaction,
    config.runtime.interaction_backend,
    {
      runId,
      candidatePoolRows: crossmatchTruncated.length,
      previewSample
    },
    effectiveRequest.selection
  );

  const selectionResult = applySelectionPlan(crossmatchTruncated, selectionGate.plan);
  writeCsv(selectionCandidatesCsv, selectionResult.candidate_rows_after_quality as unknown as Record<string, unknown>[], [...outputColumns]);
  writeCsv(selectionFinalCsv, selectionResult.selected_rows as unknown as Record<string, unknown>[], [...outputColumns]);
  writeJson(selectionReportJson, {
    run_id: runId,
    mode: selectionGate.mode,
    request_file: selectionGate.requestFile ?? null,
    response_file: selectionGate.responseFile ?? null,
    requested_conditions: selectionResult.requested_conditions,
    effective_order: selectionResult.effective_order,
    step_logs: selectionResult.steps,
    candidate_rows_after_quality: selectionResult.candidate_rows_after_quality.length,
    final_selected_rows: selectionResult.selected_rows.length
  });

  const filtered = selectionResult.selected_rows;
  writeCsv(filteredCsv, filtered as unknown as Record<string, unknown>[], [...outputColumns]);

  progress?.(`Selection mode: ${selectionGate.mode}`);
  progress?.(`Selection order: ${selectionResult.effective_order.join(" -> ") || "none"}`);
  progress?.(`Selection candidates rows: ${selectionResult.candidate_rows_after_quality.length}`);
  progress?.(`Selection final rows: ${selectionResult.selected_rows.length}`);
  progress?.(`Human gate mode: ${humanGate.mode}`);
  progress?.(`Final rows: ${filtered.length}`);
  runStatus.metrics = {
    ...(runStatus.metrics ?? {}),
    selection_candidate_rows: selectionResult.candidate_rows_after_quality.length,
    selection_rows: selectionResult.selected_rows.length,
    filtered_rows: filtered.length
  };
  runStatus.artifacts = {
    ...(runStatus.artifacts ?? {}),
    selection_plan_request_json: selectionGate.requestFile,
    selection_plan_response_json: selectionGate.responseFile,
    selection_candidates_csv: selectionCandidatesCsv,
    selection_final_csv: selectionFinalCsv,
    selection_report_json: selectionReportJson
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
    desi_mock_applied: desiMockApplied,
    desi_mock_reason: desiMockReason,
    candidate_pool_rows_total: crossmatched.length,
    candidate_pool_rows_written: crossmatchTruncated.length,
    selection_candidate_rows: selectionResult.candidate_rows_after_quality.length,
    selection_rows: selectionResult.selected_rows.length,
    filtered_rows: filtered.length,
    truncated: crossmatched.length > maxResultRows,
    human_gate_mode: humanGate.mode,
    human_gate_request_file: humanGate.requestFile ?? null,
    t1_schema: {
      required_fields: requiredT1Fields,
      rows_with_missing: t1RowsWithMissing,
      missing_counts: t1MissingCounts,
      report_json: t1SchemaReportJson
    },
    selection: {
      mode: selectionGate.mode,
      request_file: selectionGate.requestFile ?? null,
      response_file: selectionGate.responseFile ?? null,
      requested_conditions: selectionResult.requested_conditions,
      effective_order: selectionResult.effective_order,
      candidate_rows_after_quality: selectionResult.candidate_rows_after_quality.length,
      final_rows: selectionResult.selected_rows.length
    },
    filter: null,
    enrichment: {
      brick_resolve_report: brickResolve.reportPath ?? null
    },
    artifact_paths: buildArtifactPathMap({
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
      candidatePoolCsv,
      previewCsv,
      previewSummaryJson,
      filteredCsv,
      selectionCandidatesCsv,
      selectionFinalCsv,
      selectionReportJson,
      selectionPlanRequestJson: selectionGate.requestFile,
      selectionPlanResponseJson: selectionGate.responseFile,
      statsJson,
      reportMd,
      resultIndexJson,
      t1SchemaReportJson,
      qcReportJson,
      fieldLineageDocMd,
      humanGateRequestJson: undefined,
      regionAdjustRequestJson: humanGate.mode === "region_adjust" ? humanGate.requestFile : undefined
    })
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
    candidatePoolCsv,
    previewCsv,
    previewSummaryJson,
    filteredCsv,
    selectionCandidatesCsv,
    selectionFinalCsv,
    selectionReportJson,
    selectionPlanRequestJson: selectionGate.requestFile,
    selectionPlanResponseJson: selectionGate.responseFile,
    statsJson,
    reportMd,
    resultIndexJson,
    t1SchemaReportJson,
    qcReportJson,
    fieldLineageDocMd,
    humanGateRequestJson: undefined,
    regionAdjustRequestJson: humanGate.mode === "region_adjust" ? humanGate.requestFile : undefined
  };

  writeJson(resultIndexJson, {
    run_id: runId,
    output_dir: runDir,
    candidate_pool_rows: crossmatchTruncated.length,
    selection_candidate_rows: selectionResult.candidate_rows_after_quality.length,
    selection_rows: selectionResult.selected_rows.length,
    preview_rows: preview.length,
    desi_rows: desiRows.length,
    zero_result: crossmatchTruncated.length === 0,
    available_filter_fields: availableFilterFields,
    selection_mode: selectionGate.mode,
    selection_effective_order: selectionResult.effective_order,
    artifacts: buildArtifactPathMap(artifacts)
  });

  step(7, 7, "Writing final report");
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
    `- filter_note: filtering only narrows current candidate pool rows; it cannot increase row count`,
    `- desi_retry_applied: ${desiRetryApplied ? "yes" : "no"}`,
    `- desi_retry_scale: ${desiRetryApplied ? retryScale : "n/a"}`,
    `- desi_mock_applied: ${desiMockApplied ? "yes" : "no"}`,
    `- desi_mock_reason: ${desiMockReason ?? "n/a"}`,
    `- candidate_pool_rows_total: ${crossmatched.length}`,
    `- candidate_pool_rows_written: ${crossmatchTruncated.length}`,
    `- selection_mode: ${selectionGate.mode}`,
    `- selection_order: ${selectionResult.effective_order.join(" -> ") || "none"}`,
    `- selection_candidates_rows: ${selectionResult.candidate_rows_after_quality.length}`,
    `- selection_final_rows: ${selectionResult.selected_rows.length}`,
    `- preview_file: preview_${previewRows}.csv`,
    `- preview_rows_written: ${preview.length}`,
    `- final_rows: ${filtered.length}`,
    "- filter_applied: no (selection-only mode)",
    `- human_gate_mode: ${humanGate.mode}`,
    `- candidate_pool_csv: ${candidatePoolCsv}`,
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
    `- selection_candidates_csv: ${selectionCandidatesCsv}`,
    `- selection_final_csv: ${selectionFinalCsv}`,
    `- selection_report_json: ${selectionReportJson}`,
    `- selection_plan_request_json: ${selectionGate.requestFile ?? "n/a"}`,
    `- selection_plan_response_json: ${selectionGate.responseFile ?? "n/a"}`,
    `- result_index_json: ${resultIndexJson}`,
    `- input_manifest_json: ${inputManifestJson}`,
    `- t1_schema_report_json: ${t1SchemaReportJson}`,
    `- qc_report_json: ${qcReportJson}`,
    `- field_lineage_md: ${fieldLineageDocMd}`,
    `- region_adjust_request: ${artifacts.regionAdjustRequestJson ?? "n/a"}`,
    `- brick_resolve_report: ${brickResolve.reportPath ?? "n/a"}`
  ]);

  const summary: RunSummary = {
    mode: "pipeline",
    raDeg: coord.ra_deg,
    decDeg: coord.dec_deg,
    radiusArcsec,
    topK,
    desiHits: desiRows.length,
    candidatePoolRows: crossmatchTruncated.length,
    previewRows: preview.length,
    filteredRows: filtered.length,
    t1RowsWithMissing,
    availableFilterFields,
    previewSample,
    humanGateMode: humanGate.mode,
    executionMode: "ts_orchestrator"
  };

  runStatus.state = "completed";
  runStatus.current_phase = "completed";
  runStatus.current_step = "done";
    runStatus.artifacts = {
      ...buildArtifactPathMap(artifacts),
      mcp_call_log_txt: mcpCallLogFile
    };
    writeRunStatus(statusJson, runStatus);

  progress?.(`Artifacts: candidate_pool=${candidatePoolCsv}`);
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
  progress?.(`Artifacts: selection_candidates=${selectionCandidatesCsv}`);
  progress?.(`Artifacts: selection_final=${selectionFinalCsv}`);
  progress?.(`Artifacts: selection_report=${selectionReportJson}`);
  if (selectionGate.requestFile) {
    progress?.(`Artifacts: selection_plan_request=${selectionGate.requestFile}`);
  }
  if (selectionGate.responseFile) {
    progress?.(`Artifacts: selection_plan_response=${selectionGate.responseFile}`);
  }
  progress?.(`Artifacts: report=${reportMd}`);
  progress?.(`Artifacts: result_index=${resultIndexJson}`);
  progress?.(`Artifacts: t1_schema_report=${t1SchemaReportJson}`);
  progress?.(`Artifacts: qc_report=${qcReportJson}`);
  progress?.(`Artifacts: field_lineage=${fieldLineageDocMd}`);
  if (artifacts.regionAdjustRequestJson) {
    progress?.(`Artifacts: region_adjust_request=${artifacts.regionAdjustRequestJson}`);
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
  } finally {
    setMcpCallLogger(undefined);
  }
}
