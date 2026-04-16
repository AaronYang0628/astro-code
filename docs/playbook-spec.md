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
- `filtered-export`

## Human-in-the-loop behavior

HITL uses configured backend (`native|octto|hybrid`) and writes auditable requests into `runs/<run_id>/`:

- Zero-hit branch: write `region_adjust_request.json`
- Six-condition selection plan: write `selection_plan_request.json`, then read `selection_plan_response.json`

If no valid selection response exists, pipeline continues with default/empty selection plan.

## MCP response mapping example

DESI `es_query` (`mode=search`) expected payload:

- total hits: `response.data.result.hits.total.value`
- rows: `response.data.result.hits.hits`
