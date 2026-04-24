import fs from "node:fs";
import path from "node:path";

export interface EuclidTileBox {
  tile_id: string;
  ra_min: number;
  ra_max: number;
  dec_min: number;
  dec_max: number;
}

let cached: EuclidTileBox[] | null = null;

export function localEuclidTileRegistryPath(): string {
  return process.env.EUCLID_TILE_REGISTRY_PATH
    ? path.resolve(process.env.EUCLID_TILE_REGISTRY_PATH)
    : path.resolve("config/euclid_tiles_q1.json");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeRa(ra: number): number {
  const mod = ra % 360;
  return mod < 0 ? mod + 360 : mod;
}

function inRaRange(ra: number, raMin: number, raMax: number): boolean {
  const r = normalizeRa(ra);
  const min = normalizeRa(raMin);
  const max = normalizeRa(raMax);
  if (min <= max) {
    return r >= min && r <= max;
  }
  return r >= min || r <= max;
}

function loadTiles(): EuclidTileBox[] {
  if (cached) {
    return cached;
  }

  const filePath = localEuclidTileRegistryPath();

  if (!fs.existsSync(filePath)) {
    cached = [];
    return cached;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    const rows = Array.isArray(raw) ? raw : [];
    cached = rows
      .map((item) => {
        const obj = item as Record<string, unknown>;
        const tileId = typeof obj.tile_id === "string" ? obj.tile_id.trim() : "";
        const raMin = obj.ra_min;
        const raMax = obj.ra_max;
        const decMin = obj.dec_min;
        const decMax = obj.dec_max;
        if (!/^\d{6,12}$/.test(tileId)) {
          return null;
        }
        if (!isFiniteNumber(raMin) || !isFiniteNumber(raMax) || !isFiniteNumber(decMin) || !isFiniteNumber(decMax)) {
          return null;
        }
        return {
          tile_id: tileId,
          ra_min: raMin,
          ra_max: raMax,
          dec_min: decMin,
          dec_max: decMax
        } satisfies EuclidTileBox;
      })
      .filter((row): row is EuclidTileBox => row !== null);
    return cached;
  } catch {
    cached = [];
    return cached;
  }
}

export function resolveLocalEuclidTileId(ra: number, dec: number): string | undefined {
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
    return undefined;
  }
  const tiles = loadTiles();
  for (const tile of tiles) {
    const inDec = dec >= tile.dec_min && dec <= tile.dec_max;
    if (!inDec) {
      continue;
    }
    if (inRaRange(ra, tile.ra_min, tile.ra_max)) {
      return tile.tile_id;
    }
  }
  return undefined;
}

export function localEuclidTileRegistrySize(): number {
  return loadTiles().length;
}
