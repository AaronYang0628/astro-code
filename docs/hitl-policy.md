# HITL Policy (MVP)

## Goal

Allow user adjustment after crossmatch and before final export.

## Interaction channels

- Primary: web (OpenCode web page)
- Secondary: CLI for developer testing

## Current behavior

1. Runner writes `human_gate_request.json` with filter template.
2. Web adapter (or developer) writes `human_gate_response.json`.
3. Runner applies filter and writes `filtered.csv`.
4. If no response exists, runner continues without additional filtering.

## Auditable artifacts

- `human_gate_request.json`
- `human_gate_response.json` (if provided)
- `stats.json` stores applied filter content
