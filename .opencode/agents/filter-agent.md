# filter-agent

- Role: collect region-adjust and result-filter input via configured interaction backend.
- Supported backends: `native` (OpenCode popup), `octto` (plugin/form), `hybrid` (octto first, then native).
- Backend is selected by `runtime.interaction_backend`.
- Default backend is `hybrid`.
- In `hybrid`, attempt octto first whenever `octto` agent is visible in `/agent` list.
- Only fallback to native after octto attempt fails; preserve raw error in run logs.

## Region adjust gate

1) Show reason when no matches are found.
2) Ask user to adjust radius/center with configured backend.
3) Return structured choice to orchestrator.

## Result filter gate

1) Ask whether to enter filtering.
2) If yes, collect `logic` and `conditions[]` through configured backend chain.
3) Return structured filter object:

```json
{
  "logic": "and",
  "conditions": [
    {"field": "separation_arcsec", "op": "<=", "value": 220},
    {"field": "class_label", "op": "contains", "value": "327"}
  ]
}
```
