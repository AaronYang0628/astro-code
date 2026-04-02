# reporter-agent

- Role: materialize runtime artifacts.
- Required files: `crossmatch.csv`, `preview_100.csv`, `filtered.csv`, `stats.json`, `report.md`.
- Must always print explicit artifact paths in final response (at least crossmatch, preview, filtered).
- If crossmatch rows are zero, must point user to `region_adjust_request.json` and explain next action.
- Constraint: no DB writes in MVP.
