import { callMcpTool } from "./mcp-client.js";
import type { CatalogRecord, Coord } from "./types.js";

const EUCLID_SERVER = "euclid-catalog";
const ASTRO_SERVER = "astro_k3s_mcp";

interface QueryOptions {
  windowScale?: number;
}

interface DesiQueryWindow {
  ra_min: number;
  ra_max: number;
  dec_min: number;
  dec_max: number;
}

interface DesiOrigin {
  source_system: "astro_k3s_mcp";
  catalog: "desi-dr10-tractor";
  backend_type: "mcp_es_index";
  storage_hint: "es-index" | "s3" | "local" | "unknown";
  source_path: string | null;
  source_path_field: string | null;
  note: string;
}

export interface DesiQueryDetails {
  rows: CatalogRecord[];
  hitsTotal: number;
  queryWindow: DesiQueryWindow;
  queryBody: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  samplePayload: Record<string, unknown>;
  sampleRows: Array<Record<string, unknown>>;
  origin: DesiOrigin;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstFinite(values: unknown[], fallback = 99): number {
  for (const value of values) {
    const n = toNumber(value);
    if (n !== null) {
      return n;
    }
  }
  return fallback;
}

function pickCoord(record: Record<string, unknown>): { ra: number | null; dec: number | null } {
  const ra = firstFinite(
    [record.ra, record.RA, record.right_ascension, record.RIGHT_ASCENSION],
    Number.NaN
  );
  const dec = firstFinite(
    [record.dec, record.DEC, record.declination, record.DECLINATION],
    Number.NaN
  );

  return {
    ra: Number.isFinite(ra) ? ra : null,
    dec: Number.isFinite(dec) ? dec : null
  };
}

function getHitsContainer(payload: Record<string, unknown>): Record<string, unknown> {
  const data = (payload.data as Record<string, unknown> | undefined) ?? {};
  const result = (data.result as Record<string, unknown> | undefined) ?? {};
  return (result.hits as Record<string, unknown> | undefined) ?? {};
}

function getHitRows(payload: Record<string, unknown>): Record<string, unknown>[] {
  const hitsContainer = getHitsContainer(payload);
  const hits = hitsContainer.hits;
  return Array.isArray(hits) ? (hits as Record<string, unknown>[]) : [];
}

function getHitsTotal(payload: Record<string, unknown>): number {
  const hitsContainer = getHitsContainer(payload);
  const total = hitsContainer.total;
  if (typeof total === "number" && Number.isFinite(total)) {
    return total;
  }
  if (typeof total === "object" && total !== null) {
    const value = toNumber((total as Record<string, unknown>).value);
    if (value !== null) {
      return value;
    }
  }
  return getHitRows(payload).length;
}

function detectSourcePath(source: Record<string, unknown>): { value: string | null; field: string | null } {
  const candidates = [
    "source_path",
    "sourcePath",
    "file_path",
    "filePath",
    "path",
    "uri",
    "s3_path",
    "s3_uri",
    "filename"
  ];

  for (const key of candidates) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return { value, field: key };
    }
  }
  return { value: null, field: null };
}

function inferStorageHint(sourcePath: string | null): DesiOrigin["storage_hint"] {
  if (!sourcePath) {
    return "es-index";
  }
  if (sourcePath.startsWith("s3://")) {
    return "s3";
  }
  if (sourcePath.startsWith("/") || sourcePath.startsWith("file://")) {
    return "local";
  }
  return "unknown";
}

function buildFallbackEuclidFromCoord(coord: Coord): CatalogRecord[] {
  return [{
    catalog: "euclid",
    object_id: `EUCLID_POINT_${coord.ra_deg.toFixed(6)}_${coord.dec_deg.toFixed(6)}`,
    ra_deg: coord.ra_deg,
    dec_deg: coord.dec_deg,
    mag: 99,
    class_label: "unknown"
  }];
}

export async function extractCoordFromS3Mcp(uri: string): Promise<Coord> {
  if (!uri.startsWith("s3://")) {
    throw new Error("S3 input must use s3://bucket/key format.");
  }

  const info = await callMcpTool(EUCLID_SERVER, "get_catalog_info_with_stats", {
    catalog_path: uri
  }) as Record<string, unknown>;

  const ranges = (info.coordinate_ranges as Record<string, unknown> | undefined) ?? {};
  const raMin = toNumber(ranges.ra_min);
  const raMax = toNumber(ranges.ra_max);
  const decMin = toNumber(ranges.dec_min);
  const decMax = toNumber(ranges.dec_max);

  if (raMin === null || raMax === null || decMin === null || decMax === null) {
    throw new Error("Euclid MCP did not return coordinate_ranges for S3 input.");
  }

  return {
    ra_deg: (raMin + raMax) / 2,
    dec_deg: (decMin + decMax) / 2,
    ra_min: raMin,
    ra_max: raMax,
    dec_min: decMin,
    dec_max: decMax,
    s3_path: uri,
    num_objects: toNumber(info.num_objects) ?? undefined,
    source: "mcp_s3_reader"
  };
}

