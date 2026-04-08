# Plugin Spec (MVP)

Each plugin contract file under `.opencode/plugins/` should define:

- `name`
- `version`
- `capabilities`
- `input_schema`
- `output_schema`
- `failure_modes`

Current plugin families:

- MCP catalog query (`mcp-euclid`, `mcp-desi`)
- MCP S3 reader (`mcp-s3-reader`)
- Human interaction backends:
  - native OpenCode popup interactions
  - octto plugin/form workflow
  - hybrid (native first, octto fallback)
