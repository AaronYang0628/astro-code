# Architecture

## Scope

This repository implements the MVP for Euclid x DESI crossmatch with a multi-agent layout and human-in-the-loop filtering.

## Core principles

- Keep orchestration explicit through playbooks.
- Keep catalog-specific logic in catalog agents.
- Keep storage file-based for now.
- Keep one TypeScript execution kernel for both Web and CLI entries.

## Runtime flow

1. User submits one input: `RA/DEC` or `s3://bucket/key`.
2. Input is routed deterministically to extractor path.
3. Euclid and DESI agents query MCP endpoints.
4. Crossmatch agent computes positional match with configurable radius.
5. Reporter writes `candidate_pool.csv` and `preview_10.csv`.
6. Human gates run in the same pipeline state machine using configured backend (`native|octto|hybrid`).
7. Reporter writes `selection_final.csv`, `selection_report.json`, and `report.md`.

## Output model

- No database in MVP.
- Per-run folder: `runs/<run_id>/`
- Key files: `status.json`, `candidate_pool.csv`, `preview_10.csv`, `selection_final.csv`, `selection_report.json`, `stats.json`, `report.md`, `result_index.json`
- DESI trace files under run dir:
  - `desi_origin.json`
  - `mcp/desi_search_query.json`
  - `mcp/desi_search_initial.raw.json`
  - `mcp/desi_search_sample.raw.json`
  - (optional) `mcp/desi_search_retry.raw.json`
  - (optional) `mcp/desi_search_retry_sample.raw.json`
