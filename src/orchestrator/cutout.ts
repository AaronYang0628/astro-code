import { callMcpTool } from "./mcp-client.js";
import type { CrossmatchRecord } from "./types.js";

type DesiBand = "g" | "r" | "i" | "z";

interface CutoutTargetPayload {
  obj_id: string;
  row_index: number;
  tile_index?: string;
  brickname?: string;
  ra_deg: number;
  dec_deg: number;
}

interface CutoutGroup {
  telescope: "euclid" | "desi";
  band: string;
  source_uri: string;
  targets: CutoutTargetPayload[];
}

export interface CutoutIndexRecord {
  status: string;
  telescope: string;
  band: string;
  source_uri: string;
  resolved_source_uri?: string;
  row_index?: number;
  obj_id?: string;
  ra_deg?: number;
  dec_deg?: number;
  output_uri?: string;
  error?: string;
  has_overlap?: boolean;
  x?: number;
  y?: number;
  xmin?: number;
  xmax?: number;
  ymin?: number;
  ymax?: number;
  stamp_size_px?: number;
}

export interface CutoutExecutionSummary {
  requested: boolean;
  server: string;
  groups_total: number;
  targets_total: number;
  groups_succeeded: number;
  groups_failed: number;
  records: CutoutIndexRecord[];
  raw_reports: Record<string, unknown>[];
}

interface ExecuteGroupedCutoutOptions {
  runId: string;
  rows: CrossmatchRecord[];
  serverName: string;
  outputPrefix?: string;
  sizeDeg: number;
  desiBands: DesiBand[];
  progress?: (line: string) => void;
}

