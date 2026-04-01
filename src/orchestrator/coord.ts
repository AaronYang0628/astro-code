import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Coord, InputSpec } from "./types.js";
import { extractCoordFromS3Mcp } from "./mcp.js";

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

export function extractCoordFromFileWithPython(filePath: string, pythonBin: string): Coord {
  const proc = spawnSync(
    pythonBin,
    ["py/workers/extract_radec.py", "--file", filePath],
    { encoding: "utf8" }
  );

  if (proc.status !== 0) {
    throw new Error(`Python extractor failed: ${proc.stderr || proc.stdout}`);
  }

  const parsed = JSON.parse(proc.stdout) as Coord;
  if (!Number.isFinite(parsed.ra_deg) || !Number.isFinite(parsed.dec_deg)) {
    throw new Error("Python extractor returned invalid RA/DEC.");
  }
  return parsed;
}

export async function extractCoord(input: InputSpec, pythonBin: string): Promise<Coord> {
  if (input.type === "radec_text") {
    return parseRaDecText(input.value);
  }

  if (input.type === "s3_uri") {
    return extractCoordFromS3Mcp(input.value);
  }

  const coord = extractCoordFromFileWithPython(input.value, pythonBin);
  if (input.transient) {
    try {
      fs.unlinkSync(input.value);
    } catch {
      // Best effort cleanup for transient uploads.
    }
  }
  return coord;
}
