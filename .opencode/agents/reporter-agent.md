# reporter-agent

- Role: materialize runtime artifacts.
- Required files: `candidate_pool.csv`, `preview_100.csv`, `preview_summary.json`, `filtered.csv`, `stats.json`, `report.md`.
- Must always print explicit artifact paths in final response (at least candidate pool, preview, filtered).
- Must include preview summary in response by reading `preview_summary.json` (`preview rows`, sample rows, filterable fields).
- Must render preview sample as markdown table (top 10 rows).
- If candidate pool rows are zero, must point user to `region_adjust_request.json` and explain next action.
- Constraint: no DB writes in MVP.
