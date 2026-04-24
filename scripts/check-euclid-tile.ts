import { localEuclidTileRegistryPath, localEuclidTileRegistrySize, resolveLocalEuclidTileId } from "../src/orchestrator/euclid-tiles.js";

function usage(): string {
  return [
    "Usage:",
    "  npm run check:euclid-tile -- --ra <degrees> --dec <degrees>",
    "",
    "Examples:",
    "  npm run check:euclid-tile -- --ra 56.8 --dec -50.9",
    "  npm run check:euclid-tile -- --ra 14.6 --dec -5.2"
  ].join("\n");
}

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[idx + 1];
}

function parseNumberArg(flag: string): number {
  const raw = argValue(flag);
  if (!raw) {
    throw new Error(`Missing required argument: ${flag}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric value for ${flag}: ${raw}`);
  }
  return n;
}

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const ra = parseNumberArg("--ra");
  const dec = parseNumberArg("--dec");
  const tileId = resolveLocalEuclidTileId(ra, dec);

  process.stdout.write(`Registry path: ${localEuclidTileRegistryPath()}\n`);
  process.stdout.write(`Registry tiles: ${localEuclidTileRegistrySize()}\n`);
  process.stdout.write(`Input: ra=${ra}, dec=${dec}\n`);
  process.stdout.write(`tile_id: ${tileId ?? ""}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exit(1);
}
