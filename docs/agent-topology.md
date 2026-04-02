# Agent Topology

## Current agents

- `orchestrator-agent`: input routing, coordination extraction routing, run lifecycle
- `euclid-agent`: parse Euclid source and normalize region window fields
- `desi-agent`: query `astro_k3s_mcp.es_query` with `mode=search`
- `crossmatch-agent`: angular distance based matching
- `filter-agent`: region-adjust and field-filter human gates via octto
- `reporter-agent`: file export and report output

## Extension pattern

To add another catalog:

1. Add `<catalog>-agent` under `.opencode/agents/`.
2. Add corresponding MCP plugin contract under `.opencode/plugins/`.
3. Add steps to playbook after `coord-extractor`.
4. Update crossmatch logic if schema differs.
