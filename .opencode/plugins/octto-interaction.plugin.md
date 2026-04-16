# octto-interaction

version: 0.1.0

## Purpose

Provide an octto-backed interaction path for human gates when `runtime.interaction_backend` is `octto` or `hybrid`.

## Capabilities

- filter entry confirm
- six-condition selection form
- region adjust form

## Input schema

The orchestrator writes request files under `runs/<run_id>/`:

- `selection_plan_request.json`
- `region_adjust_request.json`

## Output schema

octto should write response files in the same run folder:

- `selection_plan_response.json`

Expected selection payload:

```json
{
  "selected": ["bright_maskbits_filter", "faint_mag_limit", "galaxy_fraction"],
  "order": ["bright_maskbits_filter", "faint_mag_limit", "galaxy_fraction"],
  "params": {
    "faint_mag_limit": { "mag_max": 24 },
    "galaxy_fraction": { "total_samples": 100, "galaxy_fraction": 0.5 }
  }
}
```

## Failure modes

- response file missing: pipeline continues with default selection plan
- invalid response schema: pipeline ignores invalid conditions and continues
