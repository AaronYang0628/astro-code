# Phase-2 Workplan: Euclid x DESI Image-Pair Pipeline

## 1) Scope

This phase starts **after** crossmatch candidate list generation and focuses on workflow delivery only.
Model training is out of scope.

- In scope:
  - Candidate list -> image path linking -> cutout generation -> QC -> sampling -> dataset manifest.
  - Path-based processing only (`RA/DEC` + `s3_uri`), no file body ingestion in chat context.
- Out of scope:
  - Model training, model architecture, and serving.

## 2) Fixed Inputs/Outputs

### Inputs

- `runs/<run_id>/candidate_pool.csv` (candidate list from step-1)
- Euclid image/catalog paths
- DESI image/catalog paths (currently DR10 available as primary)

### Outputs

All outputs must be under `runs/<run_id>/`:

- `image_pair_index.csv`
- `cutouts/native/index.csv`
- `cutouts/reproj/index.csv`
- `qc/qc_report.json`
- `sampling/sampling_selected.csv`
- `sampling/sampling_rejected.csv`
- `dataset_manifest.json`
- updated `result_index.json` and `status.json`

## 3) Default Policy (v1)

- Allowed input types: `radec_text`, `s3_uri` only.
- DESI release policy:
  - primary: `DR10 south`
  - fallback: `DR9 north` only when image path is available; otherwise mark missing-band/missing-image explicitly.
- Cutout size policy:
  - star (`type == PSF`): `28.8 arcsec`
  - galaxy (`type != PSF`): `67.072 arcsec`
- Cutout modes:
  - `native` (sky-coverage aligned, no reprojection)
  - `reproj` (DESI reprojected to Euclid crop WCS)
- Sampling defaults:
  - `mag_max = 24`
  - maskbits reject bits: `2,3,4,14`
  - star/galaxy sampled independently by mag bins
  - configurable `target_n` and `galaxy_ratio` (defaults: `10000`, `0.6`)

## 4) Executable Task List + Acceptance Criteria

### T1. Candidate Schema Freeze

Define and enforce required fields in candidate list for downstream image-pair processing.

Required minimum fields:
`obj_id, ra, dec, type, tile_index, brickname, maskbits, mag_proxy, seg_area`

Acceptance:

- 100% rows in `candidate_pool.csv` contain required fields or explicit null with reason.
- Missing-field reasons are written to `status.json` and `qc_report.json`.

### T2. Image Path Resolver

Build deterministic mapping from candidate identifiers to Euclid/DESI FITS paths.

Rules:

- Euclid path resolution by `tile_index` naming convention.
- DESI path resolution by `brickname` + band.
- Record path availability per band, do not fail silently.

Acceptance:

- `image_pair_index.csv` produced with one row per candidate.
- Each row includes `euclid_path`, `desi_path_<band>`, and `availability_<band>`.
- Resolver success report exists in `qc/qc_report.json`.

Current implementation note:

- `image_pair_index.csv` is now generated directly in step-1 output stage from `tile_index` and `brickname` derivation, with auditable `path_source`.
- Rows include explicit filename lookup keys (`lookup_key_tile_index`, `lookup_key_brickname`) and filename patterns (`euclid_filename_query`, `desi_filename_*`) to reflect step-2 file search intent.

### T3. Native Cutout Generator

Generate cutouts for Euclid and DESI in native resolution/domain using RA/DEC + WCS.

Acceptance:

- `cutouts/native/index.csv` exists and references valid FITS cutout files.
- Centering error metric exists per sample (`center_offset_px`).
- Hard failure rate < 2% on candidates with valid paths; failures logged with reasons.

### T4. Reprojection Cutout Generator

Generate reprojected DESI cutouts aligned to Euclid crop WCS (pixel-level alignment mode).

Acceptance:

- `cutouts/reproj/index.csv` exists.
- For each generated pair, WCS/shape parity check passes (`shape_equal=true`, `wcs_match=true`).
- Reprojection NaN ratio is logged per sample.

### T5. Quality Control Gate

Apply QC rejection policies on both native/reproj outputs.

QC checks (minimum):

- NaN ratio threshold
- continuous zero-pixel region threshold
- oversized object vs stamp edge clipping
- residual/consistency threshold (if computed)

Acceptance:

- `qc/qc_report.json` contains aggregate pass/fail counts and per-reason breakdown.
- `sampling/sampling_rejected.csv` includes one primary reject reason per row.

### T6. Filtering + Sampling

Apply selection rules and balanced sampling.

Rules (v1):

- Reject maskbits with bits 2/3/4/14 set.
- Apply mag upper bound (`mag <= 24`).
- Apply galaxy size/visibility rules (seg_area and combined constraints).
- Uniform sampling by mag bins; stars and galaxies sampled independently.
- Respect `target_n` and `galaxy_ratio`.

Acceptance:

- `sampling/sampling_selected.csv` count matches target within tolerance (`+-1%`).
- achieved galaxy ratio within tolerance (`+-5%`).
- sampling histogram summary stored in `qc/qc_report.json`.

### T7. Artifact Packaging

Create final manifest for downstream training team.

Manifest must include:

- selected sample IDs
- all path references (native/reproj)
- per-sample metadata (type, mag, seg_area, qc status)
- pipeline version + config snapshot + timestamp

Acceptance:

- `dataset_manifest.json` generated and validated.
- 100% file paths in manifest exist and are readable.
- `result_index.json` references all new artifacts.

### T8. Orchestrator Integration

Integrate T1-T7 into orchestrator phase machine after existing crossmatch step.

New phases:
`resolve_paths -> cutout_native -> cutout_reproj -> qc -> sampling -> package`

Acceptance:

- `status.json` exposes each phase start/end and metrics.
- Web/CLI execution prints progress before each major phase.
- Final response prints absolute artifact paths only (no large payload inline).

## 5) Milestones

- M1 (Foundation): T1-T2 complete.
- M2 (Image Ops): T3-T5 complete.
- M3 (Dataset Output): T6-T8 complete.

Phase completion criteria:

- End-to-end run from candidate list to `dataset_manifest.json` succeeds on pilot dataset.
- No upload-body/context explosion behavior introduced.
- All outputs auditable under `runs/<run_id>/`.

## 6) Operational Guardrails (Must Keep)

- Never inline FITS/file body into LLM context.
- Process by path only, in batch/chunk mode.
- Any unresolved path or QC failure must be explicit in artifacts and status.
- No outputs outside `runs/<run_id>/`.
