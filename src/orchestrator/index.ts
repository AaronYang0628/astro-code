import path from "node:path";
import { runMvpPipeline } from "./runner.js";

function toMarkdownTable(rows: Record<string, unknown>[], headers: string[]): string {
  if (rows.length === 0 || headers.length === 0) {
    return "";
  }

  const headerLine = `| ${headers.join(" | ")} |`;
  const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => {
    const cells = headers.map((h) => {
      const value = row[h];
      return String(value ?? "").replaceAll("|", "\\|");
    });
    return `| ${cells.join(" | ")} |`;
  });

  return [headerLine, sepLine, ...body].join("\n");
}

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const configPath = argValue("--pipeline-config") ?? argValue("--config") ?? "pipeline.config.yaml";
  const playbookPath = argValue("--playbook") ?? "playbooks/euclid_desi_mvp.playbook.md";
  const requestPath = argValue("--request") ?? "examples/request.radec.json";

  const result = await runMvpPipeline({
    configPath: path.resolve(configPath),
    playbookPath: path.resolve(playbookPath),
    requestPath: path.resolve(requestPath),
    progress: (line) => {
      process.stdout.write(`[progress] ${line}\n`);
    }
  });

  process.stdout.write(`Run complete: ${result.runId}\n`);
  process.stdout.write(`Output dir: ${result.runDir}\n`);
  process.stdout.write(`Execution mode: ${result.summary.executionMode}\n`);
  process.stdout.write(`Run mode: ${result.summary.mode}\n`);
  process.stdout.write(`Matching params: RA=${result.summary.raDeg}, DEC=${result.summary.decDeg}, radiusArcsec=${result.summary.radiusArcsec}, topK=${result.summary.topK}, desiHits=${result.summary.desiHits}\n`);
  process.stdout.write(`Crossmatch rows: ${result.summary.crossmatchRows}\n`);
  process.stdout.write(`Preview rows: ${result.summary.previewRows}\n`);
  process.stdout.write(`Filtered rows: ${result.summary.filteredRows}\n`);
  process.stdout.write(`Human gate mode: ${result.summary.humanGateMode}\n`);
  process.stdout.write(`Available filter fields: ${(result.summary.availableFilterFields ?? []).join(", ") || "n/a"}\n`);
  if ((result.summary.previewSample ?? []).length > 0) {
    process.stdout.write("Preview sample (markdown table):\n");
    const headers = result.summary.availableFilterFields ?? [];
    const table = toMarkdownTable((result.summary.previewSample ?? []).slice(0, 10), headers);
    process.stdout.write(`${table}\n`);
  }
  process.stdout.write(`Input manifest: ${result.artifacts.inputManifestJson}\n`);
  if (result.artifacts.crossmatchCsv) {
    process.stdout.write(`Crossmatch CSV: ${result.artifacts.crossmatchCsv}\n`);
  }
  if (result.artifacts.desiOriginJson) {
    process.stdout.write(`DESI origin: ${result.artifacts.desiOriginJson}\n`);
  }
  if (result.artifacts.desiSearchQueryJson) {
    process.stdout.write(`DESI query JSON: ${result.artifacts.desiSearchQueryJson}\n`);
  }
  if (result.artifacts.desiSearchInitialRawJson) {
    process.stdout.write(`DESI raw initial: ${result.artifacts.desiSearchInitialRawJson}\n`);
  }
  if (result.artifacts.desiSearchSampleRawJson) {
    process.stdout.write(`DESI raw sample: ${result.artifacts.desiSearchSampleRawJson}\n`);
  }
  if (result.artifacts.desiSearchRetryRawJson) {
    process.stdout.write(`DESI raw retry: ${result.artifacts.desiSearchRetryRawJson}\n`);
  }
  if (result.artifacts.desiSearchRetrySampleRawJson) {
    process.stdout.write(`DESI raw retry sample: ${result.artifacts.desiSearchRetrySampleRawJson}\n`);
  }
  process.stdout.write(`Status JSON: ${result.artifacts.statusJson}\n`);
  if (result.artifacts.previewCsv) {
    process.stdout.write(`Preview CSV: ${result.artifacts.previewCsv}\n`);
  }
  if (result.artifacts.previewSummaryJson) {
    process.stdout.write(`Preview summary: ${result.artifacts.previewSummaryJson}\n`);
  }
  if (result.artifacts.filteredCsv) {
    process.stdout.write(`Filtered CSV: ${result.artifacts.filteredCsv}\n`);
  }
  process.stdout.write(`Report: ${result.artifacts.reportMd}\n`);
  process.stdout.write(`Result index: ${result.artifacts.resultIndexJson}\n`);
  if (result.artifacts.regionAdjustRequestJson) {
    process.stdout.write(`Region adjust request: ${result.artifacts.regionAdjustRequestJson}\n`);
  }
  if (result.artifacts.humanGateRequestJson) {
    process.stdout.write(`Human filter request: ${result.artifacts.humanGateRequestJson}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
