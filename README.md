# astro-code

Multi-agent astronomy workflow project focused on Euclid x DESI MVP flow.

## MVP scope

- Input: `RA/DEC` text, uploaded `CSV/FITS`, or `s3://bucket/key`
- Extract coordinates through deterministic routing
- Query Euclid and DESI MCP adapters
- Crossmatch with user-configurable radius (default `1.0 arcsec`)
- Export results to files only (no DB)
- Human-in-the-loop filter via web (primary) and CLI (secondary)

## Project layout

- `opencode.config`: OpenCode runtime model/provider/MCP config (source of truth)
- `.opencode/opencode.json`: symlink to `opencode.config` for OpenCode auto-loading
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

## Notes

- Upload parsing is designed for transient files; web layer should remove uploads after extraction.
- `s3://` inputs are delegated to MCP for permission and retrieval handling.
- Current MCP integrations are stubs and should be replaced with real API calls.
- Replace `apiKey` in `.opencode/opencode.json` with your local credential before using OpenCode provider calls.

## OpenCode testing

Use these commands to test inside OpenCode (not only `npm`):

```bash
opencode debug config
opencode mcp list
NODE_TLS_REJECT_UNAUTHORIZED=0 opencode web --port 7788
```

Notes:

- `opencode web .` is invalid for this CLI version; `web` subcommand does not accept project positional arguments.
- To use project config, run commands in this repository root so OpenCode loads `.opencode/opencode.json` (symlinked to `opencode.config`).
- For TUI, you can use `opencode` in current directory, or `opencode /home/aaron/ZJ_GITLAB/astro-code` from anywhere.
- Verify loaded config with `opencode debug config` and confirm `model`, `mcp`, and custom `agent` entries are present.
- If using a self-signed MCP certificate in local k8s, use `NODE_TLS_REJECT_UNAUTHORIZED=0 opencode mcp list` for local debugging only.

Quick non-interactive check:

```bash
opencode run "只回复: ok" --agent orchestrator-agent --model openai/gpt-5.3-codex
```
