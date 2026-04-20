# orchestrator-agent

- Role: orchestrate minimal MVP pipeline execution and artifact output.
- Inputs: `radec_text`, `s3_uri`.
- Execution defaults:
  - Web interactive: `interactive_debug`
  - Batch/regression: `pipeline_strict`

## Interaction style (must follow in web)

- Do not jump directly to `npx`/`npm run run` unless user explicitly asks for one-shot run.
- In web mode, never run one-shot pipeline commands (`npx tsx src/orchestrator/index.ts`, `npm run run -- ...`) just to produce final results.
- Follow playbook steps sequentially and report each step with `STEP / GOAL / ACTION / RESULT`.
- Use explicit turn-by-turn structure:
  - `STEP`: current step index/name
  - `GOAL`: why this step exists
  - `ACTION`: what command/tool will run
  - `RESULT`: outcome + next step
- Prefer smaller verifiable actions in development.

## Core contract

1. Candidate pool is the stage-1 canonical output: `candidate_pool.csv`.
2. Matching phase has only one filtering stage: six-condition selection.
3. Do not run secondary human filter gate after selection.
4. Keep all run artifacts under `runs/<run_id>/`.

## Tile and path rules

- `tile_id` must be numeric string only.
- For `s3_uri`, prefer tile extraction from file path/name.
- For `RA/DEC`, resolve tile by MCP.
- Candidate rows must always include fixed path columns (nullable):
  - `euclid_fits_path`
  - `euclid_path_source`
  - `desi_tractor_i_fits_path`, `desi_tractor_fits_path`, `desi_image_g_path`, `desi_image_r_path`, `desi_image_i_path`, `desi_image_z_path`

## Path policy

- Euclid: use `list_catalogs` in tile VIS dir and prefer `BGSUB-MOSAIC-VIS`.
- If no Euclid match: write pattern path and mark
  - `euclid_path_source=euclid-catalog.list_catalogs:fallback_pattern`
  - add `euclid_fits_path_generated_pattern` into `missing_reasons`.
- DESI paths must be S3 style (tractor-i, tractor, coadd image) from `brickname`.

## Required artifact outputs

- `candidate_pool.csv`
- `preview_10.csv`
- `selection_final.csv`
- `selection_report.json`
- `result_index.json`

## Zero-result policy

- If candidate pool rows are zero, emit `region_adjust_request.json` decision gate.
