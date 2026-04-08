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

function validateUploadFilePath(filePath: string): void {
  if (!filePath || filePath.trim() === "") {
    throw new Error("File upload path is empty.");
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`Uploaded file not found: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Uploaded path is not a regular file: ${filePath}`);
  }

  const lower = filePath.toLowerCase();
  if (!lower.endsWith(".csv") && !lower.endsWith(".fits") && !lower.endsWith(".fit") && !lower.endsWith(".fts")) {
    throw new Error(`Unsupported upload file type: ${filePath}. Supported: .csv, .fits, .fit, .fts`);
  }
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
  validateUploadFilePath(filePath);

  const proc = spawnSync(
    pythonBin,
    ["py/workers/extract_radec.py", "--file", filePath],
    { encoding: "utf8" }
  );

  if (proc.status !== 0) {
    const stderr = (proc.stderr ?? "").trim();
    const stdout = (proc.stdout ?? "").trim();
    const message = stderr || stdout || "unknown error";
    throw new Error(`Python extractor failed for ${filePath} (exit=${proc.status ?? "null"}): ${message}`);
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
