# astro-code

Multi-agent astronomy workflow project focused on Euclid x DESI MVP flow.

## MVP scope

- Input: `RA/DEC` text or `s3://bucket/key`
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
- `py/workers/`: Python helpers used in local data tooling
- `.opencode/agents|skills|plugins/`: contracts for agentic runtime
- `runs/`: runtime outputs (`status.json`, `crossmatch.csv`, `preview_100.csv`, `filtered.csv`)
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
- `status.json` (phase/status/error for live troubleshooting)
- `input_manifest.json`
- `region_adjust_request.json` (only when no crossmatch results)
- `preview_summary.json` (preview count + sample rows + filterable fields)
- `desi_origin.json` (DESI source metadata: ES/S3/local hint + source path when exposed)
- `mcp/desi_search_query.json`
- `mcp/desi_search_initial.raw.json`
- `mcp/desi_search_sample.raw.json`
- `mcp/desi_search_retry.raw.json` (only when retry triggered)
- `mcp/desi_search_retry_sample.raw.json` (only when retry triggered)

All files are written under `runs/<run_id>/`.

## Testing

Execution policy:

- Web and CLI now share one TypeScript orchestrator pipeline and one run artifact model.
- Both entries execute MCP queries + crossmatch + human gate via same state machine.
- Every run writes `runs/<run_id>/status.json` first, then updates phase/metrics/artifacts until completion.

Detailed guides:

- Web prompts and session testing: `docs/opencode-web-testing.md`
- Local npm replay/regression: `docs/local-npm-regression.md`
- Local image/chart build + k3s deployment: `ops/playbooks-runbook.md`

## Notes

- `file_upload` is disabled by policy; use `s3://` or direct `RA/DEC` input.
- `s3://` inputs are delegated to MCP for permission and retrieval handling.
- `npm run` pipeline now uses real MCP servers via `src/orchestrator/mcp-client.ts`.
- OpenCode path uses MCP servers from `.opencode/opencode.json`.
- OpenCode provider `apiKey` is loaded from environment variable: `AI_MODEL_KEY` (configured as `{env:AI_MODEL_KEY}` in `.opencode/opencode.json`).
- Put your local key in shell env or `.envrc` (direnv), and never commit keys into git.
- In k8s Helm deployment, set `opencode.aiModelKey` so pod gets `AI_MODEL_KEY` env via Kubernetes Secret.
- Interaction backend is configurable via `pipeline.config.yaml` -> `runtime.interaction_backend` (default: `native`):
  - `native`: OpenCode popup only
  - `octto`: octto-only interaction
  - `hybrid`: octto first, native fallback
- If Euclid MCP uses self-signed TLS cert, set `MCP_INSECURE_TLS=1` for `npm run` pipeline (or set a trusted CA).
- If DESI returns 0 rows on first query, pipeline auto-retries with wider window (`DESI_RETRY_SCALE`, default `20`).
- When crossmatch has rows, field/value filtering is collected via configured backend (`native|octto|hybrid`).
- Verified matching RA/DEC for quick flow validation: `examples/request.radec.match.json`.
- Preview-rich RA/DEC profile for filter UX development: `examples/request.radec.match.radius250.json`.
- Multi-condition filter replay sample: `examples/request.radec.match.radius250.filter.json`.
- Helm supports `hostAliases` for fake/local MCP domains (for example `catalog.euclid.mcp.ay.dev`), but Cluster DNS is recommended.
- OpenCode config mount supports three modes via `opencodeConfig.mode`: `seed` (default), `secret`, `external`.

## Octto plugin

To use octto-driven interaction, install your octto plugin contract to:

- `.opencode/plugins/octto-interaction.plugin.md`

Runtime image now preinstalls npm package `octto` and includes plugin config in `opencode.json`.
An optional octto runtime config is also seeded at `.opencode/octto.json` (and `/home/opencode/.config/opencode/octto.json` in container).

Then set backend in `pipeline.config.yaml`:

```yaml
runtime:
  interaction_backend: octto
```

Or use hybrid fallback when needed:

```yaml
runtime:
  interaction_backend: hybrid
```

## OpenCode testing

Quick commands (run in project root):

```bash
opencode debug config
opencode mcp list
NODE_TLS_REJECT_UNAUTHORIZED=0 opencode web --port 7788
```

- `opencode web .` is invalid for this CLI version; `web` does not accept project positional args.
- Project config is loaded from `.opencode/opencode.json`.
- If Euclid MCP uses self-signed TLS cert, use `NODE_TLS_REJECT_UNAUTHORIZED=0` for local debugging.

Non-interactive sanity check:

```bash
opencode run "只回复: ok" --agent orchestrator-agent --model openai/gpt-5.3-codex
```