async function queryEuclidRows(coord: Coord, topK: number): Promise<CatalogRecord[]> {
  if (!coord.s3_path) {
    const euclidWindowArcsec = Number(process.env.EUCLID_WINDOW_ARCSEC ?? "600");
    const euclidWindowDeg = Number.isFinite(euclidWindowArcsec) ? euclidWindowArcsec / 3600 : 600 / 3600;
    const raMin = coord.ra_deg - euclidWindowDeg;
    const raMax = coord.ra_deg + euclidWindowDeg;
    const decMin = coord.dec_deg - euclidWindowDeg;
    const decMax = coord.dec_deg + euclidWindowDeg;

    const payload = await callMcpTool(ASTRO_SERVER, "es_query", {
      catalog: "euclid-q1-mer-final",
      mode: "search",
      body: {
        query: {
          bool: {
            filter: [
              { range: { RIGHT_ASCENSION: { gte: raMin, lte: raMax } } },
              { range: { DECLINATION: { gte: decMin, lte: decMax } } }
            ]
          }
        },
        from: 0,
        size: topK
      }
    }) as Record<string, unknown>;

    const hits = (((payload.data as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined)?.hits as Record<string, unknown> | undefined)?.hits;
    const hitRows = Array.isArray(hits) ? hits : [];
    const rows: CatalogRecord[] = [];

    for (const hit of hitRows) {
      if (typeof hit !== "object" || hit === null) {
        continue;
      }

      const hitObj = hit as Record<string, unknown>;
      const source = (hitObj._source as Record<string, unknown> | undefined) ?? hitObj;
      const { ra, dec } = pickCoord(source);
      if (ra === null || dec === null) {
        continue;
      }

      rows.push({
        catalog: "euclid",
        object_id: String(
          source.OBJECT_ID
          ?? source.object_id
          ?? hitObj._id
          ?? `EUCLID_${rows.length + 1}`
        ),
        ra_deg: ra,
        dec_deg: dec,
        mag: firstFinite([
          source.MAG_VIS,
          source.mag_vis,
          source.MAG_AUTO,
          source.mag_auto,
          source.mag,
          source.MAG
        ]),
        class_label: String(
          source.EXTENDED_FLAG
          ?? source.extended_flag
          ?? source.type
          ?? source.TYPE
          ?? "unknown"
        )
      });
    }

    return rows.length > 0 ? rows : buildFallbackEuclidFromCoord(coord);
  }

  const payload = await callMcpTool(EUCLID_SERVER, "get_catalog_objects", {
    catalog_path: coord.s3_path,
    start: 0,
    limit: topK,
    columns: ["OBJECT_ID", "RIGHT_ASCENSION", "DECLINATION"]
  }) as Record<string, unknown>;

  const objects = Array.isArray(payload.objects) ? payload.objects : [];
  const rows: CatalogRecord[] = [];

  for (const obj of objects) {
    if (typeof obj !== "object" || obj === null) {
      continue;
    }
    const record = obj as Record<string, unknown>;
    const ra = toNumber(record.RIGHT_ASCENSION);
    const dec = toNumber(record.DECLINATION);
    if (ra === null || dec === null) {
      continue;
    }

    rows.push({
      catalog: "euclid",
      object_id: String(record.OBJECT_ID ?? `EUCLID_${rows.length + 1}`),
      ra_deg: ra,
      dec_deg: dec,
      mag: 99,
      class_label: "unknown"
    });
  }

  return rows.length > 0 ? rows : buildFallbackEuclidFromCoord(coord);
}

async function queryDesiRowsWithDetails(
  coord: Coord,
  topK: number,
  options?: QueryOptions
): Promise<DesiQueryDetails> {
  const queryWindowArcsec = Number(process.env.DESI_WINDOW_ARCSEC ?? "10");
  const windowDeg = Number.isFinite(queryWindowArcsec) ? queryWindowArcsec / 3600 : 10 / 3600;

  const scale = options?.windowScale ?? 1;
  const halfRa = Math.max(windowDeg, coord.ra_min !== undefined && coord.ra_max !== undefined ? (coord.ra_max - coord.ra_min) / 2 : windowDeg);
  const halfDec = Math.max(windowDeg, coord.dec_min !== undefined && coord.dec_max !== undefined ? (coord.dec_max - coord.dec_min) / 2 : windowDeg);

  const raMin = coord.ra_deg - halfRa * scale;
  const raMax = coord.ra_deg + halfRa * scale;
  const decMin = coord.dec_deg - halfDec * scale;
  const decMax = coord.dec_deg + halfDec * scale;

  const queryBody = {
    query: {
      bool: {
        filter: [
          { range: { ra: { gte: raMin, lte: raMax } } },
          { range: { dec: { gte: decMin, lte: decMax } } },
          { term: { brick_primary: true } }
        ]
      }
    },
    from: 0,
    size: topK
  };

  const payload = await callMcpTool(ASTRO_SERVER, "es_query", {
    catalog: "desi-dr10-tractor",
    mode: "search",
    body: queryBody
  }) as Record<string, unknown>;

  const sampleBody = {
    ...queryBody,
    size: 3,
    _source: [
      "OBJECT_ID",
      "TARGETID",
      "ra",
      "dec",
      "type",
      "brick_primary",
      "source_path",
      "path",
      "uri",
      "s3_path"
    ]
  };

  const samplePayload = await callMcpTool(ASTRO_SERVER, "es_query", {
    catalog: "desi-dr10-tractor",
    mode: "search",
    body: sampleBody
  }) as Record<string, unknown>;

  const hitRows = getHitRows(payload);

  const rows: CatalogRecord[] = [];
  for (const hit of hitRows) {
    if (typeof hit !== "object" || hit === null) {
      continue;
    }

    const hitObj = hit as Record<string, unknown>;
    const source = (hitObj._source as Record<string, unknown> | undefined) ?? hitObj;
    const { ra, dec } = pickCoord(source);
    if (ra === null || dec === null) {
      continue;
    }

    rows.push({
      catalog: "desi",
      object_id: String(
        source.OBJECT_ID
        ?? source.object_id
        ?? source.TARGETID
        ?? source.targetid
        ?? hitObj._id
        ?? `DESI_${rows.length + 1}`
      ),
      ra_deg: ra,
      dec_deg: dec,
      mag: firstFinite([
        source.mag,
        source.mag_r,
        source.mag_g,
        source.mag_z,
        source.MAG,
        source.MAG_R,
        source.MAG_G,
        source.MAG_Z
      ]),
      class_label: String(source.type ?? source.TYPE ?? source.objtype ?? "unknown"),
      source_system: "astro_k3s_mcp",
      source_index: typeof hitObj._index === "string" ? hitObj._index : undefined,
      source_id: typeof hitObj._id === "string" ? hitObj._id : undefined,
      source_path: detectSourcePath(source).value ?? undefined
    });
  }

  const sampleRows = getHitRows(samplePayload).map((hit) => {
    const source = ((hit._source as Record<string, unknown> | undefined) ?? hit) as Record<string, unknown>;
    return {
      id: String(source.OBJECT_ID ?? source.object_id ?? source.TARGETID ?? source.targetid ?? hit._id ?? "n/a"),
      ra: firstFinite([source.ra, source.RA], Number.NaN),
      dec: firstFinite([source.dec, source.DEC], Number.NaN),
      type: String(source.type ?? source.TYPE ?? source.objtype ?? "unknown"),
      index: typeof hit._index === "string" ? hit._index : null,
      doc_id: typeof hit._id === "string" ? hit._id : null,
      source_path: detectSourcePath(source).value
    };
  });

  const firstSource = hitRows.length > 0
    ? (((hitRows[0]._source as Record<string, unknown> | undefined) ?? hitRows[0]) as Record<string, unknown>)
    : {};
  const sourcePath = detectSourcePath(firstSource);

  return {
    rows,
    hitsTotal: getHitsTotal(payload),
    queryWindow: {
      ra_min: raMin,
      ra_max: raMax,
      dec_min: decMin,
      dec_max: decMax
    },
    queryBody,
    rawPayload: payload,
    samplePayload,
    sampleRows,
    origin: {
      source_system: "astro_k3s_mcp",
      catalog: "desi-dr10-tractor",
      backend_type: "mcp_es_index",
      storage_hint: inferStorageHint(sourcePath.value),
      source_path: sourcePath.value,
      source_path_field: sourcePath.field,
      note: sourcePath.value
        ? "Source path field found in ES document; value propagated from _source"
        : "DESI query source is ES index via MCP. No file path field is exposed in current document schema."
    }
  };
}

export async function queryCatalogMcp(
  catalog: "euclid" | "desi",
  coord: Coord,
  topK: number,
  options?: QueryOptions
): Promise<CatalogRecord[]> {
  if (catalog === "euclid") {
    return queryEuclidRows(coord, topK);
  }
  const details = await queryDesiRowsWithDetails(coord, topK, options);
  return details.rows;
}

export async function queryDesiMcpWithDetails(
  coord: Coord,
  topK: number,
  options?: QueryOptions
): Promise<DesiQueryDetails> {
  return queryDesiRowsWithDetails(coord, topK, options);
}
