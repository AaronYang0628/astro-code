import path from "node:path";
import fs from "node:fs";
import { runMvpPipeline } from "./runner.js";
import { loadConfig } from "./config.js";
import type { RunArtifacts, RunSummary } from "./types.js";

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

function candidatePoolPath(artifacts: RunArtifacts): string | undefined {
  return artifacts.candidatePoolCsv;
}

function candidatePoolRows(summary: RunSummary): number | undefined {
  return summary.candidatePoolRows;
}

function mapWorkflowToPlaybook(workflow: string): string | undefined {
  const w = workflow.trim().toLowerCase();
  if (w === "euclid_desi_crossmatch") {
    return "playbooks/euclid_desi_mvp.playbook.md";
  }
  if (w === "euclid_cutout") {
    return "playbooks/euclid_cutout_mvp.playbook.md";
  }
  if (w === "desi_cutout") {
    return "playbooks/desi_cutout_mvp.playbook.md";
  }
  return undefined;
}

async function main(): Promise<void> {
  const configPath = argValue("--pipeline-config") ?? argValue("--config") ?? "pipeline.config.yaml";
  const config = loadConfig(path.resolve(configPath));
  const requestPath = argValue("--request") ?? "examples/request.radec.json";

  let workflowPlaybook: string | undefined;
  let requestWorkflow: string | undefined;
  try {
    const rawRequest = JSON.parse(fs.readFileSync(path.resolve(requestPath), "utf8")) as Record<string, unknown>;
    requestWorkflow = typeof rawRequest.workflow === "string" ? rawRequest.workflow : undefined;
    workflowPlaybook = requestWorkflow ? mapWorkflowToPlaybook(requestWorkflow) : undefined;
  } catch {
    workflowPlaybook = undefined;
    requestWorkflow = undefined;
  }

  const playbookPath = argValue("--playbook")
    ?? workflowPlaybook
    ?? config.paths.default_playbook;

  process.stdout.write(`Playbook selected: ${path.resolve(playbookPath)}\n`);
  if (requestWorkflow && !workflowPlaybook) {
    process.stdout.write(`Workflow not mapped, fallback to default playbook: ${requestWorkflow}\n`);
  }

  const result = await runMvpPipeline({
    configPath: path.resolve(configPath),
    playbookPath: path.resolve(playbookPath),
    requestPath: path.resolve(requestPath),
    progress: (line) => {
      process.stdout.write(`[progress] ${line}\n`);
    }
  });

  process.stdout.write(`Run complete: ${result.runId}\n`);
  if (requestWorkflow && result.summary.selectionRequired) {
    process.stdout.write("Web interaction note: run is waiting for explicit six-condition selection plan before final export.\n");
  }
  process.stdout.write(`Output dir: ${result.runDir}\n`);
  process.stdout.write(`Execution mode: ${result.summary.executionMode}\n`);
  process.stdout.write(`Run mode: ${result.summary.mode}\n`);
  process.stdout.write(`Matching params: RA=${result.summary.raDeg}, DEC=${result.summary.decDeg}, radiusArcsec=${result.summary.radiusArcsec}, topK=${result.summary.topK}, desiHits=${result.summary.desiHits}\n`);
  process.stdout.write(`Candidate pool rows: ${candidatePoolRows(result.summary)}\n`);
  process.stdout.write(`Preview rows: ${result.summary.previewRows}\n`);
  process.stdout.write(`Filtered rows: ${result.summary.filteredRows}\n`);
  process.stdout.write(`Cutout enabled: ${result.summary.cutoutEnabled ? "yes" : "no"}\n`);
  if (result.summary.cutoutEnabled) {
    process.stdout.write(`Cutout groups total: ${result.summary.cutoutGroupsTotal}\n`);
    process.stdout.write(`Cutout success rows: ${result.summary.cutoutSuccessRows}\n`);
    process.stdout.write(`Cutout failed rows: ${result.summary.cutoutFailedRows}\n`);
  }
  process.stdout.write(`Selection required: ${result.summary.selectionRequired ? "yes" : "no"}\n`);
  process.stdout.write(`Human gate mode: ${result.summary.humanGateMode}\n`);
  process.stdout.write(`Available filter fields: ${(result.summary.availableFilterFields ?? []).join(", ") || "n/a"}\n`);
  if ((result.summary.previewSample ?? []).length > 0) {
    process.stdout.write("Preview sample (markdown table):\n");
    const headers = result.summary.availableFilterFields ?? [];
    const table = toMarkdownTable((result.summary.previewSample ?? []).slice(0, 10), headers);
    process.stdout.write(`${table}\n`);
  }
  process.stdout.write(`Input manifest: ${result.artifacts.inputManifestJson}\n`);
  const candidatePoolCsv = candidatePoolPath(result.artifacts);
  if (candidatePoolCsv) {
    process.stdout.write(`Candidate pool CSV: ${candidatePoolCsv}\n`);
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
  if (result.artifacts.selectionFinalCsv) {
    process.stdout.write(`Selection final CSV: ${result.artifacts.selectionFinalCsv}\n`);
  }
  if (result.artifacts.selectionReportJson) {
    process.stdout.write(`Selection report JSON: ${result.artifacts.selectionReportJson}\n`);
  }
  if (result.artifacts.cutoutIndexCsv) {
    process.stdout.write(`Cutout index CSV: ${result.artifacts.cutoutIndexCsv}\n`);
  }
  if (result.artifacts.cutoutReportJson) {
    process.stdout.write(`Cutout report JSON: ${result.artifacts.cutoutReportJson}\n`);
  }
  if (result.artifacts.cutoutRawReportsJson) {
    process.stdout.write(`Cutout raw reports JSON: ${result.artifacts.cutoutRawReportsJson}\n`);
  }
  if (result.artifacts.selectionPlanRequestJson) {
    process.stdout.write(`Selection plan request: ${result.artifacts.selectionPlanRequestJson}\n`);
  }
  if (result.artifacts.selectionPlanResponseJson) {
    process.stdout.write(`Selection plan response: ${result.artifacts.selectionPlanResponseJson}\n`);
  }
  process.stdout.write(`Report: ${result.artifacts.reportMd}\n`);
  process.stdout.write(`Result index: ${result.artifacts.resultIndexJson}\n`);
  if (result.artifacts.regionAdjustRequestJson) {
    process.stdout.write(`Region adjust request: ${result.artifacts.regionAdjustRequestJson}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
