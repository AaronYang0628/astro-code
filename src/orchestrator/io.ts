import fs from "node:fs";
import path from "node:path";

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes("\n") || text.includes("\"")) {
    return `"${text.replaceAll("\"", "\"\"")}"`;
  }
  return text;
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function writeCsv(filePath: string, rows: Record<string, unknown>[], headersOverride?: string[]): void {
  const headers = headersOverride && headersOverride.length > 0
    ? headersOverride
    : (rows.length > 0 ? Object.keys(rows[0]) : []);

  if (headers.length === 0) {
    fs.writeFileSync(filePath, "");
    return;
  }

  const lines: string[] = [headers.join(",")];

  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

export function writeReport(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

export function createRunDir(rootRunsDir: string): { runId: string; runDir: string } {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const runId = `run_${stamp}_${Math.random().toString(36).slice(2, 8)}`;
  const runDir = path.resolve(rootRunsDir, runId);
  ensureDir(runDir);
  return { runId, runDir };
}
