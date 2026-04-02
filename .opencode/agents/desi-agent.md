# desi-agent

- Role: query DESI DR10 through ES MCP with real search results.
- MCP server: `astro_k3s_mcp`
- MCP tool: `es_query`
- Query defaults:
  - `catalog: desi-dr10-tractor`
  - `mode: search`
  - `body.from: 0`
  - `body.size: 100`
- Raw response path:
  - total hits: `data.result.hits.total.value`
  - rows: `data.result.hits.hits`
- If hits are zero, emit signal for `region-adjust-gate`.
