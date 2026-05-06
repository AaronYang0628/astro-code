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
- `runs/`: runtime outputs (`status.json`, `candidate_pool.csv`, `preview_10.csv`, `selection_final.csv`)
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

- `candidate_pool.csv`
- `preview_10.csv`
- `selection_final.csv` (written after explicit six-condition selection)
- `stats.json`
- `report.md`
- `result_index.json`
- `status.json` (phase/status/error for live troubleshooting)
- `input_manifest.json`
- `region_adjust_request.json` (only when no crossmatch results)
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
- Web mode requires explicit six-condition selection before writing `selection_final.csv` (status becomes `waiting_selection` until selected).
- When crossmatch has rows, field/value filtering is collected via configured backend (`native|octto|hybrid`).
- Euclid tile lookup can run from local registry file `config/euclid_tiles_q1.json` (override with `EUCLID_TILE_REGISTRY_PATH`).
- Local cutout worker (no MCP server required): `py/workers/cutout_stamp_worker.py`.
- Optional telemetry (Langfuse/OTLP): set `OTEL_ENABLED=1` and `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) to auto-export run/step/MCP traces.
- For OTLP auth headers, set `OTEL_EXPORTER_OTLP_HEADERS` (or `OTEL_EXPORTER_OTLP_TRACES_HEADERS`) with `key=value,key2=value2`.

### Optional LLM usage metadata

If your web layer knows LLM token usage, pass it in request JSON under `llm_usage` so traces include token/cost signals:

```json
{
  "llm_usage": {
    "model": "openai/gpt-5.3-codex",
    "provider": "openai-compatible",
    "prompt_tokens": 3200,
    "completion_tokens": 580,
    "total_tokens": 3780,
    "latency_ms": 1840,
    "estimated_cost_usd": 0.0245
  }
}
```

If `estimated_cost_usd` is omitted, orchestrator tries a local estimate for known models.
- Verified matching RA/DEC for quick flow validation: `examples/request.radec.match.json`.
- Preview-rich RA/DEC profile for filter UX development: `examples/request.radec.match.radius250.json`.
- Multi-condition filter replay sample: `examples/request.radec.match.radius250.filter.json`.
- Helm supports `hostAliases` for fake/local MCP domains (for example `catalog.euclid.mcp.ay.dev`), but Cluster DNS is recommended.
- OpenCode config mount supports three modes via `opencodeConfig.mode`: `seed` (default), `secret`, `external`.

## Cutout stamps (local worker)

Use filtered rows (`selection_final.csv`) to generate Euclid/DESI FITS stamps locally.

```bash
python3 py/workers/cutout_stamp_worker.py \
  --input-csv runs/<run_id>/selection_final.csv \
  --output-dir runs/<run_id>/cutouts
```

Notes:

- The worker groups by source FITS path and cuts multiple objects per open file (reduced IO).
- Euclid uses `euclid_fits_path`; DESI uses `desi_image_g/r/i/z_path`.
- If CSV paths are S3 URIs, provide path remap rules to local files via repeatable `--path-map SRC=DST`.
- Outputs include `cutout_index.csv` and `cutout_report.json` under the output dir.

## Remote cutout MCP execution

When a remote `fits-cutout` MCP is available, orchestrator can execute grouped cutout directly against S3 without local file mounts.

Request example:

```json
{
  "workflow": "euclid_cutout",
  "input": { "type": "s3_uri", "value": "s3://.../catalog.fits" },
  "interaction": "web",
  "selection": {
    "conditions": [
      { "id": "oversized_galaxy_filter", "params": { "stamp_size_px": 160 } }
    ]
  },
  "selection_confirmed": true,
  "cutout": {
    "enabled": true,
    "mcp_server": "fits-cutout",
    "output_prefix": "s3://data-and-computing/projects/CSST/shared-data/astro/cutouts",
    "size_deg": 0.008,
    "desi_bands": ["g", "r", "i", "z"]
  }
}
```

Run artifacts will additionally include:

- `cutout_index.csv`
- `cutout_report.json`
- `cutout_raw_reports.json`

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
OTEL_ENABLED=1  OTEL_SERVICE_NAME=astro-code-orchestrator  OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 NODE_TLS_REJECT_UNAUTHORIZED=0 opencode web --port 7788
```

- `opencode web .` is invalid for this CLI version; `web` does not accept project positional args.
- Project config is loaded from `.opencode/opencode.json`.
- If Euclid MCP uses self-signed TLS cert, use `NODE_TLS_REJECT_UNAUTHORIZED=0` for local debugging.

Non-interactive sanity check:

```bash
opencode run "只回复: ok" --agent orchestrator-agent --model openai/gpt-5.3-codex
```

## Local Euclid tile check

Quickly test local `RA/DEC -> tile_id` resolution from the registry:

```bash
npm run check:euclid-tile -- --ra 56.8 --dec -50.9
```

The command prints registry path, tile count, input coordinates, and resolved `tile_id` (empty means no local Euclid coverage for the point).
