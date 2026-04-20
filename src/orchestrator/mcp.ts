import { callMcpTool } from "./mcp-client.js";
import type { CatalogRecord, Coord } from "./types.js";

const EUCLID_SERVER = "euclid-catalog";
const ASTRO_SERVER = "astro_k3s_mcp";
const EUCLID_MER_S3_BASE = "s3://data-and-computing/projects/CSST/shared-data/euclid/aws-mirrors/q1/MER";

interface QueryOptions {
  windowScale?: number;
}

const tileResolveCache = new Map<string, { tile_id?: string; source: string }>();
const euclidVisFitsPathCache = new Map<string, { path: string; source: "catalog_match" | "fallback_pattern" }>();

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

function parsePossiblyNanJson(raw: string): unknown {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    const sanitized = text
      .replace(/\b-Infinity\b/g, "null")
      .replace(/\bInfinity\b/g, "null")
      .replace(/\bNaN\b/g, "null");
    try {
      return JSON.parse(sanitized);
    } catch {
      return undefined;
    }
  }
}

function unwrapEuclidToolPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const tryUnwrap = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value === "string") {
      const parsed = parsePossiblyNanJson(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return undefined;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return undefined;
  };

  return tryUnwrap(payload.result)
    ?? tryUnwrap((payload.data as Record<string, unknown> | undefined)?.result)
    ?? tryUnwrap(payload.data)
    ?? payload;
}

function getEuclidObjects(payload: Record<string, unknown>): Record<string, unknown>[] {
  const normalized = unwrapEuclidToolPayload(payload);
  const objects = normalized.objects;
  if (!Array.isArray(objects)) {
    return [];
  }
  return objects.filter((obj): obj is Record<string, unknown> => typeof obj === "object" && obj !== null);
}

function getToolError(payload: Record<string, unknown>): string | undefined {
  const direct = toStringOrUndefined(payload.error);
  if (direct) {
    return direct;
  }
  const normalized = unwrapEuclidToolPayload(payload);
  return toStringOrUndefined(normalized.error);
}

function getEuclidCatalogEntries(payload: Record<string, unknown>): Record<string, unknown>[] {
  const normalized = unwrapEuclidToolPayload(payload);
  const catalogs = normalized.catalogs;
  if (!Array.isArray(catalogs)) {
    return [];
  }
  return catalogs.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

function normalizeS3Path(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith("s3://")) {
    return trimmed;
  }
  if (trimmed.startsWith("projects/")) {
    return `s3://data-and-computing/${trimmed}`;
  }
  if (trimmed.startsWith("/projects/")) {
    return `s3://data-and-computing${trimmed}`;
  }
  return undefined;
}

function pickEuclidCatalogEntryByPreference(
  entries: Record<string, unknown>[],
  tileId: string
): Record<string, unknown> | undefined {
  const tileToken = `TILE${tileId}`;
  const byName = (entry: Record<string, unknown>): string => String(entry.name ?? entry.path ?? "");

  return entries.find((entry) => byName(entry).includes("BGSUB-MOSAIC-VIS") && byName(entry).includes(tileToken))
    ?? entries.find((entry) => byName(entry).includes("BGSUB-MOSAIC-VIS"))
    ?? entries.find((entry) => byName(entry).includes("MOSAIC-VIS"));
}

async function listEuclidCatalogsByPath(catalogPath: string): Promise<Record<string, unknown>> {
  return await callMcpTool(EUCLID_SERVER, "list_catalogs", { path: catalogPath }) as Record<string, unknown>;
}

