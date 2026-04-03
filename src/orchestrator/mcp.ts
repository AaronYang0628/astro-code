import { callMcpTool } from "./mcp-client.js";
import type { CatalogRecord, Coord } from "./types.js";

const EUCLID_SERVER = "euclid-catalog";
const ASTRO_SERVER = "astro_k3s_mcp";

interface QueryOptions {
  windowScale?: number;
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

async function queryDesiRows(coord: Coord, topK: number, options?: QueryOptions): Promise<CatalogRecord[]> {
  const queryWindowArcsec = Number(process.env.DESI_WINDOW_ARCSEC ?? "10");
  const windowDeg = Number.isFinite(queryWindowArcsec) ? queryWindowArcsec / 3600 : 10 / 3600;

  const scale = options?.windowScale ?? 1;
  const halfRa = Math.max(windowDeg, coord.ra_min !== undefined && coord.ra_max !== undefined ? (coord.ra_max - coord.ra_min) / 2 : windowDeg);
  const halfDec = Math.max(windowDeg, coord.dec_min !== undefined && coord.dec_max !== undefined ? (coord.dec_max - coord.dec_min) / 2 : windowDeg);

  const raMin = coord.ra_deg - halfRa * scale;
  const raMax = coord.ra_deg + halfRa * scale;
  const decMin = coord.dec_deg - halfDec * scale;
  const decMax = coord.dec_deg + halfDec * scale;

  const payload = await callMcpTool(ASTRO_SERVER, "es_query", {
    catalog: "desi-dr10-tractor",
    mode: "search",
    body: {
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
      class_label: String(source.type ?? source.TYPE ?? source.objtype ?? "unknown")
    });
  }

  return rows;
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
  return queryDesiRows(coord, topK, options);
}
