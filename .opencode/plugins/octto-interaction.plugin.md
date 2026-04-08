# octto-interaction

version: 0.1.0

## Purpose

Provide an octto-backed interaction path for human gates when `runtime.interaction_backend` is `octto` or `hybrid`.

## Capabilities

- filter entry confirm
- multi-condition filter form
- region adjust form

## Input schema

The orchestrator writes request files under `runs/<run_id>/`:

- `filter_entry_request.json`
- `human_gate_request.json`
- `region_adjust_request.json`

## Output schema

octto should write response files in the same run folder:

- `filter_entry_response.json`
- `human_gate_response.json`

Expected filter payload:

```json
{
  "logic": "and",
  "conditions": [
    { "field": "separation_arcsec", "op": "<=", "value": 5 },
    { "field": "class_label", "op": "contains", "value": "unknown" }
  ]
}
```

## Failure modes

- response file missing: pipeline continues without extra filter
- invalid response schema: pipeline ignores invalid conditions and continues
