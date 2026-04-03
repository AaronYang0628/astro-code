# astro-code

Multi-agent astronomy workflow project focused on Euclid x DESI MVP flow.

## MVP scope

- Input: `RA/DEC` text, uploaded `CSV/FITS`, or `s3://bucket/key`
- Extract coordinates through deterministic routing
- Query Euclid and DESI MCP adapters
- Normalize Euclid output to stable region fields before DESI query
- Crossmatch with user-configurable radius (default `1.0 arcsec`)
- Export results to files only (no DB)
- Human-in-the-loop filter via web (primary) and CLI (secondary)

## Project layout

- `.opencode/opencode.json`: OpenCode runtime model/provider/MCP/plugin config (source of truth)
- `pipeline.config.yaml`: workflow pipeline runtime config
- `playbooks/`: workflow playbooks in markdown frontmatter format
- `src/orchestrator/`: TypeScript orchestration MVP
- `py/workers/`: Python helpers for CSV/FITS coordinate extraction
- `.opencode/agents|skills|plugins/`: contracts for agentic runtime
- `runs/`: runtime outputs (`crossmatch.csv`, `preview_100.csv`, `filtered.csv`)
- `docs/`: architecture and contracts

## Quick start

1) Install dependencies

```bash
npm install
python3 -m pip install -r py/requirements.txt
```

2) Run the MVP with sample RA/DEC input

```bash
npm run run:mvp
```

3) Check output files under `runs/<run_id>/`

- `crossmatch.csv`
- `preview_100.csv`
- `filtered.csv`
- `stats.json`
- `report.md`
- `result_index.json`
- `region_adjust_request.json` (only when no crossmatch results)
- `preview_summary.json` (preview count + sample rows + filterable fields)

## Testing

Execution policy:

- Primary flow: OpenCode Web/TUI session execution (direct MCP + octto in same chat session)
- Local `npm run` flow: regression/local replay only
- Do not mix Web HITL and local npm flow in one task

Detailed guides:

- Web prompts and session testing: `docs/opencode-web-testing.md`
- Local npm replay/regression: `docs/local-npm-regression.md`

## Notes

- Upload parsing is designed for transient files; web layer should remove uploads after extraction.
- `s3://` inputs are delegated to MCP for permission and retrieval handling.
- `npm run` pipeline now uses real MCP servers via `src/orchestrator/mcp-client.ts`.
- OpenCode path uses MCP servers from `.opencode/opencode.json`.
- Replace `apiKey` in `.opencode/opencode.json` with your local credential before using OpenCode provider calls.
- Octto is enabled as OpenCode plugin via `"plugin": ["octto"]` in `.opencode/opencode.json`.
- If Euclid MCP uses self-signed TLS cert, set `MCP_INSECURE_TLS=1` for `npm run` pipeline (or set a trusted CA).
- If DESI returns 0 rows on first query, pipeline auto-retries with wider window (`DESI_RETRY_SCALE`, default `20`).
- When crossmatch has rows, field/value filtering is expected to be collected via octto interaction.
- Verified matching RA/DEC for quick flow validation: `examples/request.radec.match.json`.
- Preview-rich RA/DEC profile for filter UX development: `examples/request.radec.match.radius250.json`.
- Multi-condition filter replay sample: `examples/request.radec.match.radius250.filter.json`.

## OpenCode testing

Quick commands (run in project root):

```bash
opencode debug config
opencode mcp list
NODE_TLS_REJECT_UNAUTHORIZED=0 opencode web --port 7788
```

- `opencode web .` is invalid for this CLI version; `web` does not accept project positional args.
- Project config is loaded from `.opencode/opencode.json`.
- In `opencode debug config`, confirm `plugin` contains `octto`.
- If Euclid MCP uses self-signed TLS cert, use `NODE_TLS_REJECT_UNAUTHORIZED=0` for local debugging.

Non-interactive sanity check:

```bash
opencode run "只回复: ok" --agent orchestrator-agent --model openai/gpt-5.3-codex
```
