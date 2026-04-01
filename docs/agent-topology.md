# Agent Topology

## Current agents

- `orchestrator-agent`: input routing, coordination extraction routing, run lifecycle
- `euclid-agent`: query Euclid MCP and return standardized records
- `desi-agent`: query DESI MCP and return standardized records
- `crossmatch-agent`: angular distance based matching
- `filter-agent`: user filter request and validation
- `reporter-agent`: file export and report output

## Extension pattern

To add another catalog:

1. Add `<catalog>-agent` under `.opencode/agents/`.
2. Add corresponding MCP plugin contract under `.opencode/plugins/`.
3. Add steps to playbook after `coord-extractor`.
4. Update crossmatch logic if schema differs.
