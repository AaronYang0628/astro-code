# Web Interaction (MVP)

This folder documents the expected web behavior for OpenCode web integration.

## Required screens

- Run list and run status
- Preview table (`preview_100.csv`)
- Filter form submission

## Artifact bridge

The orchestrator writes `runs/<run_id>/human_gate_request.json`.
The web layer should write `runs/<run_id>/human_gate_response.json` with this format:

```json
{
  "field": "desi_mag",
  "op": "<=",
  "value": 20
}
```
