import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { extractCoord } from "./coord.js";
import { buildCandidatePoolFromDesiOnly, buildCandidatePoolFromEuclidOnly, crossmatchCatalogs } from "./crossmatch.js";
import { resolveHumanFilter, resolveSelectionPlan } from "./human-gate.js";
import { createRunDir, ensureDir, writeCsv, writeJson, writeReport } from "./io.js";
import { setMcpCallLogger } from "./mcp-client.js";
import { queryCatalogMcp, queryDesiMcpWithDetails, queryEuclidRowsByTileOnly, resolveDesiCatalogFromS3Path, resolveEuclidMerVisFitsPathByTile, resolveTileIdForS3Input } from "./mcp.js";
import type { DesiQueryDetails } from "./mcp.js";
import { loadPlaybook } from "./playbook.js";
import { applySelectionPlan } from "./selection.js";
import { executeGroupedCutoutViaMcp } from "./cutout.js";
import { resolveCutoutEnabled, shouldExecuteCutout } from "./cutout-gate.js";
import type { CatalogRecord, Coord, CrossmatchRecord, Playbook, RunArtifacts, RunRequest, RunSummary } from "./types.js";
import { resolveLocalEuclidTileId } from "./euclid-tiles.js";

function toBrickPrefix(brickname: string): string {
  return brickname.slice(0, 3);
}

