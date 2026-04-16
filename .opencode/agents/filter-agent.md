# filter-agent

- Role: collect region-adjust input via configured interaction backend.
- Supported backends: `native` (OpenCode popup), `octto` (plugin/form), `hybrid` (octto first, then native).
- Backend is selected by `runtime.interaction_backend`.
- Default backend is `native`.
- In `hybrid`, attempt octto first whenever `octto` agent is visible in `/agent` list.
- Only fallback to native after octto attempt fails; preserve raw error in run logs.

## Region adjust gate

1) Show reason when no matches are found.
2) Ask user to adjust radius/center with configured backend.
3) Return structured choice to orchestrator.

## Six-condition selection

1) Selection is handled by `selection_plan_request.json` / `selection_plan_response.json`.
2) This agent should not collect a second filter stage after six-condition selection.
