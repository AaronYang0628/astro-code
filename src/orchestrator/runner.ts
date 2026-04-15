import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { extractCoord } from "./coord.js";
import { crossmatchCatalogs } from "./crossmatch.js";
import { applyFilter } from "./filter.js";
import { resolveHumanFilter } from "./human-gate.js";
import { createRunDir, ensureDir, writeCsv, writeJson, writeReport } from "./io.js";
import { queryCatalogMcp, queryDesiMcpWithDetails, queryDesiSeedRowsMcpWithDetails } from "./mcp.js";
import { loadPlaybook } from "./playbook.js";
import type { CatalogRecord, Coord, Playbook, RunRequest } from "./types.js";

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
  t1SchemaReportJson?: string;
  qcReportJson?: string;
  fieldLineageDocMd?: string;
  imagePairIndexCsv?: string;
  mockContinueHandoffJson?: string;
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
  humanGateMode?: "filter" | "filter_confirm" | "region_adjust" | "mock_continue" | "none";
  executionMode: "ts_orchestrator";
  t1RowsWithMissing?: number;
  imagePairRows?: number;
  mockChildRunId?: string;
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
    t1_rows_with_missing?: number;
    image_pair_rows?: number;
    mock_child_run_id?: string;
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

function asNonEmpty(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const t = value.trim();
  return t.length > 0 ? t : null;
}

function buildImagePairIndexRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const euclidPath = asNonEmpty(row.euclid_vis_path_pattern);
    const desiTractorI = asNonEmpty(row.desi_tractor_i_path);
    const desiG = asNonEmpty(row.desi_image_g_path);
    const desiR = asNonEmpty(row.desi_image_r_path);
    const desiI = asNonEmpty(row.desi_image_i_path);
    const desiZ = asNonEmpty(row.desi_image_z_path);

    const tileIndex = asNonEmpty(row.tile_index);
    const brickname = asNonEmpty(row.brickname);

    const euclidFilenameQuery = tileIndex
      ? `EUC_MER_BGSUB-MOSAIC-VIS_TILE${tileIndex}-*.fits`
      : null;
    const desiFilenameTractorI = brickname
      ? `tractor-i-${brickname}.fits`
      : null;
    const desiFilenameG = brickname
      ? `legacysurvey-${brickname}-image-g.fits.fz`
      : null;
    const desiFilenameR = brickname
      ? `legacysurvey-${brickname}-image-r.fits.fz`
      : null;
    const desiFilenameI = brickname
      ? `legacysurvey-${brickname}-image-i.fits.fz`
      : null;
    const desiFilenameZ = brickname
      ? `legacysurvey-${brickname}-image-z.fits.fz`
      : null;

    return {
      obj_id: row.obj_id,
      tile_index: row.tile_index,
      brickname: row.brickname,
      ra: row.ra,
      dec: row.dec,
      type: row.type,
      path_source: row.path_source,
      lookup_mode: "filename_pattern_by_tile_brickname",
      lookup_key_tile_index: tileIndex,
      lookup_key_brickname: brickname,
      euclid_filename_query: euclidFilenameQuery,
      desi_filename_tractor_i: desiFilenameTractorI,
      desi_filename_g: desiFilenameG,
      desi_filename_r: desiFilenameR,
      desi_filename_i: desiFilenameI,
      desi_filename_z: desiFilenameZ,
      euclid_path: euclidPath,
      desi_path_tractor_i: desiTractorI,
      desi_path_g: desiG,
      desi_path_r: desiR,
      desi_path_i: desiI,
      desi_path_z: desiZ,
      availability_euclid: euclidPath ? "pattern" : "missing",
      availability_tractor_i: desiTractorI ? "derived" : "missing",
      availability_g: desiG ? "derived" : "missing",
      availability_r: desiR ? "derived" : "missing",
      availability_i: desiI ? "derived" : "missing",
      availability_z: desiZ ? "derived" : "missing"
    };
  });
}

function toJsonLiteral(value: unknown): string {
  return JSON.stringify(value);
}

