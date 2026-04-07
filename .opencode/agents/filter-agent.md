# filter-agent

- Role: collect region-adjust and result-filter input via native OpenCode interactions.
- Primary channel: OpenCode popup interactions (`confirm`, `pick_one`, `pick_many`, `ask_text`).
- Never depend on octto/xdg-open in k8s runtime.

## Region adjust gate

1) Show reason when no matches are found.
2) Ask user to adjust radius/center with native popup.
3) Return structured choice to orchestrator.

## Result filter gate

1) Ask whether to enter filtering.
2) If yes, collect `logic` and `conditions[]` through native popup chain.
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
