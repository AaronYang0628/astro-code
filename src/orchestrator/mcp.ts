import type { CatalogRecord, Coord } from "./types.js";

function hashSeed(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export async function extractCoordFromS3Mcp(uri: string): Promise<Coord> {
  if (!uri.startsWith("s3://")) {
    throw new Error("S3 input must use s3://bucket/key format.");
  }

  const random = seededRandom(hashSeed(uri));
  const ra = Number((random() * 360).toFixed(6));
  const dec = Number(((random() * 180) - 90).toFixed(6));

  return {
    ra_deg: ra,
    dec_deg: dec,
    source: "mcp_s3_reader"
  };
}

export async function queryCatalogMcp(catalog: "euclid" | "desi", coord: Coord, topK: number): Promise<CatalogRecord[]> {
  const random = seededRandom(hashSeed(`${catalog}:${coord.ra_deg}:${coord.dec_deg}`));
  const rows: CatalogRecord[] = [];

  for (let i = 0; i < topK; i += 1) {
    const raJitter = (random() - 0.5) / 300;
    const decJitter = (random() - 0.5) / 300;
    rows.push({
      catalog,
      object_id: `${catalog.toUpperCase()}_${String(i + 1).padStart(5, "0")}`,
      ra_deg: Number((coord.ra_deg + raJitter).toFixed(7)),
      dec_deg: Number((coord.dec_deg + decJitter).toFixed(7)),
      mag: Number((16 + random() * 8).toFixed(3)),
      class_label: random() > 0.75 ? "galaxy" : "star"
    });
  }

  return rows;
}