function runPipelineViaNpm(
  requestPath: string,
  playbookPath: string,
  configPath: string,
  envPatch: Record<string, string>
): {
  runId: string;
  runDir: string;
  imagePairIndexCsv: string;
  crossmatchCsv: string;
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
  const imagePairMatch = out.match(/Image pair index CSV:\s*(\S+)/);
  const crossmatchMatch = out.match(/Crossmatch CSV:\s*(\S+)/);
  const resultIndexMatch = out.match(/Result index:\s*(\S+)/);

  if (!runIdMatch || !runDirMatch || !imagePairMatch || !crossmatchMatch || !resultIndexMatch) {
    throw new Error("Mock handoff pipeline run succeeded but required artifact paths were not detected from output.");
  }

  return {
    runId: runIdMatch[1],
    runDir: runDirMatch[1],
    imagePairIndexCsv: imagePairMatch[1],
    crossmatchCsv: crossmatchMatch[1],
    resultIndexJson: resultIndexMatch[1]
  };
}

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function findChildArtifactPath(childResultIndex: Record<string, unknown>, key: string): string | undefined {
  const artifacts = childResultIndex.artifacts;
  if (typeof artifacts !== "object" || artifacts === null) {
    return undefined;
  }
  const value = (artifacts as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function writeMockContinueRequest(baseRequest: RunRequest, outPath: string): void {
  const nextRequest: RunRequest = {
    ...baseRequest,
    interaction: "cli"
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
  let euclidRows = await queryCatalogMcp("euclid", coord, topK);
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
  let desiMockApplied = false;
  let desiMockReason: string | null = null;
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

  if (desiRows.length === 0 && envFlag("DESI_MOCK_ENABLE")) {
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
  const crossmatched = crossmatchCatalogs(euclidRows, desiRows, radiusArcsec, {
    ra_deg: coord.ra_deg,
    dec_deg: coord.dec_deg
  });
  const requiredT1Fields = ["obj_id", "ra", "dec", "type", "tile_index", "brickname", "maskbits", "mag_proxy", "seg_area"] as const;
  const t1MissingCounts: Record<string, number> = {
    obj_id: 0,
    ra: 0,
    dec: 0,
    type: 0,
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
    if (!row.type || row.type.trim() === "") {
      t1MissingCounts.type += 1;
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
  const crossmatchCsv = path.join(runDir, "crossmatch.csv");
  const imagePairIndexCsv = path.join(runDir, "image_pair_index.csv");
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
    }
  });
  writeReport(fieldLineageDocMd, [
    "# Field Lineage",
    "",
    `- run_id: ${runId}`,
    "- scope: T1 candidate schema and currently leveraged ES fields",
    "",
    "## Required T1 Fields",
    "",
    "| output field | source catalog | mcp server/tool | source location | source field | transform | fallback |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| obj_id | DESI preferred / Euclid fallback | astro_k3s_mcp.es_query | `data.result.hits.hits[*]._source` | `OBJECT_ID` \| `object_id` \| `_id` | direct string mapping | fallback to Euclid `OBJECT_ID` |",
    "| ra | DESI | astro_k3s_mcp.es_query | `..._source` | `ra` | numeric cast | none |",
    "| dec | DESI | astro_k3s_mcp.es_query | `..._source` | `dec` | numeric cast | none |",
    "| type | DESI preferred / Euclid fallback | astro_k3s_mcp.es_query + euclid-catalog.get_catalog_objects | `_source` / objects[] | DESI: `type`; Euclid: `TYPE`/`EXTENDED_FLAG` | normalized string | `unknown` |",
    "| tile_index | Euclid | astro_k3s_mcp.es_query / euclid-catalog.get_catalog_objects | `_source` / objects[] | `TILE_INDEX` \| `tile_index` \| `TILEID` | direct string mapping | `null` + reason `tile_index_missing` |",
    "| brickname | DESI | astro_k3s_mcp.es_query | `_source` | `brickname` | direct string mapping | `null` + reason `brickname_missing` |",
    "| maskbits | DESI preferred / Euclid fallback | astro_k3s_mcp.es_query + euclid-catalog.get_catalog_objects | `_source` / objects[] | DESI `maskbits`; Euclid `MASKBITS` | numeric cast | `null` + reason `maskbits_missing` |",
    "| mag_proxy | DESI preferred / Euclid fallback | astro_k3s_mcp.es_query + euclid-catalog.get_catalog_objects | `_source` / objects[] | DESI `flux_r`/`mag_*`; Euclid `FLUX_VIS_1FWHM_APER`/`MAG_*` | DESI: `22.5-2.5log10(flux_r)`; Euclid: `23.9-2.5log10(flux_vis_1fwhm_aper)` | `null` + reason `mag_proxy_missing` |",
    "| seg_area | Euclid preferred / DESI fallback | astro_k3s_mcp.es_query + euclid-catalog.get_catalog_objects | `_source` / objects[] | `SEGMENTATION_AREA` \| `seg_area` | numeric cast | `null` + reason `seg_area_missing` |",
    "",
    "## Additional Leveraged Fields (now included in crossmatch.csv)",
    "",
    "| output field | source catalog | mcp server/tool | source field | note |",
    "| --- | --- | --- | --- | --- |",
    "| flux_g/flux_r/flux_i/flux_z/flux_w1/flux_w2 | DESI | astro_k3s_mcp.es_query | `flux_*` | direct from DESI `_source` |",
    "| shape_r/shape_e1/shape_e2/sersic | DESI | astro_k3s_mcp.es_query | `shape_r`,`shape_e1`,`shape_e2`,`sersic` | morphology/size features |",
    "| ref_id/release/brick_primary | DESI | astro_k3s_mcp.es_query | `ref_id`,`release`,`brick_primary` | traceability + release split |",
    "| allmask_r/anymask_r/fracmasked_r/fracin_r/fracflux_r/fiberflux_r | DESI | astro_k3s_mcp.es_query | same names | quality + aperture context |",
    "| euclid_det_quality_flag/euclid_flag_vis | Euclid | astro_k3s_mcp.es_query / euclid-catalog.get_catalog_objects | `DET_QUALITY_FLAG`,`FLAG_VIS` | Euclid quality flags |",
    "| euclid_point_like_flag/euclid_extended_flag | Euclid | astro_k3s_mcp.es_query / euclid-catalog.get_catalog_objects | `POINT_LIKE_FLAG`,`EXTENDED_FLAG` | Euclid morphology flags |",
    "| euclid_semimajor_axis | Euclid | astro_k3s_mcp.es_query / euclid-catalog.get_catalog_objects | `SEMIMAJOR_AXIS` | size proxy |",
    "| euclid_flux_vis_* | Euclid | astro_k3s_mcp.es_query / euclid-catalog.get_catalog_objects | `FLUX_VIS_1/2/3/4FWHM_APER`,`FLUX_VIS_PSF`,`FLUX_VIS_SERSIC` | photometric proxies |",
    "| tile_index_source | derived | orchestrator | n/a | `euclid.tile_index` or `pending_ra_dec_to_tile_mapping` |",
    "| mag_proxy_source | derived | orchestrator | n/a | records which upstream field was used |",
    "| euclid_vis_path_pattern | derived | orchestrator | n/a | IRSA Euclid VIS BGSUB path pattern from `tile_index` |",
    "| desi_tractor_i_path / desi_image_*_path | derived | orchestrator | n/a | NERSC DR10 south paths from `brickname` |",
    "| path_source | derived | orchestrator | n/a | `derived` for normal rows, `mock` for DESI_MOCK seeded rows |",
    "",
    "## Current Known Gaps",
    "",
    "- Euclid `TILE_INDEX` is often missing in current queried rows; kept as nullable with explicit `tile_index_missing` reason.",
    "- RA/DEC -> tile index mapping is pending dedicated mapping support in euclid-catalog MCP.",
    "",
    "## Runtime Evidence Files",
    "",
    `- DESI raw payload: ${desiSearchInitialRawJson}`,
    `- DESI sample payload: ${desiSearchSampleRawJson}`,
    `- Euclid rows snapshot: ${euclidQueryCsv}`,
    `- DESI rows snapshot: ${desiQueryCsv}`,
    `- T1 schema report: ${t1SchemaReportJson}`,
    `- QC report: ${qcReportJson}`
  ]);

  const crossmatchTruncated = crossmatched.slice(0, maxResultRows);
  const imagePairRows = buildImagePairIndexRows(crossmatchTruncated as unknown as Record<string, unknown>[]);
  const preview = crossmatchTruncated.slice(0, previewRows);
  const previewSample = preview.slice(0, 10) as unknown as Record<string, unknown>[];
  const availableFilterFields = crossmatchTruncated.length > 0
    ? Object.keys(crossmatchTruncated[0] as unknown as Record<string, unknown>)
    : [];

  writeCsv(euclidQueryCsv, euclidRows as unknown as Record<string, unknown>[]);
  writeCsv(desiQueryCsv, desiRows as unknown as Record<string, unknown>[]);
  writeCsv(crossmatchCsv, crossmatchTruncated as unknown as Record<string, unknown>[], [
    "match_rank",
    "center_ra",
    "center_dec",
    "radius_arcsec",
    "dist_arcsec",
    "obj_id",
    "ra",
    "dec",
    "type",
    "tile_index",
    "brickname",
    "maskbits",
    "mag_proxy",
    "seg_area",
    "euclid_object_id",
    "desi_object_id",
    "euclid_ra",
    "euclid_dec",
    "desi_ra",
    "desi_dec",
    "brickid",
    "ra_deg",
    "dec_deg",
    "euclid_mag",
    "desi_mag",
    "class_label",
    "source_id",
    "target_id",
    "tile_index_source",
    "mag_proxy_source",
    "flux_g",
    "flux_r",
    "flux_i",
    "flux_z",
    "flux_w1",
    "flux_w2",
    "shape_r",
    "shape_e1",
    "shape_e2",
    "sersic",
    "ref_id",
    "release",
    "brick_primary",
    "allmask_r",
    "anymask_r",
    "fracmasked_r",
    "fracin_r",
    "fracflux_r",
    "fiberflux_r",
    "euclid_det_quality_flag",
    "euclid_flag_vis",
    "euclid_point_like_flag",
    "euclid_extended_flag",
    "euclid_semimajor_axis",
    "euclid_flux_vis_1fwhm_aper",
    "euclid_flux_vis_2fwhm_aper",
    "euclid_flux_vis_3fwhm_aper",
    "euclid_flux_vis_4fwhm_aper",
    "euclid_flux_vis_psf",
    "euclid_flux_vis_sersic",
    "euclid_vis_path_pattern",
    "desi_tractor_i_path",
    "desi_image_g_path",
    "desi_image_r_path",
    "desi_image_i_path",
    "desi_image_z_path",
    "path_source",
    "missing_reasons"
  ]);
  writeCsv(imagePairIndexCsv, imagePairRows, [
    "obj_id",
    "tile_index",
    "brickname",
    "ra",
    "dec",
    "type",
    "path_source",
    "lookup_mode",
    "lookup_key_tile_index",
    "lookup_key_brickname",
    "euclid_filename_query",
    "desi_filename_tractor_i",
    "desi_filename_g",
    "desi_filename_r",
    "desi_filename_i",
    "desi_filename_z",
    "euclid_path",
    "desi_path_tractor_i",
    "desi_path_g",
    "desi_path_r",
    "desi_path_i",
    "desi_path_z",
    "availability_euclid",
    "availability_tractor_i",
    "availability_g",
    "availability_r",
    "availability_i",
    "availability_z"
  ]);
  writeCsv(previewCsv, preview as unknown as Record<string, unknown>[]);
  writeJson(previewSummaryJson, {
    run_id: runId,
    crossmatch_rows: crossmatchTruncated.length,
    preview_rows: preview.length,
    available_filter_fields: availableFilterFields,
    preview_sample: previewSample
  });

  progress?.(`Crossmatch rows: ${crossmatchTruncated.length}`);
  progress?.(`Image pair index rows: ${imagePairRows.length}`);
  progress?.(`Preview rows: ${preview.length}`);
  runStatus.metrics = {
    ...(runStatus.metrics ?? {}),
    crossmatch_rows: crossmatchTruncated.length,
    image_pair_rows: imagePairRows.length,
    t1_rows_with_missing: t1RowsWithMissing
  };
  runStatus.artifacts = {
    ...(runStatus.artifacts ?? {}),
    t1_schema_report_json: t1SchemaReportJson,
    qc_report_json: qcReportJson
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

    const childPreviewSummary = childPreviewSummaryPath ? readJsonFile(childPreviewSummaryPath) : {};
    const childCrossmatchRows = Number(childPreviewSummary.crossmatch_rows ?? 0);
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
        crossmatch_csv: child.crossmatchCsv,
        image_pair_index_csv: child.imagePairIndexCsv,
        preview_summary_json: childPreviewSummaryPath ?? null,
        preview_csv: childPreviewCsvPath ?? null,
        filtered_csv: childFilteredCsvPath ?? null,
        stats_json: childStatsJsonPath ?? null,
        report_md: childReportMdPath ?? null,
        result_index_json: child.resultIndexJson
      },
      handoff_preview: {
        crossmatch_rows: childCrossmatchRows,
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
      child_crossmatch_rows: childCrossmatchRows,
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
      `- child_crossmatch_csv: ${child.crossmatchCsv}`,
      `- child_image_pair_index_csv: ${child.imagePairIndexCsv}`,
      `- child_preview_summary_json: ${childPreviewSummaryPath ?? "n/a"}`,
      `- child_preview_csv: ${childPreviewCsvPath ?? "n/a"}`,
      `- child_filtered_csv: ${childFilteredCsvPath ?? "n/a"}`,
      `- child_result_index_json: ${child.resultIndexJson}`,
      `- mock_continue_handoff_json: ${mockContinueHandoffJson}`,
      `- status_json: ${statusJson}`,
      `- stats_json: ${statsJson}`,
      `- result_index_json: ${resultIndexJson}`
    ]);

    const handoffArtifacts: RunArtifacts = {
      statusJson,
      inputManifestJson,
      crossmatchCsv: child.crossmatchCsv,
      imagePairIndexCsv: child.imagePairIndexCsv,
      previewCsv: childPreviewCsvPath,
      previewSummaryJson: childPreviewSummaryPath,
      filteredCsv: childFilteredCsvPath,
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
      desiHits: childCrossmatchRows,
      crossmatchRows: childCrossmatchRows,
      imagePairRows: childCrossmatchRows,
      previewRows: childPreviewRows,
      filteredRows: childCrossmatchRows,
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
      crossmatch_rows: childCrossmatchRows,
      image_pair_rows: childCrossmatchRows,
      preview_rows: childPreviewRows,
      desi_rows: childCrossmatchRows,
      zero_result: childCrossmatchRows === 0,
      available_filter_fields: childAvailableFields,
      preview_sample: childPreviewSample,
      human_gate_mode: "mock_continue",
      artifacts: {
        ...handoffArtifacts,
        childResultIndexJson: child.resultIndexJson
      },
      handoff_artifacts: {
        mock_continue_handoff_json: mockContinueHandoffJson,
        child_result_index_json: child.resultIndexJson,
        child_crossmatch_csv: child.crossmatchCsv,
        child_image_pair_index_csv: child.imagePairIndexCsv,
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
    progress?.(`Mock handoff artifacts: crossmatch=${child.crossmatchCsv}`);
    progress?.(`Mock handoff artifacts: image_pair_index=${child.imagePairIndexCsv}`);
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
      crossmatch_csv: child.crossmatchCsv,
      image_pair_index_csv: child.imagePairIndexCsv,
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
    desi_mock_applied: desiMockApplied,
    desi_mock_reason: desiMockReason,
    crossmatch_rows_total: crossmatched.length,
    crossmatch_rows_written: crossmatchTruncated.length,
    image_pair_rows: imagePairRows.length,
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
      image_pair_index_csv: imagePairIndexCsv,
      preview_csv: previewCsv,
      preview_summary_json: previewSummaryJson,
      filtered_csv: filteredCsv,
      report_md: reportMd,
      t1_schema_report_json: t1SchemaReportJson,
      qc_report_json: qcReportJson,
      field_lineage_md: fieldLineageDocMd
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
    imagePairIndexCsv,
    previewCsv,
    previewSummaryJson,
    filteredCsv,
    statsJson,
    reportMd,
    resultIndexJson,
    t1SchemaReportJson,
    qcReportJson,
    fieldLineageDocMd,
    humanGateRequestJson: humanGate.mode !== "region_adjust" ? humanGate.requestFile : undefined,
    regionAdjustRequestJson: humanGate.mode === "region_adjust" ? humanGate.requestFile : undefined
  };

  writeJson(resultIndexJson, {
    run_id: runId,
    output_dir: runDir,
    crossmatch_rows: crossmatchTruncated.length,
    image_pair_rows: imagePairRows.length,
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
    `- desi_mock_applied: ${desiMockApplied ? "yes" : "no"}`,
    `- desi_mock_reason: ${desiMockReason ?? "n/a"}`,
    `- crossmatch_rows_total: ${crossmatched.length}`,
    `- crossmatch_rows_written: ${crossmatchTruncated.length}`,
    `- image_pair_rows: ${imagePairRows.length}`,
    `- preview_file: preview_${previewRows}.csv`,
    `- preview_rows_written: ${preview.length}`,
    `- filtered_rows: ${filtered.length}`,
    `- filter_applied: ${humanGate.filter ? "yes" : "no"}`,
    `- human_gate_mode: ${humanGate.mode}`,
    `- crossmatch_csv: ${crossmatchCsv}`,
    `- image_pair_index_csv: ${imagePairIndexCsv}`,
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
    `- t1_schema_report_json: ${t1SchemaReportJson}`,
    `- qc_report_json: ${qcReportJson}`,
    `- field_lineage_md: ${fieldLineageDocMd}`,
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
    imagePairRows: imagePairRows.length,
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
    status_json: statusJson,
    input_manifest_json: inputManifestJson,
    desi_origin_json: desiOriginJson,
    desi_search_query_json: desiSearchQueryJson,
    desi_search_initial_raw_json: desiSearchInitialRawJson,
    desi_search_sample_raw_json: desiSearchSampleRawJson,
    desi_search_retry_raw_json: desiRetryRawJson,
    desi_search_retry_sample_raw_json: desiRetrySampleRawJson,
    crossmatch_csv: crossmatchCsv,
    image_pair_index_csv: imagePairIndexCsv,
    preview_csv: previewCsv,
    preview_summary_json: previewSummaryJson,
    filtered_csv: filteredCsv,
    report_md: reportMd,
    result_index_json: resultIndexJson,
    t1_schema_report_json: t1SchemaReportJson,
    qc_report_json: qcReportJson,
    field_lineage_md: fieldLineageDocMd,
    region_adjust_request: artifacts.regionAdjustRequestJson,
    human_gate_request: artifacts.humanGateRequestJson
  };
  writeRunStatus(statusJson, runStatus);

  progress?.(`Artifacts: crossmatch=${crossmatchCsv}`);
  progress?.(`Artifacts: image_pair_index=${imagePairIndexCsv}`);
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
  progress?.(`Artifacts: t1_schema_report=${t1SchemaReportJson}`);
  progress?.(`Artifacts: qc_report=${qcReportJson}`);
  progress?.(`Artifacts: field_lineage=${fieldLineageDocMd}`);
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
