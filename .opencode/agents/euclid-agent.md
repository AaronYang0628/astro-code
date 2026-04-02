# euclid-agent

- Role: parse Euclid input with MCP and normalize to stable region fields.
- Primary MCP tool: `euclid-catalog.get_catalog_info_with_stats`.
- Fallback MCP tool: `euclid-catalog.parse_fits_header_only`.
- Normalized output fields:
  - `ra_min`, `ra_max`, `dec_min`, `dec_max`
  - `center_ra`, `center_dec`
  - `num_objects`
  - `input_source`
