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

## Testing

### Execution policy

- Primary flow: OpenCode Web/TUI session execution (direct MCP + octto in same chat session)
- Local pipeline (`npm run ...`): regression/local replay only, do not mix with active octto interaction in Web session

### Quick Test (with sample data)

```bash
npm run run:mvp
```

This runs with the built-in sample request using coordinates `150.114000, -2.345000`.

### Custom Test

Create a custom request JSON file, then run:

```bash
npx tsx src/orchestrator/index.ts \
  --request <your_request.json> \
  --playbook playbooks/euclid_desi_mvp.playbook.md \
  --config pipeline.config.yaml
```

### Supported Input Types

| Type | Description | Example |
|------|-------------|---------|
| `radec_text` | Direct RA,DEC coordinates | `{"input":{"type":"radec_text","value":"150.114,-2.345"}}` |
| `file_upload` | CSV/FITS file upload | See `examples/request.file.json` |
| `s3_uri` | S3 path | See `examples/request.s3.json` |

### Output Location

Results are written to `runs/<run_id>/`:
- `crossmatch.csv`
- `preview_100.csv`
- `filtered.csv`
- `stats.json`
- `report.md`
- `result_index.json`

## Notes

- Upload parsing is designed for transient files; web layer should remove uploads after extraction.
- `s3://` inputs are delegated to MCP for permission and retrieval handling.
- `npm run` pipeline now uses real MCP servers via `src/orchestrator/mcp-client.ts`.
- OpenCode path uses MCP servers from `.opencode/opencode.json`.
- Replace `apiKey` in `.opencode/opencode.json` with your local credential before using OpenCode provider calls.
- Octto is enabled as OpenCode plugin via `"plugin": ["octto"]` in `.opencode/opencode.json`.
- If Euclid MCP uses self-signed TLS cert, set `MCP_INSECURE_TLS=1` for `npm run` pipeline (or set a trusted CA).
- If DESI returns 0 rows on first query, pipeline auto-retries with wider window (`DESI_RETRY_SCALE`, default `20`).

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

Detailed Web test workflow (agent-by-agent):

- `docs/opencode-web-testing.md`

Non-interactive sanity check:

```bash
opencode run "只回复: ok" --agent orchestrator-agent --model openai/gpt-5.3-codex
```