function toFinite(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickRa(row: CrossmatchRecord): number | null {
  return toFinite(row.RIGHT_ASCENSION) ?? toFinite(row.ra_deg) ?? toFinite(row.ra);
}

function pickDec(row: CrossmatchRecord): number | null {
  return toFinite(row.DECLINATION) ?? toFinite(row.dec_deg) ?? toFinite(row.dec);
}

function normalizeBands(bands: DesiBand[]): DesiBand[] {
  const out: DesiBand[] = [];
  for (const band of bands) {
    if (!out.includes(band)) {
      out.push(band);
    }
  }
  return out.length > 0 ? out : ["g", "r", "i", "z"];
}

function buildCutoutGroups(rows: CrossmatchRecord[], desiBands: DesiBand[]): CutoutGroup[] {
  const groups = new Map<string, CutoutGroup>();

  const addTarget = (
    telescope: "euclid" | "desi",
    band: string,
    sourceUri: string,
    target: CutoutTargetPayload
  ): void => {
    const key = `${telescope}|${band}|${sourceUri}`;
    const existing = groups.get(key);
    if (existing) {
      existing.targets.push(target);
      return;
    }
    groups.set(key, {
      telescope,
      band,
      source_uri: sourceUri,
      targets: [target]
    });
  };

  const effectiveBands = normalizeBands(desiBands);

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    const ra = pickRa(row);
    const dec = pickDec(row);
    if (ra === null || dec === null) {
      continue;
    }

    const target: CutoutTargetPayload = {
      obj_id: row.obj_id,
      row_index: idx,
      tile_index: row.tile_index ?? undefined,
      brickname: row.brickname ?? undefined,
      ra_deg: ra,
      dec_deg: dec
    };

    if (typeof row.euclid_fits_path === "string" && row.euclid_fits_path.trim().length > 0) {
      addTarget("euclid", "vis", row.euclid_fits_path, target);
    }

    for (const band of effectiveBands) {
      const sourceUri = band === "g"
        ? row.desi_image_g_path
        : band === "r"
          ? row.desi_image_r_path
          : band === "i"
            ? row.desi_image_i_path
            : row.desi_image_z_path;

      if (typeof sourceUri === "string" && sourceUri.trim().length > 0) {
        addTarget("desi", band, sourceUri, target);
      }
    }
  }

  return [...groups.values()];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function toCutoutRecord(
  group: CutoutGroup,
  result: Record<string, unknown>,
  resolvedSourceUri: string | undefined
): CutoutIndexRecord {
  const meta = asObject(result.meta) ?? {};
  return {
    status: String(result.status ?? "unknown"),
    telescope: group.telescope,
    band: group.band,
    source_uri: group.source_uri,
    resolved_source_uri: resolvedSourceUri,
    row_index: toFinite(result.row_index) ?? undefined,
    obj_id: typeof result.obj_id === "string" ? result.obj_id : undefined,
    ra_deg: toFinite(result.ra_deg) ?? undefined,
    dec_deg: toFinite(result.dec_deg) ?? undefined,
    output_uri: typeof result.output_uri === "string" ? result.output_uri : undefined,
    error: typeof result.error === "string" ? result.error : undefined,
    has_overlap: Boolean(meta.has_overlap),
    x: toFinite(meta.x) ?? undefined,
    y: toFinite(meta.y) ?? undefined,
    xmin: toFinite(meta.xmin) ?? undefined,
    xmax: toFinite(meta.xmax) ?? undefined,
    ymin: toFinite(meta.ymin) ?? undefined,
    ymax: toFinite(meta.ymax) ?? undefined,
    stamp_size_px: toFinite(meta.stamp_size_px) ?? undefined
  };
}

export async function executeGroupedCutoutViaMcp(
  options: ExecuteGroupedCutoutOptions
): Promise<CutoutExecutionSummary> {
  const groups = buildCutoutGroups(options.rows, options.desiBands);
  const targetsTotal = groups.reduce((sum, group) => sum + group.targets.length, 0);

  const records: CutoutIndexRecord[] = [];
  const rawReports: Record<string, unknown>[] = [];

  let groupsSucceeded = 0;
  let groupsFailed = 0;

  for (const group of groups) {
    options.progress?.(`Cutout group: telescope=${group.telescope}, band=${group.band}, targets=${group.targets.length}`);
    try {
      const raw = await callMcpTool(options.serverName, "execute_cutout_group", {
        run_id: options.runId,
        telescope: group.telescope,
        band: group.band,
        source_uri: group.source_uri,
        targets: group.targets,
        size_deg: options.sizeDeg,
        output_prefix: options.outputPrefix,
        resolve_wildcard: true
      }) as unknown;

      const report = asObject(raw) ?? {};
      rawReports.push(report);

      const resolvedSourceUri = typeof report.resolved_source_uri === "string"
        ? report.resolved_source_uri
        : undefined;

      const resultRows = Array.isArray(report.results)
        ? report.results.filter((item): item is Record<string, unknown> => asObject(item) !== null)
        : [];

      if (typeof report.error === "string") {
        groupsFailed += 1;
      } else {
        groupsSucceeded += 1;
      }

      if (resultRows.length === 0 && typeof report.error === "string") {
        for (const target of group.targets) {
          records.push({
            status: "error",
            telescope: group.telescope,
            band: group.band,
            source_uri: group.source_uri,
            resolved_source_uri: resolvedSourceUri,
            row_index: target.row_index,
            obj_id: target.obj_id,
            ra_deg: target.ra_deg,
            dec_deg: target.dec_deg,
            error: String(report.error)
          });
        }
        continue;
      }

      for (const result of resultRows) {
        records.push(toCutoutRecord(group, result, resolvedSourceUri));
      }
    } catch (error) {
      groupsFailed += 1;
      const message = error instanceof Error ? error.message : String(error);
      for (const target of group.targets) {
        records.push({
          status: "error",
          telescope: group.telescope,
          band: group.band,
          source_uri: group.source_uri,
          row_index: target.row_index,
          obj_id: target.obj_id,
          ra_deg: target.ra_deg,
          dec_deg: target.dec_deg,
          error: message
        });
      }
    }
  }

  return {
    requested: true,
    server: options.serverName,
    groups_total: groups.length,
    targets_total: targetsTotal,
    groups_succeeded: groupsSucceeded,
    groups_failed: groupsFailed,
    records,
    raw_reports: rawReports
  };
}