async function getS3SelectableColumns(catalogPath: string, preferred: string[]): Promise<string[] | undefined> {
  try {
    const payload = await callMcpTool(EUCLID_SERVER, "parse_fits_header_only", {
      catalog_path: catalogPath
    }) as Record<string, unknown>;
    const normalized = unwrapEuclidToolPayload(payload);
    const hdus = Array.isArray(normalized.hdus) ? normalized.hdus as Record<string, unknown>[] : [];

    let selectedHdu: Record<string, unknown> | undefined;
    for (const hdu of hdus) {
      if (Number(toNumber(hdu.num_columns ?? 0)) > 0) {
        selectedHdu = hdu;
        break;
      }
    }
    if (!selectedHdu) {
      return undefined;
    }

    const cols = Array.isArray(selectedHdu.columns) ? selectedHdu.columns as Record<string, unknown>[] : [];
    const available = new Set(cols
      .map((col) => (typeof col.name === "string" ? col.name.trim() : ""))
      .filter((name) => name.length > 0));

    const filtered = preferred.filter((name) => available.has(name));
    return filtered.length > 0 ? filtered : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveEuclidMerVisFitsPathByTile(
  tileId: string
): Promise<{ path: string; source: "catalog_match" | "fallback_pattern" } | null> {
  const normalizedTile = normalizeTileId(tileId);
  if (!normalizedTile) {
    return null;
  }

  const cached = euclidVisFitsPathCache.get(normalizedTile);
  if (cached) {
    return cached;
  }

  const catalogPath = `${EUCLID_MER_S3_BASE}/${normalizedTile}/VIS/`;
  try {
    const payload = await listEuclidCatalogsByPath(catalogPath);
    const entries = getEuclidCatalogEntries(payload);
    const picked = pickEuclidCatalogEntryByPreference(entries, normalizedTile);

    if (!picked) {
      const fallback = `${catalogPath}EUC_MER_BGSUB-MOSAIC-VIS_TILE${normalizedTile}-*.fits`;
      const resolved = { path: fallback, source: "fallback_pattern" as const };
      euclidVisFitsPathCache.set(normalizedTile, resolved);
      return resolved;
    }

    const normalized = normalizeS3Path(picked.path)
      ?? normalizeS3Path(picked.uri)
      ?? normalizeS3Path(picked.s3_path);
    if (normalized) {
      const resolved = { path: normalized, source: "catalog_match" as const };
      euclidVisFitsPathCache.set(normalizedTile, resolved);
      return resolved;
    }

    const name = toStringOrUndefined(picked.name);
    const fallback = name ? `${catalogPath}${name}` : `${catalogPath}EUC_MER_BGSUB-MOSAIC-VIS_TILE${normalizedTile}-*.fits`;
    const resolved = { path: fallback, source: name ? "catalog_match" as const : "fallback_pattern" as const };
    euclidVisFitsPathCache.set(normalizedTile, resolved);
    return resolved;
  } catch {
    const fallback = `${catalogPath}EUC_MER_BGSUB-MOSAIC-VIS_TILE${normalizedTile}-*.fits`;
    const resolved = { path: fallback, source: "fallback_pattern" as const };
    euclidVisFitsPathCache.set(normalizedTile, resolved);
    return resolved;
  }
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

function mapDesiRowsFromHitRows(hitRows: Record<string, unknown>[]): CatalogRecord[] {
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
      obj_id: String(
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
      mag_proxy: fluxToMagNanomaggy(toNumber(source.flux_r ?? source.FLUX_R))
        ?? fluxToMagNanomaggy(toNumber(source.flux_g ?? source.FLUX_G))
        ?? firstFinite([
          source.mag,
          source.mag_r,
          source.mag_g,
          source.mag_z,
          source.MAG,
          source.MAG_R,
          source.MAG_G,
          source.MAG_Z
        ]),
      type: normalizeType(source.type ?? source.TYPE ?? source.objtype),
      class_label: String(source.type ?? source.TYPE ?? source.objtype ?? "unknown"),
      brickname: toStringOrUndefined(source.brickname ?? source.BRICKNAME),
      brickid: toNumber(source.brickid ?? source.BRICKID) ?? undefined,
      maskbits: toNumber(source.maskbits ?? source.MASKBITS) ?? undefined,
      seg_area: toNumber(
        source.segmentation_area
        ?? source.SEGMENTATION_AREA
        ?? source.seg_area
        ?? source.SEG_AREA
      ) ?? undefined,
      source_system: "astro_k3s_mcp",
      source_index: typeof hitObj._index === "string" ? hitObj._index : undefined,
      source_id: typeof hitObj._id === "string" ? hitObj._id : undefined,
      source_path: detectSourcePath(source).value ?? undefined,
      flux_g: toNumber(source.flux_g ?? source.FLUX_G) ?? undefined,
      flux_r: toNumber(source.flux_r ?? source.FLUX_R) ?? undefined,
      flux_i: toNumber(source.flux_i ?? source.FLUX_I) ?? undefined,
      flux_z: toNumber(source.flux_z ?? source.FLUX_Z) ?? undefined,
      flux_w1: toNumber(source.flux_w1 ?? source.FLUX_W1) ?? undefined,
      flux_w2: toNumber(source.flux_w2 ?? source.FLUX_W2) ?? undefined,
      shape_r: toNumber(source.shape_r ?? source.SHAPE_R) ?? undefined,
      shape_e1: toNumber(source.shape_e1 ?? source.SHAPE_E1) ?? undefined,
      shape_e2: toNumber(source.shape_e2 ?? source.SHAPE_E2) ?? undefined,
      sersic: toNumber(source.sersic ?? source.SERSIC) ?? undefined,
      ref_id: toNumber(source.ref_id ?? source.REF_ID) ?? undefined,
      release: toNumber(source.release ?? source.RELEASE) ?? undefined,
      brick_primary: typeof source.brick_primary === "boolean" ? source.brick_primary : undefined,
      allmask_r: toNumber(source.allmask_r ?? source.ALLMASK_R) ?? undefined,
      anymask_r: toNumber(source.anymask_r ?? source.ANYMASK_R) ?? undefined,
      fracmasked_r: toNumber(source.fracmasked_r ?? source.FRACMASKED_R) ?? undefined,
      fracin_r: toNumber(source.fracin_r ?? source.FRACIN_R) ?? undefined,
      fracflux_r: toNumber(source.fracflux_r ?? source.FRACFLUX_R) ?? undefined,
      fiberflux_r: toNumber(source.fiberflux_r ?? source.FIBERFLUX_R) ?? undefined
    });
  }

  return rows;
}

function mapDesiSampleRows(samplePayload: Record<string, unknown>): Array<Record<string, unknown>> {
  return getHitRows(samplePayload).map((hit) => {
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

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function normalizeTileId(value: unknown): string | undefined {
  const raw = toStringOrUndefined(value);
  if (!raw) {
    return undefined;
  }
  if (/^\d{6,12}$/.test(raw)) {
    return raw;
  }
  const embedded = raw.match(/(\d{6,12})/);
  return embedded?.[1];
}

function tileSegmentationRange(tileId: string): { gte: number; lte: number } | null {
  if (!/^\d{6,12}$/.test(tileId)) {
    return null;
  }
  const tileNum = Number(tileId);
  if (!Number.isFinite(tileNum)) {
    return null;
  }
  const gte = tileNum * 1_000_000;
  const lte = gte + 999_999;
  if (!Number.isSafeInteger(gte) || !Number.isSafeInteger(lte)) {
    return null;
  }
  return { gte, lte };
}

function buildEuclidTileLookupQuery(tileId: string): Record<string, unknown> {
  const should: Record<string, unknown>[] = [
    { term: { TILE_INDEX: tileId } },
    { term: { tile_index: tileId } },
    { term: { TILEID: tileId } },
    { term: { tileid: tileId } }
  ];

  const segRange = tileSegmentationRange(tileId);
  if (segRange) {
    should.push({ range: { SEGMENTATION_MAP_ID: segRange } });
  }

  return {
    bool: {
      should,
      minimum_should_match: 1
    }
  };
}

function toBase36Digit(ch: string): number | null {
  const c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) {
    return c - 48;
  }
  if (c >= 65 && c <= 90) {
    return c - 65 + 10;
  }
  if (c >= 97 && c <= 122) {
    return c - 97 + 10;
  }
  return null;
}

function deriveNumericTileId(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const token = trimmed.replace(/^EUC_TILE_/i, "");
  let hash = 0n;
  let used = 0;
  const mod = 1_000_000_000n;
  for (const ch of token) {
    const d = toBase36Digit(ch);
    if (d === null) {
      continue;
    }
    hash = (hash * 37n + BigInt(d + 1)) % mod;
    used += 1;
  }

  if (used === 0) {
    return undefined;
  }
  return hash.toString().padStart(9, "0");
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    if (key in record) {
      const n = toNumber(record[key]);
      if (n !== null) {
        return n;
      }
    }
  }
  return undefined;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (key in record) {
      const value = toStringOrUndefined(record[key]);
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function pickAny(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }
  return undefined;
}

function inferEuclidTypeLabel(record: Record<string, unknown>): string {
  const explicit = pickString(record, ["TYPE", "type", "OBJECT_CLASS", "object_class", "CLASS", "class"]);
  if (explicit) {
    return explicit;
  }
  return "";
}

function normalizeType(value: unknown, fallback = "unknown"): string {
  const maybe = toStringOrUndefined(value);
  return maybe ?? fallback;
}

function fluxToMagNanomaggy(flux: number | null): number | null {
  if (flux === null || !Number.isFinite(flux) || flux <= 0) {
    return null;
  }
  return Number((22.5 - 2.5 * Math.log10(flux)).toFixed(6));
}

function fluxToMagEuclidMuJy(flux: number | null): number | null {
  if (flux === null || !Number.isFinite(flux) || flux <= 0) {
    return null;
  }
  return Number((23.9 - 2.5 * Math.log10(flux)).toFixed(6));
}

function tileCacheKey(ra: number, dec: number, catalogPath?: string): string {
  const pathPart = catalogPath ? `path=${catalogPath}` : "path=<none>";
  return `${pathPart}|ra=${ra.toFixed(8)}|dec=${dec.toFixed(8)}`;
}

function extractTileIdFromPath(catalogPath?: string): string | undefined {
  if (!catalogPath || catalogPath.trim().length === 0) {
    return undefined;
  }
  const patterns = [
    /TILE(\d{6,12})/i,
    /FINAL[_-]CATALOG[_-](\d{6,12})/i,
    /(?:^|[_\-/])(\d{9})(?:[_\-.]|$)/
  ];
  for (const pattern of patterns) {
    const matched = catalogPath.match(pattern);
    if (matched && matched[1]) {
      return normalizeTileId(matched[1]);
    }
  }
  return undefined;
}

async function resolveTileIdByCoord(ra: number, dec: number, catalogPath?: string): Promise<{ tile_id?: string; source: string }> {
  const tileFromPath = extractTileIdFromPath(catalogPath);
  if (tileFromPath) {
    return {
      tile_id: tileFromPath,
      source: "euclid.s3_path_filename"
    };
  }

  const key = tileCacheKey(ra, dec, catalogPath);
  const cached = tileResolveCache.get(key);
  if (cached) {
    return cached;
  }

  try {
    const payload = await callMcpTool(EUCLID_SERVER, "resolve_tile_id", {
      ra,
      dec
    }) as Record<string, unknown>;

    const mapping = (payload.mapping as Record<string, unknown> | undefined) ?? {};
    const rawTile = toStringOrUndefined(payload.tile_id)
      ?? toStringOrUndefined(mapping.tile_id)
      ?? toStringOrUndefined(mapping.tileId);
    const tile_id_direct = normalizeTileId(rawTile);
    const tile_id = tile_id_direct ?? (rawTile ? deriveNumericTileId(rawTile) : undefined);
    const method = toStringOrUndefined(mapping.method) ?? "resolve_tile_id";
    const source = tile_id
      ? `euclid.resolve_tile_id:${method}${tile_id_direct ? "" : ":normalized_non_numeric"}`
      : "pending_ra_dec_to_tile_mapping";
    const resolved = { tile_id, source };
    tileResolveCache.set(key, resolved);
    return resolved;
  } catch {
    const unresolved = { tile_id: undefined, source: "pending_ra_dec_to_tile_mapping" };
    tileResolveCache.set(key, unresolved);
    return unresolved;
  }
}

function buildFallbackEuclidFromCoord(coord: Coord): CatalogRecord[] {
  return [{
    catalog: "euclid",
    object_id: `EUCLID_POINT_${coord.ra_deg.toFixed(6)}_${coord.dec_deg.toFixed(6)}`,
    obj_id: `EUCLID_POINT_${coord.ra_deg.toFixed(6)}_${coord.dec_deg.toFixed(6)}`,
    ra_deg: coord.ra_deg,
    dec_deg: coord.dec_deg,
    mag: 99,
    mag_proxy: 99,
    type: "unknown",
    class_label: "unknown"
  }];
}

export async function extractCoordFromS3Mcp(uri: string): Promise<Coord> {
  if (!uri.startsWith("s3://")) {
    throw new Error("S3 input must use s3://bucket/key format.");
  }

  const infoRaw = await callMcpTool(EUCLID_SERVER, "get_catalog_info_with_stats", {
    catalog_path: uri
  }) as Record<string, unknown>;

  const info = unwrapEuclidToolPayload(infoRaw);
  const infoError = getToolError(infoRaw);

  const ranges = (info.coordinate_ranges as Record<string, unknown> | undefined) ?? {};
  const raMin = toNumber(ranges.ra_min);
  const raMax = toNumber(ranges.ra_max);
  const decMin = toNumber(ranges.dec_min);
  const decMax = toNumber(ranges.dec_max);

  if (raMin !== null && raMax !== null && decMin !== null && decMax !== null) {
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

  const rowsRaw = await callMcpTool(EUCLID_SERVER, "get_catalog_objects", {
    catalog_path: uri,
    start: 0,
    limit: 256,
    columns: ["RIGHT_ASCENSION", "DECLINATION"]
  }) as Record<string, unknown>;
  const objects = getEuclidObjects(rowsRaw);
  const objectsError = getToolError(rowsRaw);

  let raMinFallback = Number.POSITIVE_INFINITY;
  let raMaxFallback = Number.NEGATIVE_INFINITY;
  let decMinFallback = Number.POSITIVE_INFINITY;
  let decMaxFallback = Number.NEGATIVE_INFINITY;

  for (const obj of objects) {
    const { ra, dec } = pickCoord(obj);
    if (ra === null || dec === null) {
      continue;
    }
    if (ra < raMinFallback) raMinFallback = ra;
    if (ra > raMaxFallback) raMaxFallback = ra;
    if (dec < decMinFallback) decMinFallback = dec;
    if (dec > decMaxFallback) decMaxFallback = dec;
  }

  if (
    !Number.isFinite(raMinFallback)
    || !Number.isFinite(raMaxFallback)
    || !Number.isFinite(decMinFallback)
    || !Number.isFinite(decMaxFallback)
  ) {
    const tileId = extractTileIdFromPath(uri);
    if (tileId) {
      const tileCoord = await extractCoordFromTileIndexViaAstro(tileId);
      if (tileCoord) {
        return {
          ...tileCoord,
          s3_path: uri,
          source: "astro_k3s_mcp.euclid_tile_index_fallback"
        };
      }
    }

    const reasons = [
      infoError ? `get_catalog_info_with_stats_error=${infoError}` : null,
      objectsError ? `get_catalog_objects_error=${objectsError}` : null
    ].filter((v): v is string => v !== null);
    const detail = reasons.length > 0 ? ` (${reasons.join("; ")})` : "";
    throw new Error(`Euclid MCP did not return coordinate_ranges and no valid RA/DEC rows were found in S3 objects${detail}.`);
  }

  return {
    ra_deg: (raMinFallback + raMaxFallback) / 2,
    dec_deg: (decMinFallback + decMaxFallback) / 2,
    ra_min: raMinFallback,
    ra_max: raMaxFallback,
    dec_min: decMinFallback,
    dec_max: decMaxFallback,
    s3_path: uri,
    num_objects: objects.length,
    source: "mcp_s3_reader_objects_fallback"
  };
}

async function extractCoordFromTileIndexViaAstro(tileId: string): Promise<Coord | null> {
  const payload = await callMcpTool(ASTRO_SERVER, "es_query", {
    catalog: "euclid-q1-mer-final",
    mode: "search",
    body: {
      query: buildEuclidTileLookupQuery(tileId),
      from: 0,
      size: 1000,
      _source: ["RIGHT_ASCENSION", "DECLINATION", "TILE_INDEX", "TILEID", "SEGMENTATION_MAP_ID"]
    }
  }) as Record<string, unknown>;

  const hitRows = getHitRows(payload);
  let raMin = Number.POSITIVE_INFINITY;
  let raMax = Number.NEGATIVE_INFINITY;
  let decMin = Number.POSITIVE_INFINITY;
  let decMax = Number.NEGATIVE_INFINITY;
  let count = 0;

  for (const hit of hitRows) {
    const source = (hit._source as Record<string, unknown> | undefined) ?? hit;
    const { ra, dec } = pickCoord(source);
    if (ra === null || dec === null) {
      continue;
    }
    if (ra < raMin) raMin = ra;
    if (ra > raMax) raMax = ra;
    if (dec < decMin) decMin = dec;
    if (dec > decMax) decMax = dec;
    count += 1;
  }

  if (!Number.isFinite(raMin) || !Number.isFinite(raMax) || !Number.isFinite(decMin) || !Number.isFinite(decMax)) {
    return null;
  }

  return {
    ra_deg: (raMin + raMax) / 2,
    dec_deg: (decMin + decMax) / 2,
    ra_min: raMin,
    ra_max: raMax,
    dec_min: decMin,
    dec_max: decMax,
    num_objects: getHitsTotal(payload) || count,
    source: "astro_k3s_mcp.euclid_tile_index"
  };
}

function mapEuclidCatalogRecord(source: Record<string, unknown>, fallbackObjectId: string): CatalogRecord | null {
  const { ra, dec } = pickCoord(source);
  if (ra === null || dec === null) {
    return null;
  }

  let tileIndex = normalizeTileId(
    source.TILE_INDEX
    ?? source.tile_index
    ?? source.TILEID
    ?? source.tileid
  );
  if (!tileIndex) {
    tileIndex = extractTileIdFromPath(toStringOrUndefined(source.source_path));
  }

  return {
    catalog: "euclid",
    object_id: String(
      source.OBJECT_ID
      ?? source.object_id
      ?? source.SOURCE_ID
      ?? source.source_id
      ?? source.TARGET_ID
      ?? source.target_id
      ?? fallbackObjectId
    ),
    obj_id: String(
      source.OBJECT_ID
      ?? source.object_id
      ?? source.SOURCE_ID
      ?? source.source_id
      ?? source.TARGET_ID
      ?? source.target_id
      ?? fallbackObjectId
    ),
    ra_deg: ra,
    dec_deg: dec,
    mag: fluxToMagEuclidMuJy(toNumber(source.FLUX_VIS_1FWHM_APER))
      ?? firstFinite([
        source.MAG_VIS,
        source.mag_vis,
        source.MAG_AUTO,
        source.mag_auto,
        source.mag,
        source.MAG
      ]),
    mag_proxy: fluxToMagEuclidMuJy(toNumber(source.FLUX_VIS_1FWHM_APER))
      ?? firstFinite([
        source.MAG_VIS,
        source.mag_vis,
        source.MAG_AUTO,
        source.mag_auto,
        source.mag,
        source.MAG
      ]),
    type: normalizeType(inferEuclidTypeLabel(source), ""),
    class_label: String(
      source.EXTENDED_FLAG
      ?? source.extended_flag
      ?? source.type
      ?? source.TYPE
      ?? "unknown"
    ),
    tile_index: tileIndex,
    tile_index_source: tileIndex ? "euclid.native_field" : "pending_ra_dec_to_tile_mapping",
    maskbits: toNumber(source.MASKBITS ?? source.maskbits) ?? undefined,
    seg_area: toNumber(
      source.SEGMENTATION_AREA
      ?? source.segmentation_area
      ?? source.SEG_AREA
      ?? source.seg_area
    ) ?? undefined,
    det_quality_flag: toNumber(source.DET_QUALITY_FLAG ?? source.det_quality_flag) ?? undefined,
    flag_vis: toNumber(source.FLAG_VIS ?? source.flag_vis) ?? undefined,
    point_like_flag: toNumber(source.POINT_LIKE_FLAG ?? source.point_like_flag) ?? undefined,
    extended_flag: toNumber(source.EXTENDED_FLAG ?? source.extended_flag) ?? undefined,
    semimajor_axis: toNumber(source.SEMIMAJOR_AXIS ?? source.semimajor_axis) ?? undefined,
    flux_segmentation: toNumber(source.FLUX_SEGMENTATION ?? source.flux_segmentation) ?? undefined,
    flux_vis_1fwhm_aper: toNumber(source.FLUX_VIS_1FWHM_APER ?? source.flux_vis_1fwhm_aper) ?? undefined,
    flux_vis_2fwhm_aper: toNumber(source.FLUX_VIS_2FWHM_APER ?? source.flux_vis_2fwhm_aper) ?? undefined,
    flux_vis_3fwhm_aper: toNumber(source.FLUX_VIS_3FWHM_APER ?? source.flux_vis_3fwhm_aper) ?? undefined,
    flux_vis_4fwhm_aper: toNumber(source.FLUX_VIS_4FWHM_APER ?? source.flux_vis_4fwhm_aper) ?? undefined,
    flux_vis_psf: toNumber(source.FLUX_VIS_PSF ?? source.flux_vis_psf) ?? undefined,
    flux_vis_sersic: toNumber(source.FLUX_VIS_SERSIC ?? source.flux_vis_sersic) ?? undefined
  };
}

async function queryEuclidRowsByTileIndexViaAstro(tileId: string, topK: number): Promise<CatalogRecord[]> {
  const payload = await callMcpTool(ASTRO_SERVER, "es_query", {
    catalog: "euclid-q1-mer-final",
    mode: "search",
    body: {
      query: buildEuclidTileLookupQuery(tileId),
      from: 0,
      size: topK
    }
  }) as Record<string, unknown>;

  const hitRows = getHitRows(payload);
  const rows: CatalogRecord[] = [];

  for (const hit of hitRows) {
    const source = (hit._source as Record<string, unknown> | undefined) ?? hit;
    const mapped = mapEuclidCatalogRecord(source, `EUCLID_${rows.length + 1}`);
    if (mapped) {
      mapped.tile_index = mapped.tile_index ?? tileId;
      mapped.tile_index_source = mapped.tile_index_source === "euclid.native_field" ? mapped.tile_index_source : "euclid.s3_path_filename";
      rows.push(mapped);
    }
  }

  return rows;
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
      const mapped = mapEuclidCatalogRecord(source, String(hitObj._id ?? `EUCLID_${rows.length + 1}`));
      if (!mapped) {
        continue;
      }

      if (!mapped.tile_index) {
        const resolvedTile = await resolveTileIdByCoord(mapped.ra_deg, mapped.dec_deg);
        mapped.tile_index = resolvedTile.tile_id;
        mapped.tile_index_source = resolvedTile.source;
      }

      rows.push(mapped);
    }

    return rows;
  }

  const preferredFields = [
    "OBJECT_ID",
    "RIGHT_ASCENSION",
    "DECLINATION",
    "TYPE",
    "TILE_INDEX",
    "TILEID",
    "MASKBITS",
    "SEGMENTATION_AREA",
    "SEG_AREA",
    "SEMIMAJOR_AXIS",
    "FLUX_SEGMENTATION",
    "FLUX_VIS_1FWHM_APER",
    "FLUX_VIS_2FWHM_APER",
    "FLUX_VIS_3FWHM_APER",
    "FLUX_VIS_4FWHM_APER",
    "FLUX_VIS_PSF",
    "FLUX_VIS_SERSIC",
    "DET_QUALITY_FLAG",
    "FLAG_VIS",
    "POINT_LIKE_FLAG",
    "EXTENDED_FLAG",
    "MAG_VIS",
    "MAG_AUTO",
    "MAG"
  ];

  const selectableColumns = await getS3SelectableColumns(coord.s3_path, preferredFields) ?? preferredFields;
  const payload = await callMcpTool(EUCLID_SERVER, "get_catalog_objects", {
    catalog_path: coord.s3_path,
    start: 0,
    limit: topK,
    columns: selectableColumns
  }) as Record<string, unknown>;

  const objects = getEuclidObjects(payload);
  const objectsError = getToolError(payload);
  const rows: CatalogRecord[] = [];

  for (const obj of objects) {
    if (typeof obj !== "object" || obj === null) {
      continue;
    }
    const record = obj as Record<string, unknown>;
    const ra = pickNumber(record, ["RIGHT_ASCENSION", "right_ascension", "RA", "ra"]);
    const dec = pickNumber(record, ["DECLINATION", "declination", "DEC", "dec"]);
    if (ra === undefined || dec === undefined) {
      continue;
    }

    let tileIndex = normalizeTileId(
      record.TILE_INDEX
      ?? record.tile_index
      ?? record.TILEID
      ?? record.tileid
    );
    let tileIndexSource = tileIndex ? "euclid.native_field" : "pending_ra_dec_to_tile_mapping";
    if (!tileIndex) {
      const resolvedTile = await resolveTileIdByCoord(ra, dec, coord.s3_path);
      tileIndex = resolvedTile.tile_id;
      tileIndexSource = resolvedTile.source;
    }

    const mapped = mapEuclidCatalogRecord(record, `EUCLID_${rows.length + 1}`);
    if (!mapped) {
      continue;
    }

    mapped.tile_index = tileIndex;
    mapped.tile_index_source = tileIndexSource;
    rows.push(mapped);
  }

  if (rows.length > 0) {
    return rows;
  }

  const tileId = extractTileIdFromPath(coord.s3_path);
  if (tileId) {
    const fallbackRows = await queryEuclidRowsByTileIndexViaAstro(tileId, topK);
    if (fallbackRows.length > 0) {
      return fallbackRows;
    }
  }

  if (objectsError) {
    return [];
  }
  return rows;
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
  const rows = mapDesiRowsFromHitRows(hitRows);
  const sampleRows = mapDesiSampleRows(samplePayload);

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

export async function queryDesiByBricknamesWithDetails(
  bricknames: string[],
  topK: number
): Promise<DesiQueryDetails> {
  const unique = [...new Set(bricknames.map((b) => b.trim()).filter((b) => b.length > 0))];
  if (unique.length === 0) {
    return {
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
        storage_hint: "es-index",
        source_path: null,
        source_path_field: null,
        note: "DESI brickname query skipped: empty brickname list"
      }
    };
  }

  const size = Math.min(5000, Math.max(topK, unique.length * 50));
  const queryBody = {
    query: {
      bool: {
        filter: [
          { terms: { brickname: unique } },
          { term: { brick_primary: true } }
        ]
      }
    },
    from: 0,
    size
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
      "brickname",
      "brickid",
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
  const rows = mapDesiRowsFromHitRows(hitRows);
  const sampleRows = mapDesiSampleRows(samplePayload);

  const firstSource = hitRows.length > 0
    ? (((hitRows[0]._source as Record<string, unknown> | undefined) ?? hitRows[0]) as Record<string, unknown>)
    : {};
  const sourcePath = detectSourcePath(firstSource);

  return {
    rows,
    hitsTotal: getHitsTotal(payload),
    queryWindow: {
      ra_min: Number.NaN,
      ra_max: Number.NaN,
      dec_min: Number.NaN,
      dec_max: Number.NaN
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
      note: `DESI query by brickname terms (count=${unique.length})`
    }
  };
}
