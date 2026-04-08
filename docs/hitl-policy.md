# HITL Policy (MVP)

## Goal

Allow user adjustment after crossmatch and before final export.

## Interaction channels

- Configured backend: `native` / `octto` / `hybrid` (via `runtime.interaction_backend`)
- Audit trail: request/response JSON artifacts are always written under `runs/<run_id>/`

Interaction policy:

- For radius choice, filter-entry confirmation, and filter condition collection, use configured backend (`native`/`octto`/`hybrid`).
- In `hybrid`, octto is preferred and native is used when octto is unavailable.
- In `hybrid`, if runtime agent list already contains `octto`, interaction must go through octto first.
- Native `Session not found: current` is treated as native-session error and must not block octto path.
- Text fallback for decisions is disallowed.
- If selected backend is unavailable, stop with explicit raw backend error.

## Current behavior

1. If crossmatch is empty, runner writes `region_adjust_request.json` for radius/center follow-up.
2. If crossmatch has rows, runner writes `filter_entry_request.json` and continues unless explicit yes is provided.
3. If explicit yes exists, runner writes `human_gate_request.json` and applies filter only when response is valid.
4. Missing response files never block pipeline completion; runner continues with unfiltered rows.
5. `status.json` is updated through all phases (running/completed/failed) for live troubleshooting.

## Auditable artifacts

- `region_adjust_request.json` (if no rows)
- `filter_entry_request.json`
- `filter_entry_response.json` (if provided)
- `human_gate_request.json`
- `human_gate_response.json` (if provided)
- `status.json` (phase, state, error, metrics)
- `stats.json` stores applied filter content
