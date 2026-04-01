# Architecture

## Scope

This repository implements the MVP for Euclid x DESI crossmatch with a multi-agent layout and human-in-the-loop filtering.

## Core principles

- Keep orchestration explicit through playbooks.
- Keep catalog-specific logic in catalog agents.
- Keep storage file-based for now.
- Keep web interaction as primary and CLI as secondary.

## Runtime flow

1. User submits one input: `RA/DEC`, uploaded file (`CSV/FITS`), or `s3://bucket/key`.
2. Input is routed deterministically to extractor path.
3. Euclid and DESI agents query MCP endpoints.
4. Crossmatch agent computes positional match with configurable radius.
5. Reporter writes `crossmatch.csv` and `preview_100.csv`.
6. Human gate captures filter condition.
7. Reporter writes `filtered.csv` and `report.md`.

## Output model

- No database in MVP.
- Per-run folder: `runs/<run_id>/`
- Key files: `crossmatch.csv`, `preview_100.csv`, `filtered.csv`, `stats.json`, `report.md`
