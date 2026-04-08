# Playbook Spec (MVP)

Playbooks are markdown files with YAML frontmatter.

## Required frontmatter keys

- `id`: workflow id
- `version`: semantic version
- `steps`: ordered list of steps

## Step fields

- `id`: unique step id
- `type`: step type (`input`, `route`, `mcp_call`, `transform`, `human_gate`, `export`)
- `agent`: owning agent
- `action`: action identifier
- `depends_on`: optional list of parent step ids
- `when`: optional condition expression
- `mcp`: MCP execution descriptor
  - `server`: MCP server name from OpenCode config
  - `tool`: MCP tool name
  - `input`: tool input template
- `on_fail`: failure strategy (`continue` or `stop`) with guidance
- `output_mapping`: map raw fields to normalized workflow variables

## Required step ids for current runner

- `input-router`
- `coord-extractor`
- `euclid-query`
- `desi-query`
- `crossmatch`
- `preview-export`
- `human-filter-gate`
- `filtered-export`

## Human-in-the-loop behavior

HITL uses configured backend (`native|octto|hybrid`) and writes auditable requests into `runs/<run_id>/`:

- Zero-hit branch: write `region_adjust_request.json`
- Filter entry confirmation: write `filter_entry_request.json`, then read `filter_entry_response.json`
- Filter condition collection: write `human_gate_request.json`, then read `human_gate_response.json`

If no valid filter response exists, pipeline continues without additional filtering.

## MCP response mapping example

DESI `es_query` (`mode=search`) expected payload:

- total hits: `response.data.result.hits.total.value`
- rows: `response.data.result.hits.hits`
