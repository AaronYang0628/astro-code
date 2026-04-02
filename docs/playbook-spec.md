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
- `plugin`: optional plugin call for HITL steps

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

The runner writes `human_gate_request.json` into run directory.
If `human_gate_response.json` exists, it is used as filter condition.
If not present, pipeline continues with no filter.

## MCP response mapping example

DESI `es_query` (`mode=search`) expected payload:

- total hits: `response.data.result.hits.total.value`
- rows: `response.data.result.hits.hits`
