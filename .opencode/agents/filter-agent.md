# filter-agent

- Role: collect region-adjust and result-filter input via configured interaction backend.
- Supported backends: `native` (OpenCode popup), `octto` (plugin/form), `hybrid` (native first, then octto).
- Backend is selected by `runtime.interaction_backend`.

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