const EUCLID_MER_S3_BASE = "s3://data-and-computing/projects/CSST/shared-data/euclid/aws-mirrors/q1/MER";
const DESI_S3_BASE = "s3://data-and-computing/projects/CSST/shared-data/desi/dr10/south";
const DESI_TRACTOR_S3_BASE = "s3://data-and-computing/projects/CSST/shared-data/desi/dr10/south";
const OUTPUT_COLUMNS = [
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

function normalizeEuclidFitsPath(
  value: string | null | undefined,
  tileId: string | null,
  pathSource: string | null
): string | null {
  if (isPathLike(value)) {
    const path = value as string;
    const fromFallback = (pathSource ?? "").includes("fallback_pattern");
    if (fromFallback && tileId) {
      return `${EUCLID_MER_S3_BASE}/${tileId}/VIS/EUC_MER_BGSUB-MOSAIC-VIS_TILE${tileId}-*.fits`;
    }
    return path;
  }
  if (tileId) {
    return `${EUCLID_MER_S3_BASE}/${tileId}/VIS/EUC_MER_BGSUB-MOSAIC-VIS_TILE${tileId}-*.fits`;
  }
  return null;
}

function normalizeDesiFitsPath(value: string | null | undefined, brickname: string | null, kind: "tractor_i" | "tractor" | "g" | "r" | "i" | "z"): string | null {
  const derived = brickname
    ? (kind === "tractor_i"
      ? buildDesiTractorIPath(brickname)
      : (kind === "tractor"
        ? buildDesiTractorPath(brickname)
        : buildDesiImagePath(brickname, kind)))
    : null;

  if (isPathLike(value)) {
    if (!brickname || !derived) {
      return value as string;
    }
    const normalized = (value as string).toLowerCase();
    const p = toBrickPrefix(brickname).toLowerCase();
    const b = brickname.toLowerCase();
    const valid = kind === "tractor_i"
      ? normalized.includes(`/tractor-i/${p}/tractor-i-${b}.fits`)
      : kind === "tractor"
        ? normalized.includes(`/tractor/${p}/tractor-${b}.fits`)
        : (normalized.includes(`/coadd/${p}/${b}/`) && normalized.includes(`-image-${kind}.fits`));
    return valid ? (value as string) : derived;
  }
  if (!derived) {
    return null;
  }
  return derived;
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
      tileId,
      typeof row.euclid_path_source === "string" ? row.euclid_path_source : null
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

function removeMissingReasonTag(value: string, tag: string): string {
  const parts = value
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v !== "none" && v !== tag);
  return parts.length > 0 ? parts.join(";") : "none";
}

function pinEuclidFitsPathToInput(rows: CrossmatchRecord[], s3Path: string): CrossmatchRecord[] {
  return rows.map((row) => ({
    ...row,
    euclid_fits_path: s3Path,
    euclid_vis_path_pattern: s3Path,
    euclid_path_source: "input.s3_uri",
    missing_reasons: removeMissingReasonTag(row.missing_reasons, "euclid_fits_path_generated_pattern")
  }));
}

function coordFromEuclidRows(rows: CatalogRecord[]): Coord | null {
  if (rows.length === 0) {
    return null;
  }

  let raMin = Number.POSITIVE_INFINITY;
  let raMax = Number.NEGATIVE_INFINITY;
  let decMin = Number.POSITIVE_INFINITY;
  let decMax = Number.NEGATIVE_INFINITY;
  let count = 0;

  for (const row of rows) {
    const ra = Number(row.ra_deg);
    const dec = Number(row.dec_deg);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
      continue;
    }
    if (ra < raMin) raMin = ra;
    if (ra > raMax) raMax = ra;
    if (dec < decMin) decMin = dec;
    if (dec > decMax) decMax = dec;
    count += 1;
  }

  if (count === 0) {
    return null;
  }

  return {
    ra_deg: (raMin + raMax) / 2,
    dec_deg: (decMin + decMax) / 2,
    ra_min: raMin,
    ra_max: raMax,
    dec_min: decMin,
    dec_max: decMax,
    num_objects: count,
    source: "astro_k3s_mcp.euclid_tile_index"
  };
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

async function hydrateEuclidFitsPathsFromCoord(rows: CrossmatchRecord[], coord: Coord): Promise<CrossmatchRecord[]> {
  const tileId = resolveLocalEuclidTileId(coord.ra_deg, coord.dec_deg);
  if (!tileId) {
    // Keep Euclid path empty when no local tile mapping covers this sky region.
    return rows;
  }

  const resolvedPath = await resolveEuclidMerVisFitsPathByTile(tileId);
  if (!resolvedPath) {
    return rows;
  }

  const pathSource = resolvedPath.source === "catalog_match"
    ? "euclid-catalog.list_catalogs:BGSUB-MOSAIC-VIS"
    : "euclid-catalog.list_catalogs:fallback_pattern";

  return rows.map((row) => {
    const missingReasons = resolvedPath.source === "fallback_pattern"
      ? appendMissingReason(row.missing_reasons, "euclid_fits_path_generated_pattern")
      : row.missing_reasons;
    return {
      ...row,
      tile_id: row.tile_id ?? tileId,
      tile_index: row.tile_index ?? tileId,
      euclid_fits_path: resolvedPath.path,
      euclid_vis_path_pattern: resolvedPath.path,
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
  state: "running" | "waiting_selection" | "completed" | "failed";
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
    cutout_groups_total?: number;
    cutout_success_rows?: number;
    cutout_failed_rows?: number;
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

function toJsonLiteral(value: unknown): string {
  return JSON.stringify(value);
}

function toMarkdownTable(rows: Record<string, unknown>[], headers: string[]): string {
  if (rows.length === 0 || headers.length === 0) {
    return "";
  }

  const headerLine = `| ${headers.join(" | ")} |`;
  const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => {
    const cells = headers.map((h) => {
      const value = row[h];
      return String(value ?? "").replaceAll("|", "\\|");
    });
    return `| ${cells.join(" | ")} |`;
  });

  return [headerLine, sepLine, ...body].join("\n");
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
    candidate_pool_internal_json: artifacts.candidatePoolInternalJson,
    preview_csv: artifacts.previewCsv,
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
    cutout_index_csv: artifacts.cutoutIndexCsv,
    cutout_report_json: artifacts.cutoutReportJson,
    cutout_raw_reports_json: artifacts.cutoutRawReportsJson,
    human_gate_request_json: artifacts.humanGateRequestJson,
    region_adjust_request_json: artifacts.regionAdjustRequestJson
  };
}

function normalizeCutoutBands(value: unknown): Array<"g" | "r" | "i" | "z"> {
  if (!Array.isArray(value) || value.length === 0) {
    return ["g", "r", "i", "z"];
  }
  const out: Array<"g" | "r" | "i" | "z"> = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = item.trim().toLowerCase();
    if (normalized === "g" || normalized === "r" || normalized === "i" || normalized === "z") {
      if (!out.includes(normalized)) {
        out.push(normalized);
      }
    }
  }
  return out.length > 0 ? out : ["g", "r", "i", "z"];
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


export async function runMvpPipeline(options: RunnerOptions): Promise<{ runId: string; runDir: string; artifacts: RunArtifacts; summary: RunSummary }> {
  const config = loadConfig(options.configPath);
  const requestPath = path.resolve(options.requestPath);
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8")) as RunRequest;
  const playbook = loadPlaybook(path.resolve(options.playbookPath));

  if (config.runtime.strict_playbook_validation) {
    validatePlaybook(playbook);
  }

  ensureDir(config.paths.runs_dir);
  const resumeRunDir = typeof request.resume_run_dir === "string" && request.resume_run_dir.trim().length > 0
    ? path.resolve(request.resume_run_dir.trim())
    : undefined;
  const resumeRunId = typeof request.resume_run_id === "string" && request.resume_run_id.trim().length > 0
    ? request.resume_run_id.trim()
    : undefined;

  let runId: string;
  let runDir: string;
  if (resumeRunDir || resumeRunId) {
    runDir = resumeRunDir
      ?? path.resolve(config.paths.runs_dir, resumeRunId as string);
    if (!fs.existsSync(runDir)) {
      throw new Error(`resume run dir not found: ${runDir}`);
    }
    const base = path.basename(runDir);
    runId = resumeRunId ?? base;
  } else {
    const created = createRunDir(config.paths.runs_dir);
    runId = created.runId;
    runDir = created.runDir;
  }
  const statusJson = path.join(runDir, "status.json");
  const mcpCallLogFile = path.join(runDir, "mcp_call_log.txt");
  const progress = options.progress;

  const playbookStepIndex = new Map<string, number>();
  playbook.steps.forEach((stepDef, idx) => {
    playbookStepIndex.set(stepDef.id, idx + 1);
  });
  const totalSteps = playbook.steps.length;

  const step = (stepId: string, goal: string, action: string): void => {
    const idx = playbookStepIndex.get(stepId) ?? 0;
    const pos = idx > 0 ? `${idx}/${totalSteps}` : `?/${totalSteps}`;
    progress?.(`STEP: ${pos} (${stepId})`);
    progress?.(`GOAL: ${goal}`);
    progress?.(`ACTION: ${action}`);
  };

  const stepResult = (message: string): void => {
    progress?.(`RESULT: ${message}`);
  };

  progress?.(`Run started: ${runId}`);
  progress?.(`Run dir: ${runDir}`);

  setMcpCallLogger((line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    fs.appendFileSync(mcpCallLogFile, `${stamped}\n`);
    progress?.(stamped);
  });

  const interaction = request.interaction ?? config.defaults.interaction_primary;
  const executionMode = request.execution_mode ?? (interaction === "web" ? "interactive_debug" : "pipeline_strict");
  const workflow = (request.workflow ?? "").toString().trim().toLowerCase();
  const isEuclidSingleWorkflow = options.playbookPath.includes("euclid_cutout");
  const isDesiSingleWorkflow = options.playbookPath.includes("desi_cutout");
  const desiCatalog = isDesiSingleWorkflow && request.input.type === "s3_uri"
    ? resolveDesiCatalogFromS3Path(request.input.value)
    : "desi-dr10-tractor";
  const s3InputBrickname = request.input.type === "s3_uri"
    ? ((request.input.value.match(/tractor-i-([0-9]{4}[pm][0-9]{3})\.fits(?:\.fz)?$/i)?.[1]
      ?? request.input.value.match(/tractor-([0-9]{4}[pm][0-9]{3})\.fits(?:\.fz)?$/i)?.[1]
      ?? null) as string | null)
    : null;
  const radiusArcsec = request.radiusArcsec ?? playbook.defaults?.radius_arcsec ?? config.defaults.default_radius_arcsec;
  const topK = request.topK ?? playbook.defaults?.top_k ?? config.defaults.top_k;
  const previewRows = request.previewRows ?? playbook.defaults?.preview_rows ?? config.defaults.preview_rows;
  const effectivePreviewRows = Math.max(10, previewRows);
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
      preview_rows: effectivePreviewRows
    }
  };
  writeRunStatus(statusJson, runStatus);

  const resumeOnlySelection = Boolean(resumeRunDir || resumeRunId);

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
    preview_rows: effectivePreviewRows
  };
  writeRunStatus(statusJson, runStatus);

  const statsJson = path.join(runDir, "stats.json");
  const reportMd = path.join(runDir, "report.md");
  const resultIndexJson = path.join(runDir, "result_index.json");

  progress?.("Execution mode: ts_orchestrator (single pipeline for web/cli)");
  progress?.(`Pipeline mode: ${executionMode}`);
  progress?.(`Task: input=${effectiveRequest.input.type}, interaction=${interaction}, backend=${config.runtime.interaction_backend}, radiusArcsec=${radiusArcsec}, topK=${topK}, previewRows=${effectivePreviewRows}`);
  if (workflow.length > 0) {
    progress?.(`Workflow: ${workflow}`);
  }

  if (resumeOnlySelection) {
    step("selection-resume", "resume existing run and continue from confirmed selection", "load candidate pool from existing artifacts and apply selection plan directly");
    const candidatePoolInternalJson = path.join(runDir, "candidate_pool.internal.json");
    const candidatePoolCsv = path.join(runDir, "candidate_pool.csv");
    const previewRowsWritten = Math.min(effectivePreviewRows, 10);
    const previewCsv = path.join(runDir, `preview_${previewRowsWritten}.csv`);
    const selectionFinalCsv = path.join(runDir, "selection_final.csv");
    const selectionReportJson = path.join(runDir, "selection_report.json");
    const cutoutIndexCsv = path.join(runDir, "cutout_index.csv");
    const cutoutReportJson = path.join(runDir, "cutout_report.json");
    const cutoutRawReportsJson = path.join(runDir, "cutout_raw_reports.json");

    if (!fs.existsSync(candidatePoolInternalJson)) {
      throw new Error(`resume requires existing candidate_pool.internal.json: ${candidatePoolInternalJson}`);
    }
    const crossmatchLoaded = JSON.parse(fs.readFileSync(candidatePoolInternalJson, "utf8")) as CrossmatchRecord[];
    const crossmatchTruncated = normalizeCandidatePaths(crossmatchLoaded);
    writeJson(candidatePoolInternalJson, crossmatchTruncated);
    writeCsv(candidatePoolCsv, crossmatchTruncated as unknown as Record<string, unknown>[], [...OUTPUT_COLUMNS]);
    const previewSample = crossmatchTruncated.slice(0, 10) as unknown as Record<string, unknown>[];
    const availableFilterFields = [...OUTPUT_COLUMNS];

    const selectionGate = await resolveSelectionPlan(
      runDir,
      interaction,
      config.runtime.interaction_backend,
      {
        runId,
        candidatePoolRows: crossmatchTruncated.length,
        previewSample
      },
      effectiveRequest.selection,
      effectiveRequest.selection_confirmed === true
    );

    if (interaction === "web" && selectionGate.mode !== "selected") {
      writeJson(selectionReportJson, {
        run_id: runId,
        mode: "waiting_user_selection",
        selection_required: true,
        request_file: selectionGate.requestFile ?? null,
        response_file: selectionGate.responseFile ?? null,
        confirmation_received: selectionGate.confirmationReceived ?? false,
        response_present: selectionGate.responsePresent ?? false,
        message: selectionGate.reason ?? "Web mode requires explicit popup confirmation before applying selection plan.",
        available_filter_fields: availableFilterFields,
        preview_sample: previewSample,
        candidate_pool_rows: crossmatchTruncated.length
      });

      const waitingArtifacts: RunArtifacts = {
        statusJson,
        inputManifestJson,
        candidatePoolCsv,
        candidatePoolInternalJson,
        previewCsv,
        selectionReportJson,
        selectionPlanRequestJson: selectionGate.requestFile,
        selectionPlanResponseJson: selectionGate.responseFile,
        statsJson,
        reportMd,
        resultIndexJson
      };

      writeJson(resultIndexJson, {
        run_id: runId,
        output_dir: runDir,
        status: "waiting_selection",
        resume_mode: true,
        selection_required: true,
        candidate_pool_rows: crossmatchTruncated.length,
        artifacts: buildArtifactPathMap(waitingArtifacts)
      });

      writeJson(statsJson, {
        run_id: runId,
        resume_mode: true,
        status: "waiting_selection",
        selection_required: true,
        candidate_pool_rows: crossmatchTruncated.length,
        artifact_paths: buildArtifactPathMap(waitingArtifacts)
      });

      runStatus.state = "waiting_selection";
      runStatus.current_phase = "selection";
      runStatus.current_step = "await_selection_plan";
      runStatus.metrics = {
        ...(runStatus.metrics ?? {}),
        selection_candidate_rows: crossmatchTruncated.length,
        selection_rows: 0,
        filtered_rows: 0
      };
      runStatus.artifacts = {
        ...buildArtifactPathMap(waitingArtifacts),
        mcp_call_log_txt: mcpCallLogFile
      };
      writeRunStatus(statusJson, runStatus);

      return {
        runId,
        runDir,
        artifacts: waitingArtifacts,
        summary: {
          mode: "pipeline",
          candidatePoolRows: crossmatchTruncated.length,
          previewRows: Math.min(crossmatchTruncated.length, previewRowsWritten),
          filteredRows: 0,
          selectionRequired: true,
          executionMode: "ts_orchestrator",
          cutoutEnabled: false,
          cutoutGroupsTotal: 0,
          cutoutSuccessRows: 0,
          cutoutFailedRows: 0,
          availableFilterFields,
          previewSample,
          humanGateMode: "none"
        }
      };
    }

    const selectionResult = applySelectionPlan(crossmatchTruncated, selectionGate.plan);
    writeCsv(selectionFinalCsv, selectionResult.selected_rows as unknown as Record<string, unknown>[], [...OUTPUT_COLUMNS]);
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
    const cutoutEnabled = resolveCutoutEnabled(effectiveRequest.cutout?.enabled, isEuclidSingleWorkflow || isDesiSingleWorkflow);
    const cutoutShouldExecute = shouldExecuteCutout(cutoutEnabled, filtered.length);
    let cutoutGroupsTotal = 0;
    let cutoutSuccessRows = 0;
    let cutoutFailedRows = 0;
    let cutoutServerName = "fits-cutout";
    let cutoutOutputPrefix: string | undefined;

    if (cutoutShouldExecute) {
      step("cutout-execute", "execute grouped FITS cutout via remote MCP", "group selection rows by source image and invoke fits-cutout MCP");
      cutoutServerName = typeof effectiveRequest.cutout?.mcp_server === "string" && effectiveRequest.cutout.mcp_server.trim().length > 0
        ? effectiveRequest.cutout.mcp_server.trim()
        : "fits-cutout";
      cutoutOutputPrefix = typeof effectiveRequest.cutout?.output_prefix === "string" && effectiveRequest.cutout.output_prefix.trim().length > 0
        ? effectiveRequest.cutout.output_prefix.trim()
        : undefined;
      const cutoutSizeDeg = Number.isFinite(Number(effectiveRequest.cutout?.size_deg))
        ? Number(effectiveRequest.cutout?.size_deg)
        : 0.008;
      const cutoutBands = normalizeCutoutBands(effectiveRequest.cutout?.desi_bands);
      const cutoutTargetBatchSize = Number.isFinite(Number(effectiveRequest.cutout?.target_batch_size))
        ? Math.max(1, Math.floor(Number(effectiveRequest.cutout?.target_batch_size)))
        : 1;
      const cutoutSummary = await executeGroupedCutoutViaMcp({
        runId,
        rows: filtered,
        serverName: cutoutServerName,
        outputPrefix: cutoutOutputPrefix,
        sizeDeg: cutoutSizeDeg,
        desiBands: cutoutBands,
        targetBatchSize: cutoutTargetBatchSize,
        progress
      });
      cutoutGroupsTotal = cutoutSummary.groups_total;
      cutoutSuccessRows = cutoutSummary.records.filter((row) => row.status === "ok").length;
      cutoutFailedRows = cutoutSummary.records.filter((row) => row.status !== "ok").length;
      writeCsv(cutoutIndexCsv, cutoutSummary.records as unknown as Record<string, unknown>[]);
      writeJson(cutoutRawReportsJson, cutoutSummary.raw_reports);
      writeJson(cutoutReportJson, {
        run_id: runId,
        requested: cutoutSummary.requested,
        server: cutoutSummary.server,
        output_prefix: cutoutOutputPrefix ?? "service_default",
        groups_total: cutoutGroupsTotal,
        targets_total: cutoutSummary.targets_total,
        groups_succeeded: cutoutSummary.groups_succeeded,
        groups_failed: cutoutSummary.groups_failed,
        success_rows: cutoutSuccessRows,
        failed_rows: cutoutFailedRows,
        index_csv: cutoutIndexCsv,
        raw_reports_json: cutoutRawReportsJson
      });
    }

    const artifacts: RunArtifacts = {
      statusJson,
      inputManifestJson,
      candidatePoolCsv,
      candidatePoolInternalJson,
      previewCsv,
      selectionFinalCsv,
      selectionReportJson,
      selectionPlanRequestJson: selectionGate.requestFile,
      selectionPlanResponseJson: selectionGate.responseFile,
      cutoutIndexCsv: cutoutShouldExecute ? cutoutIndexCsv : undefined,
      cutoutReportJson: cutoutShouldExecute ? cutoutReportJson : undefined,
      cutoutRawReportsJson: cutoutShouldExecute ? cutoutRawReportsJson : undefined,
      statsJson,
      reportMd,
      resultIndexJson
    };

    writeJson(resultIndexJson, {
      run_id: runId,
      output_dir: runDir,
      resume_mode: true,
      candidate_pool_rows: crossmatchTruncated.length,
      selection_rows: selectionResult.selected_rows.length,
      cutout_enabled: cutoutEnabled,
      cutout_groups_total: cutoutGroupsTotal,
      cutout_success_rows: cutoutSuccessRows,
      cutout_failed_rows: cutoutFailedRows,
      artifacts: buildArtifactPathMap(artifacts)
    });

    writeJson(statsJson, {
      run_id: runId,
      resume_mode: true,
      candidate_pool_rows: crossmatchTruncated.length,
      selection_rows: selectionResult.selected_rows.length,
      cutout: {
        enabled: cutoutEnabled,
        executed: cutoutShouldExecute,
        server: cutoutShouldExecute ? cutoutServerName : null,
        output_prefix: cutoutShouldExecute ? (cutoutOutputPrefix ?? "service_default") : null,
        groups_total: cutoutGroupsTotal,
        success_rows: cutoutSuccessRows,
        failed_rows: cutoutFailedRows
      },
      artifact_paths: buildArtifactPathMap(artifacts)
    });

    runStatus.state = "completed";
    runStatus.current_phase = "completed";
    runStatus.current_step = "done";
    runStatus.metrics = {
      ...(runStatus.metrics ?? {}),
      selection_rows: selectionResult.selected_rows.length,
      filtered_rows: selectionResult.selected_rows.length,
      cutout_groups_total: cutoutGroupsTotal,
      cutout_success_rows: cutoutSuccessRows,
      cutout_failed_rows: cutoutFailedRows
    };
    runStatus.artifacts = {
      ...buildArtifactPathMap(artifacts),
      mcp_call_log_txt: mcpCallLogFile
    };
    writeRunStatus(statusJson, runStatus);

    return {
      runId,
      runDir,
      artifacts,
      summary: {
        mode: "pipeline",
        candidatePoolRows: crossmatchTruncated.length,
        previewRows: Math.min(crossmatchTruncated.length, previewRowsWritten),
        filteredRows: selectionResult.selected_rows.length,
        selectionRequired: false,
        executionMode: "ts_orchestrator",
        cutoutEnabled,
        cutoutGroupsTotal,
        cutoutSuccessRows,
        cutoutFailedRows,
        availableFilterFields,
        previewSample,
        humanGateMode: "none"
      }
    };
  }

  step("input-router", "validate input source and normalize workflow routing", "read request input and map to playbook workflow");
  if (effectiveRequest.input.type === "radec_text") {
    progress?.(`Input value (RA/DEC text): ${effectiveRequest.input.value}`);
  } else {
    progress?.(`Input value (s3 uri): ${effectiveRequest.input.value}`);
  }
  stepResult(`input source accepted: ${effectiveRequest.input.type}`);

  step("coord-extractor", "extract query coordinate by input source", "for euclid s3 use tile-first route; for desi s3 use DESI ES/path route with python fallback; otherwise parse RA/DEC by source");
  runStatus.current_phase = "extract_coord";
  runStatus.current_step = "extract_coordinate";
  writeRunStatus(statusJson, runStatus);
  let coord: Coord;
  let euclidRowsSeed: CatalogRecord[] | null = null;
  const extractedTileId = effectiveRequest.input.type === "s3_uri"
    ? ((effectiveRequest.input.value.match(/TILE(\d{6,12})/i)?.[1]
      ?? effectiveRequest.input.value.match(/(?:^|[_\-/])(\d{9})(?:[_\-.]|$)/)?.[1]
      ?? null) as string | null)
    : null;
  try {
    if (isEuclidSingleWorkflow && effectiveRequest.input.type === "s3_uri") {
      const tileResolved = await resolveTileIdForS3Input(effectiveRequest.input.value);
      const tileId = tileResolved.tileId ?? extractedTileId;
      if (!tileId) {
        throw new Error("Unable to resolve tile_id from input s3 uri.");
      }
      progress?.(`MCP call (input-router): server=euclid-catalog, tool=resolve_tile_id, tile_id=${tileId}`);

      euclidRowsSeed = await queryEuclidRowsByTileOnly(tileId, topK);
      if (euclidRowsSeed.length === 0) {
        throw new Error(`No Euclid rows found for tile_id=${tileId} via astro_k3s_mcp.es_query.`);
      }
      progress?.(`MCP call (input-router): server=astro_k3s_mcp, tool=es_query, catalog=euclid-q1-mer-final, tile_id=${tileId}, rows=${euclidRowsSeed.length}`);

      const derived = coordFromEuclidRows(euclidRowsSeed);
      if (!derived) {
        throw new Error(`Euclid rows for tile_id=${tileId} do not contain valid RA/DEC.`);
      }
      coord = {
        ...derived,
        s3_path: effectiveRequest.input.value,
        source: "astro_k3s_mcp.euclid_tile_index_from_input_router"
      };
      stepResult(`coordinate extraction success: tile_id=${tileId}, source=${coord.source}, RA=${coord.ra_deg}, DEC=${coord.dec_deg}, euclid_rows=${euclidRowsSeed.length}`);
    } else {
      coord = await extractCoord(effectiveRequest.input, config.runtime.python_bin, {
        workflow,
        topK,
        desiCatalog
      });
      stepResult(`coordinate extraction success: source=${coord.source}, RA=${coord.ra_deg}, DEC=${coord.dec_deg}`);
      if (extractedTileId) {
        progress?.(`Coord note: extracted tile_id=${extractedTileId} from s3 path; MCP S3 tools are still attempted first for direct coordinate ranges before tile/index fallback.`);
      }
    }
  } catch (error) {
    stepResult(`coordinate extraction failed: ${errorMessage(error)}`);
    throw error;
  }

  progress?.(`Matching params: RA=${coord.ra_deg}, DEC=${coord.dec_deg}, radiusArcsec=${radiusArcsec}, topK=${topK}`);

  step("euclid-query", "load Euclid catalog rows for candidate construction", "query Euclid MCP with selected columns");
  runStatus.current_phase = "query";
  runStatus.current_step = "query_euclid";
  writeRunStatus(statusJson, runStatus);
  let euclidRows: CatalogRecord[];
  if (isDesiSingleWorkflow) {
    euclidRows = [];
    progress?.("MCP call (euclid): skipped by desi single workflow");
  } else if (isEuclidSingleWorkflow && effectiveRequest.input.type === "s3_uri" && euclidRowsSeed) {
    euclidRows = euclidRowsSeed;
    progress?.(`MCP call (euclid): skipped additional query; using input-router rows=${euclidRows.length}`);
  } else {
    progress?.(`MCP call (euclid): server=euclid-catalog|astro_k3s_mcp, tool=get_catalog_info_with_stats|get_catalog_objects|es_query, source=${coord.source}`);
    euclidRows = await queryCatalogMcp("euclid", coord, topK);
  }
  stepResult(`euclid rows loaded: ${euclidRows.length}`);
  runStatus.metrics = { ...(runStatus.metrics ?? {}), euclid_rows: euclidRows.length };
  writeRunStatus(statusJson, runStatus);

  const retryScale = Number(process.env.DESI_RETRY_SCALE ?? "20");
  step("desi-query", "load DESI context rows for same sky region", "query DESI MCP and optional retry window");
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
  let desiRetryRawJson: string | undefined;
  let desiRetrySampleRawJson: string | undefined;

  if (isEuclidSingleWorkflow) {
    writeJson(desiSearchQueryJson, {
      catalog: "desi-dr10-tractor",
      mode: "skipped",
      reason: "euclid_single_workflow"
    });
    writeJson(desiSearchInitialRawJson, {
      skipped: true,
      reason: "euclid_single_workflow"
    });
    writeJson(desiSearchSampleRawJson, {
      skipped: true,
      reason: "euclid_single_workflow"
    });
    writeJson(desiOriginJson, {
      source_system: "astro_k3s_mcp",
      catalog: "desi-dr10-tractor",
      backend_type: "mcp_es_index",
      storage_hint: "unknown",
      source_path: null,
      source_path_field: null,
      note: "DESI query skipped by euclid single workflow"
    });
    progress?.("MCP call (desi): skipped by euclid single workflow");
  } else {
    progress?.(`MCP call (desi): server=astro_k3s_mcp, tool=es_query, mode=search, catalog=${desiCatalog}`);
    if (isDesiSingleWorkflow && s3InputBrickname) {
      progress?.(`DESI query constraint: brickname=${s3InputBrickname.toLowerCase()}`);
    }
    desiDetails = await queryDesiMcpWithDetails(coord, topK, { windowScale: 1, catalog: desiCatalog });
    desiRows = desiDetails.rows;
    desiRowsInitial = desiRows.length;
    desiHitsTotalInitial = desiDetails.hitsTotal;

    writeJson(desiSearchQueryJson, {
      catalog: desiCatalog,
      mode: "search",
      window: desiDetails.queryWindow,
      query_body: desiDetails.queryBody,
      top_k: topK,
      query_center: {
        ra_deg: coord.ra_deg,
        dec_deg: coord.dec_deg
      },
      brickname: coord.brickname ?? s3InputBrickname ?? null
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
      desiDetails = await queryDesiMcpWithDetails(coord, topK, { windowScale: retryScale, catalog: desiCatalog });
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
  }

  runStatus.metrics = {
    ...(runStatus.metrics ?? {}),
    desi_rows: desiRows.length,
    desi_hits_total: desiDetails.hitsTotal
  };
  writeRunStatus(statusJson, runStatus);

  step(
    "crossmatch",
    isEuclidSingleWorkflow
      ? "build Euclid single-catalog candidate pool"
      : isDesiSingleWorkflow
        ? "build DESI single-catalog candidate pool"
        : "build Euclid×DESI candidate pool",
    "crossmatch and enrich with brick/path metadata"
  );
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
    : isDesiSingleWorkflow
      ? buildCandidatePoolFromDesiOnly(
        desiRows,
        {
          ra_deg: coord.ra_deg,
          dec_deg: coord.dec_deg
        },
        radiusArcsec
      )
    : crossmatchCatalogs(euclidRows, desiRows, radiusArcsec, {
      ra_deg: coord.ra_deg,
      dec_deg: coord.dec_deg
    });

  if (isEuclidSingleWorkflow) {
    const enrichedEuclidRows = enrichEuclidOnlyWithDesiContext(euclidRows, []);
    crossmatched = buildCandidatePoolFromEuclidOnly(
      enrichedEuclidRows,
      {
        ra_deg: coord.ra_deg,
        dec_deg: coord.dec_deg
      },
      radiusArcsec,
      { byObjectId: brickResolve.byObjectId }
    );
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
  const candidatePoolInternalJson = path.join(runDir, "candidate_pool.internal.json");
  const previewRowsWritten = Math.min(effectivePreviewRows, 10);
  const previewCsv = path.join(runDir, `preview_${previewRowsWritten}.csv`);

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
    "- scope: current output schema used by candidate_pool / selection",
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
    "| path_source | derived | `derived` |",
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
  if (isEuclidSingleWorkflow && effectiveRequest.input.type === "s3_uri") {
    crossmatchTruncated = pinEuclidFitsPathToInput(crossmatchTruncated, effectiveRequest.input.value);
  } else if (isDesiSingleWorkflow) {
    crossmatchTruncated = await hydrateEuclidFitsPathsFromCoord(crossmatchTruncated, coord);
  } else if (!isDesiSingleWorkflow) {
    crossmatchTruncated = await hydrateEuclidFitsPaths(crossmatchTruncated);
  }
  const preview = crossmatchTruncated.slice(0, previewRowsWritten);
  const previewSample = preview.slice(0, 10) as unknown as Record<string, unknown>[];
  const outputColumns = OUTPUT_COLUMNS;
  const availableFilterFields = [...outputColumns];
  progress?.(`Preview fields: ${availableFilterFields.join(", ")}`);

  writeCsv(euclidQueryCsv, euclidRows as unknown as Record<string, unknown>[]);
  writeCsv(desiQueryCsv, desiRows as unknown as Record<string, unknown>[]);
  writeCsv(candidatePoolCsv, crossmatchTruncated as unknown as Record<string, unknown>[], [...outputColumns]);
  writeJson(candidatePoolInternalJson, crossmatchTruncated);
  step("preview-export", "export candidate pool preview for user inspection", "write preview CSV for interactive selection");
  writeCsv(previewCsv, preview as unknown as Record<string, unknown>[], [...outputColumns]);
  progress?.(`Preview CSV written: ${previewCsv}`);
  const previewMarkdown = toMarkdownTable(previewSample, [...outputColumns]);
  if (previewMarkdown) {
    progress?.("Preview sample (markdown table, top 10):");
    progress?.(previewMarkdown);
  } else {
    progress?.("Preview sample unavailable (no rows or no displayable fields).");
  }

  stepResult(`candidate pool rows: ${crossmatchTruncated.length}; preview rows: ${preview.length}`);
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

  step("selection-plan", "decide if user selection interaction is required", "resolve zero-result gate and build selection request when needed");
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

  step("filtered-export", "apply six-condition selection and write final selection artifact", "apply selection plan and export selection_final.csv");
  runStatus.current_phase = "selection";
  runStatus.current_step = "apply_selection";
  writeRunStatus(statusJson, runStatus);

  const selectionFinalCsv = path.join(runDir, "selection_final.csv");
  const selectionReportJson = path.join(runDir, "selection_report.json");
  const cutoutIndexCsv = path.join(runDir, "cutout_index.csv");
  const cutoutReportJson = path.join(runDir, "cutout_report.json");
  const cutoutRawReportsJson = path.join(runDir, "cutout_raw_reports.json");

  const selectionGate = await resolveSelectionPlan(
    runDir,
    interaction,
    config.runtime.interaction_backend,
    {
      runId,
      candidatePoolRows: crossmatchTruncated.length,
      previewSample
    },
    effectiveRequest.selection,
    effectiveRequest.selection_confirmed === true
  );

  const selectionRequired = interaction === "web";
  if (selectionRequired && selectionGate.mode !== "selected") {
    const selectionMessage = selectionGate.reason
      ?? "Web mode requires explicit six-condition selection popup confirmation before final export.";
    writeJson(selectionReportJson, {
      run_id: runId,
      mode: "waiting_user_selection",
      selection_required: true,
      request_file: selectionGate.requestFile ?? null,
      response_file: selectionGate.responseFile ?? null,
      confirmation_received: selectionGate.confirmationReceived ?? false,
      response_present: selectionGate.responsePresent ?? false,
      message: selectionMessage,
      available_filter_fields: availableFilterFields,
      preview_sample: previewSample,
      candidate_pool_rows: crossmatchTruncated.length
    });

    const waitingArtifacts: RunArtifacts = {
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
      candidatePoolInternalJson,
      previewCsv,
      selectionReportJson,
      selectionPlanRequestJson: selectionGate.requestFile,
      selectionPlanResponseJson: selectionGate.responseFile,
      cutoutIndexCsv: undefined,
      cutoutReportJson: undefined,
      cutoutRawReportsJson: undefined,
      statsJson,
      reportMd,
      resultIndexJson,
      t1SchemaReportJson,
      qcReportJson,
      fieldLineageDocMd,
      humanGateRequestJson: undefined,
      regionAdjustRequestJson: humanGate.mode === "region_adjust" ? humanGate.requestFile : undefined
    };

    const waitingStats = {
      run_id: runId,
      input_type: effectiveRequest.input.type,
      interaction,
      interaction_backend: config.runtime.interaction_backend,
      radius_arcsec: radiusArcsec,
      top_k: topK,
      preview_rows: previewRowsWritten,
      euclid_rows: euclidRows.length,
      desi_rows: desiRows.length,
      desi_hits_total: desiDetails.hitsTotal,
      candidate_pool_rows_total: crossmatched.length,
      candidate_pool_rows_written: crossmatchTruncated.length,
      selection_required: true,
      selection_mode: "waiting_user_selection",
      human_gate_mode: humanGate.mode,
      selection_plan_request_file: selectionGate.requestFile ?? null,
      artifact_paths: buildArtifactPathMap(waitingArtifacts)
    };
    writeJson(statsJson, waitingStats);

    writeJson(resultIndexJson, {
      run_id: runId,
      output_dir: runDir,
      status: "waiting_selection",
      selection_required: true,
      candidate_pool_rows: crossmatchTruncated.length,
      preview_rows: preview.length,
      desi_rows: desiRows.length,
      available_filter_fields: availableFilterFields,
      preview_sample: previewSample,
      artifacts: buildArtifactPathMap(waitingArtifacts)
    });

    stepResult("selection required in web mode; waiting for explicit user selection confirmation and plan");
    writeReport(reportMd, [
      "# Run Report",
      "",
      `- run_id: ${runId}`,
      "- status: waiting_selection",
      `- input_type: ${effectiveRequest.input.type}`,
      `- coordinate_source: ${coord.source}`,
      `- ra_deg: ${coord.ra_deg}`,
      `- dec_deg: ${coord.dec_deg}`,
      `- candidate_pool_rows: ${crossmatchTruncated.length}`,
      `- preview_rows_written: ${preview.length}`,
      `- preview_csv: ${previewCsv}`,
      `- selection_plan_request_json: ${selectionGate.requestFile ?? "n/a"}`,
      `- candidate_pool_internal_json: ${candidatePoolInternalJson}`,
      `- selection_report_json: ${selectionReportJson}`,
      `- next_action: complete popup selection + confirmation receipt, then rerun with selection_confirmed=true`
    ]);

    runStatus.state = "waiting_selection";
    runStatus.current_phase = "selection";
    runStatus.current_step = "await_selection_plan";
    runStatus.metrics = {
      ...(runStatus.metrics ?? {}),
      selection_candidate_rows: crossmatchTruncated.length,
      selection_rows: 0,
      filtered_rows: 0
    };
    runStatus.artifacts = {
      ...buildArtifactPathMap(waitingArtifacts),
      mcp_call_log_txt: mcpCallLogFile
    };
    writeRunStatus(statusJson, runStatus);

    progress?.("Selection required (web): waiting for explicit six-condition plan.");
    progress?.(`Artifacts: candidate_pool=${candidatePoolCsv}`);
    progress?.(`Artifacts: candidate_pool_internal=${candidatePoolInternalJson}`);
    progress?.(`Artifacts: preview=${previewCsv}`);
    if (selectionGate.requestFile) {
      progress?.(`Artifacts: selection_plan_request=${selectionGate.requestFile}`);
    }
    progress?.(`Artifacts: selection_report=${selectionReportJson}`);
    progress?.(`Artifacts: result_index=${resultIndexJson}`);

    return {
      runId,
      runDir,
      artifacts: waitingArtifacts,
      summary: {
        mode: "pipeline",
        raDeg: coord.ra_deg,
        decDeg: coord.dec_deg,
        radiusArcsec,
        topK,
        desiHits: desiRows.length,
        candidatePoolRows: crossmatchTruncated.length,
        previewRows: preview.length,
        filteredRows: 0,
        selectionRequired: true,
        t1RowsWithMissing,
        availableFilterFields,
        previewSample,
        humanGateMode: humanGate.mode,
        executionMode: "ts_orchestrator"
      }
    };
  }

  const selectionResult = applySelectionPlan(crossmatchTruncated, selectionGate.plan);
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

  const cutoutEnabled = resolveCutoutEnabled(effectiveRequest.cutout?.enabled, isEuclidSingleWorkflow || isDesiSingleWorkflow);
  const cutoutShouldExecute = shouldExecuteCutout(cutoutEnabled, filtered.length);
  let cutoutGroupsTotal = 0;
  let cutoutSuccessRows = 0;
  let cutoutFailedRows = 0;
  let cutoutServerName = "fits-cutout";
  let cutoutOutputPrefix: string | undefined;

  if (cutoutShouldExecute) {
    step("cutout-execute", "execute grouped FITS cutout via remote MCP", "group selection rows by source image and invoke fits-cutout MCP");
    cutoutServerName = typeof effectiveRequest.cutout?.mcp_server === "string" && effectiveRequest.cutout.mcp_server.trim().length > 0
      ? effectiveRequest.cutout.mcp_server.trim()
      : "fits-cutout";
    cutoutOutputPrefix = typeof effectiveRequest.cutout?.output_prefix === "string" && effectiveRequest.cutout.output_prefix.trim().length > 0
      ? effectiveRequest.cutout.output_prefix.trim()
      : undefined;
    const cutoutSizeDeg = Number.isFinite(Number(effectiveRequest.cutout?.size_deg))
      ? Number(effectiveRequest.cutout?.size_deg)
      : 0.008;
    const cutoutBands = normalizeCutoutBands(effectiveRequest.cutout?.desi_bands);
    const cutoutTargetBatchSize = Number.isFinite(Number(effectiveRequest.cutout?.target_batch_size))
      ? Math.max(1, Math.floor(Number(effectiveRequest.cutout?.target_batch_size)))
      : 1;

    const cutoutSummary = await executeGroupedCutoutViaMcp({
      runId,
      rows: filtered,
      serverName: cutoutServerName,
      outputPrefix: cutoutOutputPrefix,
      sizeDeg: cutoutSizeDeg,
      desiBands: cutoutBands,
      targetBatchSize: cutoutTargetBatchSize,
      progress
    });

    cutoutGroupsTotal = cutoutSummary.groups_total;
    cutoutSuccessRows = cutoutSummary.records.filter((row) => row.status === "ok").length;
    cutoutFailedRows = cutoutSummary.records.filter((row) => row.status !== "ok").length;

    writeCsv(cutoutIndexCsv, cutoutSummary.records as unknown as Record<string, unknown>[]);
    writeJson(cutoutRawReportsJson, cutoutSummary.raw_reports);
    writeJson(cutoutReportJson, {
      run_id: runId,
      requested: cutoutSummary.requested,
      server: cutoutSummary.server,
      output_prefix: cutoutOutputPrefix ?? "service_default",
      groups_total: cutoutGroupsTotal,
      targets_total: cutoutSummary.targets_total,
      groups_succeeded: cutoutSummary.groups_succeeded,
      groups_failed: cutoutSummary.groups_failed,
      success_rows: cutoutSuccessRows,
      failed_rows: cutoutFailedRows,
      index_csv: cutoutIndexCsv,
      raw_reports_json: cutoutRawReportsJson
    });
    stepResult(`cutout complete: groups=${cutoutGroupsTotal}, success_rows=${cutoutSuccessRows}, failed_rows=${cutoutFailedRows}`);
  }

  progress?.(`Selection mode: ${selectionGate.mode}`);
  progress?.(`Selection order: ${selectionResult.effective_order.join(" -> ") || "none"}`);
  progress?.(`Selection final rows: ${selectionResult.selected_rows.length}`);
  progress?.(`Human gate mode: ${humanGate.mode}`);
  progress?.(`Final rows: ${filtered.length}`);
  runStatus.metrics = {
    ...(runStatus.metrics ?? {}),
    selection_candidate_rows: selectionResult.candidate_rows_after_quality.length,
    selection_rows: selectionResult.selected_rows.length,
    filtered_rows: filtered.length,
    cutout_groups_total: cutoutGroupsTotal,
    cutout_success_rows: cutoutSuccessRows,
    cutout_failed_rows: cutoutFailedRows
  };
  runStatus.artifacts = {
    ...(runStatus.artifacts ?? {}),
    selection_plan_request_json: selectionGate.requestFile,
    selection_plan_response_json: selectionGate.responseFile,
    selection_final_csv: selectionFinalCsv,
    selection_report_json: selectionReportJson,
    cutout_index_csv: cutoutShouldExecute ? cutoutIndexCsv : undefined,
    cutout_report_json: cutoutShouldExecute ? cutoutReportJson : undefined,
    cutout_raw_reports_json: cutoutShouldExecute ? cutoutRawReportsJson : undefined
  };
  writeRunStatus(statusJson, runStatus);

  const stats = {
    run_id: runId,
    input_type: effectiveRequest.input.type,
    interaction,
    interaction_backend: config.runtime.interaction_backend,
    radius_arcsec: radiusArcsec,
    top_k: topK,
    preview_rows: previewRowsWritten,
    euclid_rows: euclidRows.length,
    desi_rows: desiRows.length,
    desi_hits_total: desiDetails.hitsTotal,
    desi_rows_initial: desiRowsInitial,
    desi_retry_applied: desiRetryApplied,
    desi_retry_scale: desiRetryApplied ? retryScale : null,
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
    cutout: {
      enabled: cutoutEnabled,
      executed: cutoutShouldExecute,
      server: cutoutShouldExecute ? cutoutServerName : null,
      output_prefix: cutoutShouldExecute ? (cutoutOutputPrefix ?? "service_default") : null,
      groups_total: cutoutGroupsTotal,
      success_rows: cutoutSuccessRows,
      failed_rows: cutoutFailedRows,
      index_csv: cutoutShouldExecute ? cutoutIndexCsv : null,
      report_json: cutoutShouldExecute ? cutoutReportJson : null,
      raw_reports_json: cutoutShouldExecute ? cutoutRawReportsJson : null
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
      candidatePoolInternalJson,
      previewCsv,
      selectionFinalCsv,
      selectionReportJson,
      selectionPlanRequestJson: selectionGate.requestFile,
      selectionPlanResponseJson: selectionGate.responseFile,
      cutoutIndexCsv: cutoutShouldExecute ? cutoutIndexCsv : undefined,
      cutoutReportJson: cutoutShouldExecute ? cutoutReportJson : undefined,
      cutoutRawReportsJson: cutoutShouldExecute ? cutoutRawReportsJson : undefined,
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
    candidatePoolInternalJson,
    previewCsv,
    selectionFinalCsv,
    selectionReportJson,
    selectionPlanRequestJson: selectionGate.requestFile,
    selectionPlanResponseJson: selectionGate.responseFile,
    cutoutIndexCsv: cutoutShouldExecute ? cutoutIndexCsv : undefined,
    cutoutReportJson: cutoutShouldExecute ? cutoutReportJson : undefined,
    cutoutRawReportsJson: cutoutShouldExecute ? cutoutRawReportsJson : undefined,
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
    cutout_enabled: cutoutEnabled,
    cutout_groups_total: cutoutGroupsTotal,
    cutout_success_rows: cutoutSuccessRows,
    cutout_failed_rows: cutoutFailedRows,
    artifacts: buildArtifactPathMap(artifacts)
  });

  stepResult(`selection completed; final rows: ${filtered.length}`);
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
    `- candidate_pool_rows_total: ${crossmatched.length}`,
    `- candidate_pool_rows_written: ${crossmatchTruncated.length}`,
    `- selection_mode: ${selectionGate.mode}`,
    `- selection_order: ${selectionResult.effective_order.join(" -> ") || "none"}`,
    `- selection_candidates_rows: ${selectionResult.candidate_rows_after_quality.length}`,
    `- selection_final_rows: ${selectionResult.selected_rows.length}`,
    `- preview_file: preview_${previewRowsWritten}.csv`,
    `- preview_rows_written: ${preview.length}`,
    `- final_rows: ${filtered.length}`,
    `- cutout_enabled: ${cutoutEnabled ? "yes" : "no"}`,
    `- cutout_executed: ${cutoutShouldExecute ? "yes" : "no"}`,
    `- cutout_server: ${cutoutShouldExecute ? cutoutServerName : "n/a"}`,
    `- cutout_output_prefix: ${cutoutShouldExecute ? (cutoutOutputPrefix ?? "service_default") : "n/a"}`,
    `- cutout_groups_total: ${cutoutGroupsTotal}`,
    `- cutout_success_rows: ${cutoutSuccessRows}`,
    `- cutout_failed_rows: ${cutoutFailedRows}`,
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
    `- selection_final_csv: ${selectionFinalCsv}`,
    `- selection_report_json: ${selectionReportJson}`,
    `- cutout_index_csv: ${cutoutShouldExecute ? cutoutIndexCsv : "n/a"}`,
    `- cutout_report_json: ${cutoutShouldExecute ? cutoutReportJson : "n/a"}`,
    `- cutout_raw_reports_json: ${cutoutShouldExecute ? cutoutRawReportsJson : "n/a"}`,
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
    cutoutEnabled,
    cutoutGroupsTotal,
    cutoutSuccessRows,
    cutoutFailedRows,
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
  progress?.(`Artifacts: selection_final=${selectionFinalCsv}`);
  progress?.(`Artifacts: selection_report=${selectionReportJson}`);
  if (cutoutShouldExecute) {
    progress?.(`Artifacts: cutout_index=${cutoutIndexCsv}`);
    progress?.(`Artifacts: cutout_report=${cutoutReportJson}`);
    progress?.(`Artifacts: cutout_raw_reports=${cutoutRawReportsJson}`);
  }
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
