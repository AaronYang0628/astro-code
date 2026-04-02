---
id: euclid_desi_mvp
version: 0.2.0
description: Euclid x DESI MCP workflow with Euclid normalization and HITL filtering
meta:
  mode: interactive
  execution: opencode_session_primary
  local_pipeline: regression_only
  on_error: stop
  default_timeout_sec: 120
  owner: astronomy-team
defaults:
  radius_arcsec: 1.0
  top_k: 100
  preview_rows: 100
variables:
  catalog_name: desi-dr10-tractor
  desi_mode: search
  brick_primary_only: true
  zero_hit_policy: ask_user_adjust_region
steps:
  - id: input-router
    type: input
    agent: orchestrator-agent
    action: detect_input_source
    prompt: "请提供查询输入: s3://bucket/key 或 RA,DEC"
    required: true

  - id: coord-extractor
    type: route
    agent: orchestrator-agent
    action: extract_coord_by_source
    depends_on: [input-router]
    routes:
      - when: "input_source == 's3_path'"
        use: mcp
        mcp:
          server: euclid-catalog
          tool: get_catalog_info_with_stats
          input:
            catalog_path: "{{s3_path}}"
      - when: "input_source == 'radec_text'"
        use: direct
      - when: "input_source == 'file_upload'"
        use: python

  - id: euclid-query
    type: mcp_call
    agent: euclid-agent
    action: parse_euclid_catalog
    depends_on: [coord-extractor]
    when: "input_source == 's3_path'"
    mcp:
      server: euclid-catalog
      tool: get_catalog_info_with_stats
      input:
        catalog_path: "{{s3_path}}"
    on_fail:
      action: continue
      guidance: "主工具失败时转 fallback: parse_fits_header_only"

  - id: euclid-query-fallback
    type: mcp_call
    agent: euclid-agent
    action: parse_euclid_catalog_fallback
    depends_on: [euclid-query]
    when: "step.euclid-query.failed == true"
    mcp:
      server: euclid-catalog
      tool: parse_fits_header_only
      input:
        catalog_path: "{{s3_path}}"
    on_fail:
      action: stop
      guidance: "Euclid catalog 解析失败，请检查 S3 路径或权限"

  - id: euclid-normalize
    type: transform
    agent: euclid-agent
    action: normalize_euclid_region
    depends_on: [coord-extractor, euclid-query, euclid-query-fallback]
    output_mapping:
      ra_min: "normalized.ra_min"
      ra_max: "normalized.ra_max"
      dec_min: "normalized.dec_min"
      dec_max: "normalized.dec_max"
      center_ra: "normalized.center_ra"
      center_dec: "normalized.center_dec"
      euclid_num_objects: "normalized.num_objects"

  - id: desi-query
    type: mcp_call
    agent: desi-agent
    action: desi_es_query_search
    depends_on: [euclid-normalize]
    mcp:
      server: astro_k3s_mcp
      tool: es_query
      input:
        catalog: "{{catalog_name}}"
        mode: "{{desi_mode}}"
        body:
          query:
            bool:
              filter:
                - range:
                    ra:
                      gte: "{{ra_min}}"
                      lte: "{{ra_max}}"
                - range:
                    dec:
                      gte: "{{dec_min}}"
                      lte: "{{dec_max}}"
                - term:
                    brick_primary: "{{brick_primary_only}}"
          from: 0
          size: "{{top_k}}"
    output_mapping:
      desi_hits_total: "response.data.result.hits.total.value"
      desi_hits_rows: "response.data.result.hits.hits"

  - id: region-adjust-gate
    type: human_gate
    agent: filter-agent
    action: request_region_adjustment_if_zero_hits
    depends_on: [desi-query]
    when: "desi_hits_total == 0"
    plugin:
      name: octto
      tool: create_review_task
      input:
        reason: "DESI search returned 0 hits"
        suggestion: "请调整天区范围或更换中心坐标"

  - id: crossmatch
    type: transform
    agent: crossmatch-agent
    action: positional_crossmatch
    depends_on: [euclid-normalize, desi-query, region-adjust-gate]

  - id: preview-export
    type: export
    agent: reporter-agent
    action: export_preview
    depends_on: [crossmatch]

  - id: human-filter-gate
    type: human_gate
    agent: filter-agent
    action: request_filter_condition
    depends_on: [preview-export]
    plugin:
      name: octto
      tool: create_filter_form

  - id: filtered-export
    type: export
    agent: reporter-agent
    action: export_filtered_result
    depends_on: [human-filter-gate]
---

# Euclid x DESI MCP Playbook

This playbook keeps the MVP step ids for current runner compatibility and adds explicit MCP details.

1. Parse input source (`s3://`, `RA/DEC`, uploaded file).
2. Parse Euclid catalog from MCP with fallback.
3. Normalize Euclid output into a stable query window.
4. Query DESI via `astro_k3s_mcp.es_query` in `mode=search`.
5. If `hits=0`, trigger human region-adjust gate.
6. Export preview, collect filter input, and export filtered files.
