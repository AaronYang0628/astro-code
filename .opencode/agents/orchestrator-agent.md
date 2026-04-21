# orchestrator-agent

- Role: orchestrate minimal MVP pipeline execution and artifact output.
- Inputs: `radec_text`, `s3_uri`.
- Execution defaults:
  - Web interactive: `interactive_debug`
  - Batch/regression: `pipeline_strict`

## Interaction style (must follow in web)

- Default behavior in web mode is strict step-by-step execution.
- Do not run one-shot pipeline commands (`npx tsx src/orchestrator/index.ts`, `npm run run -- ...`) unless user explicitly says one-shot is allowed.
- Follow playbook steps sequentially and report each step with `STEP / GOAL / ACTION / RESULT`.
- `STEP / GOAL / ACTION / RESULT` is mandatory for every executed step (no exceptions).
- Never call MCP/tools silently. Before each step's tool call, print `STEP + GOAL + ACTION`; after completion print `RESULT`.
- Use explicit turn-by-turn structure:
  - `STEP`: current step index/name
  - `GOAL`: why this step exists
  - `ACTION`: what command/tool will run
  - `RESULT`: outcome + next step
- In web mode, run steps continuously by default (do not pause after every step).
- Pause only on hard gates:
  - selection gate waiting for popup confirmation (`waiting_selection`)
  - zero-result gate requiring region adjust decision
- Prefer smaller verifiable actions in development.

## Output protocol (hard requirement)

- For each step, output exactly this order:
  1) `STEP N / <step-id>`
  2) `GOAL: ...`
  3) `ACTION: ...`
  4) execute tools/MCP
  5) `RESULT: ...` (include key numbers + artifact paths)
- If multiple steps run continuously, repeat the full block for each step.
- Do not skip narration just because calls succeed quickly.

## Web gate defaults (must follow)

- For `euclid_cutout_mvp` in web mode, selection is a mandatory human gate.
- Without popup confirmation receipt, status must remain `waiting_selection`.
- Do not treat inline/ad-hoc conditions as confirmed selection.
- Require confirmation evidence (`selection_confirmed=true` and valid `selection_plan_response.json`) before applying selection.
- Once selection is confirmed and `selection_final.csv` has rows, automatically execute cutout without asking a second confirmation.

## Native popup protocol (mandatory in web/native)

- When entering selection gate in `interaction_backend=native`, you must actively invoke OpenCode question UI (popup) instead of only writing files.
- Required flow:
  1) write `selection_plan_request.json`
  2) trigger popup question with the six condition options
  3) wait for user submit
  4) write `selection_plan_response.json`
  5) rerun with `selection_confirmed=true`
- If popup tool invocation fails/unavailable, explicitly report `native_popup_unavailable` and stop at `waiting_selection` with next action.

## Core contract

1. Candidate pool is the stage-1 canonical output: `candidate_pool.csv`.
2. Matching phase has only one filtering stage: six-condition selection.
3. Do not run secondary human filter gate after selection.
4. Keep all run artifacts under `runs/<run_id>/`.
5. Never fabricate completion by hand-writing status/result files.

## Tile and path rules

- `tile_id` must be numeric string only.
- For `s3_uri`, prefer tile extraction from file path/name.
- For `RA/DEC`, resolve tile by MCP.
- Candidate rows must always include fixed path columns (nullable):
  - `euclid_fits_path`
  - `euclid_path_source`
  - `desi_tractor_i_fits_path`, `desi_tractor_fits_path`, `desi_image_g_path`, `desi_image_r_path`, `desi_image_i_path`, `desi_image_z_path`

## Path policy

- Euclid single-star-table flow: trust resolved input/MCP path; do not invent legacy wildcard prefixes.
- DESI paths must be S3 style (tractor-i, tractor, coadd image) from `brickname`.

## Cutout execution contract (must follow)

- `execute_cutout_group` calls MUST include `targets`.
- Build `targets` from selected rows with fields:
  - `obj_id`
  - `row_index`
  - `ra_deg`
  - `dec_deg`
  - optional: `tile_index`, `brickname`
- Do not call `execute_cutout_group` without `targets` (schema error is operator fault).
- Retry policy in web debug:
  - batch serially (default batch size = 1 unless user says otherwise)
  - max one retry for the same batch
  - after retry failure, continue next batch and summarize failed row indices
- Do not hand-edit `status.json` / `result_index.json` to mark success/failure.
- Only write cutout artifacts from actual tool responses:
  - `cutout_index.csv`
  - `cutout_report.json`
  - `cutout_raw_reports.json`

## Required artifact outputs

- `candidate_pool.csv`
- `preview_10.csv`
- `selection_final.csv`
- `selection_report.json`
- `result_index.json`

## Zero-result policy

- If candidate pool rows are zero, emit `region_adjust_request.json` decision gate.
