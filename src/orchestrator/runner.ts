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

export async function runMvpPipeline(options: RunnerOptions): Promise<{ runId: string; runDir: string }> {
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
  const desiRows = await queryCatalogMcp("desi", coord, topK);
  const crossmatched = crossmatchCatalogs(euclidRows, desiRows, radiusArcsec);

  const crossmatchTruncated = crossmatched.slice(0, maxResultRows);
  const preview = crossmatchTruncated.slice(0, previewRows);

  const humanFilter = resolveHumanFilter(runDir, interaction, request.filter);
  const filtered = applyFilter(crossmatchTruncated, humanFilter);

  writeCsv(path.join(runDir, "euclid_query.csv"), euclidRows as unknown as Record<string, unknown>[]);
  writeCsv(path.join(runDir, "desi_query.csv"), desiRows as unknown as Record<string, unknown>[]);
  writeCsv(path.join(runDir, "crossmatch.csv"), crossmatchTruncated as unknown as Record<string, unknown>[]);
  writeCsv(path.join(runDir, `preview_${previewRows}.csv`), preview as unknown as Record<string, unknown>[]);
  writeCsv(path.join(runDir, "filtered.csv"), filtered as unknown as Record<string, unknown>[]);

  const stats = {
    run_id: runId,
    input_type: request.input.type,
    interaction,
    radius_arcsec: radiusArcsec,
    top_k: topK,
    preview_rows: previewRows,
    euclid_rows: euclidRows.length,
    desi_rows: desiRows.length,
    crossmatch_rows_total: crossmatched.length,
    crossmatch_rows_written: crossmatchTruncated.length,
    filtered_rows: filtered.length,
    truncated: crossmatched.length > maxResultRows,
    filter: humanFilter ?? null
  };
  writeJson(path.join(runDir, "stats.json"), stats);

  writeReport(path.join(runDir, "report.md"), [
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
    `- crossmatch_rows_total: ${crossmatched.length}`,
    `- crossmatch_rows_written: ${crossmatchTruncated.length}`,
    `- preview_file: preview_${previewRows}.csv`,
    `- filtered_rows: ${filtered.length}`,
    `- filter_applied: ${humanFilter ? "yes" : "no"}`
  ]);

  return { runId, runDir };
}
