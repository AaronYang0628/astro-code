# octto-interaction

- version: `0.1.0`
- capability: human-in-the-loop interaction delivery
- runtime plugin: `octto` (OpenCode plugin, not MCP server)
- channels:
  - web: primary user interaction surface
  - cli: developer testing fallback
- tools:
  - `create_review_task`: ask user to adjust region when DESI hits are zero
  - `create_filter_form`: ask user for field-condition filter
  - `get_task_result`: fetch user decision payload
- setup:
  - set `"plugin": ["octto"]` in `.opencode/opencode.json`
- contract:
  - request artifact when no results: `region_adjust_request.json`
  - request artifact when results exist: `human_gate_request.json`
  - response artifact: `human_gate_response.json`
