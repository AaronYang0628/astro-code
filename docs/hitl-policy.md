# HITL Policy (MVP)

## Goal

Allow user adjustment only when candidate pool is empty, and keep matching-phase filtering as one six-condition stage.

## Interaction channels

- Configured backend: `native` / `octto` / `hybrid` (via `runtime.interaction_backend`)
- Audit trail: request/response JSON artifacts are always written under `runs/<run_id>/`

Interaction policy:

- For radius/region adjustment, use configured backend (`native`/`octto`/`hybrid`).
- In `hybrid`, octto is preferred and native is used when octto is unavailable.
- In `hybrid`, if runtime agent list already contains `octto`, interaction must go through octto first.
- Native `Session not found: current` is treated as native-session error and must not block octto path.
- Text fallback for decisions is disallowed.
- If selected backend is unavailable, stop with explicit raw backend error.

## Current behavior

1. If candidate pool is empty, runner writes `region_adjust_request.json` for radius/center follow-up.
2. If candidate pool has rows, runner skips extra filter gate and proceeds directly to six-condition selection.
3. Six-condition selection is collected through `selection_plan_request.json` and `selection_plan_response.json`.
4. Missing selection response never blocks pipeline completion; runner continues with selected/default rows.
5. `status.json` is updated through all phases (running/completed/failed) for live troubleshooting.

## Auditable artifacts

- `region_adjust_request.json` (if no rows)
- `selection_plan_request.json`
- `selection_plan_response.json` (if provided)
- `status.json` (phase, state, error, metrics)
- `stats.json` stores applied selection plan content
