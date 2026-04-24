import type { Coord, InputSpec } from "./types.js";
import { extractCoordFromDesiS3Input, extractCoordFromS3Mcp } from "./mcp.js";

function parseNumber(value: string): number {
  const n = Number(value.trim());
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return n;
}

export function parseRaDecText(value: string): Coord {
  const cleaned = value.replace(/\s+/g, " ").trim();
  const parts = cleaned.includes(",") ? cleaned.split(",") : cleaned.split(" ");
  if (parts.length < 2) {
    throw new Error("RA/DEC text must include two numeric values.");
  }

  const ra = parseNumber(parts[0]);
  const dec = parseNumber(parts[1]);
  if (ra < 0 || ra >= 360) {
    throw new Error("RA must be in [0, 360).");
  }
  if (dec < -90 || dec > 90) {
    throw new Error("DEC must be in [-90, 90].");
  }

  return { ra_deg: ra, dec_deg: dec, source: "radec_text" };
}

export async function extractCoord(
  input: InputSpec,
  pythonBin: string,
  options?: {
    workflow?: string;
    topK?: number;
    desiCatalog?: "desi-dr10-tractor" | "desi-dr9-tractor";
  }
): Promise<Coord> {
  if (input.type === "radec_text") {
    return parseRaDecText(input.value);
  }

  if (input.type === "s3_uri") {
    const workflow = (options?.workflow ?? "").trim().toLowerCase();
    if (workflow.includes("desi_cutout")) {
      return extractCoordFromDesiS3Input(input.value, pythonBin, {
        topK: options?.topK,
        catalog: options?.desiCatalog
      });
    }
    return extractCoordFromS3Mcp(input.value);
  }

  throw new Error(`Unsupported input type: ${String(input.type)}. Supported: radec_text, s3_uri.`);
}
