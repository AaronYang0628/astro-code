# orchestrator-agent

- Role: orchestrate minimal MVP pipeline execution and artifact output.
- Inputs: `radec_text`, `s3_uri`.
- Execution default: `pipeline_strict` (dialog for parameters, execution via `runMvpPipeline`).

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
  - `desi_fits_g_path`, `desi_fits_r_path`, `desi_fits_i_path`, `desi_fits_z_path`, `desi_tractor_i_fits_path`

## Required artifact outputs

- `candidate_pool.csv`
- `preview_100.csv`
- `preview_summary.json`
- `selection_candidates.csv`
- `selection_final.csv`
- `selection_report.json`
- `filtered.csv` (selection final alias)
- `result_index.json`

## Zero-result policy

- If candidate pool rows are zero, emit `region_adjust_request.json` decision gate.
- Optional development continuation: `mock_continue` only when explicitly selected.
