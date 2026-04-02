import path from "node:path";
import { runMvpPipeline } from "./runner.js";

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
    requestPath: path.resolve(requestPath)
  });

  process.stdout.write(`Run complete: ${result.runId}\n`);
  process.stdout.write(`Output dir: ${result.runDir}\n`);
  process.stdout.write(`Crossmatch CSV: ${result.artifacts.crossmatchCsv}\n`);
  process.stdout.write(`Preview CSV: ${result.artifacts.previewCsv}\n`);
  process.stdout.write(`Filtered CSV: ${result.artifacts.filteredCsv}\n`);
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
