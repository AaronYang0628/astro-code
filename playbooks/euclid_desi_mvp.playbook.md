---
id: euclid_desi_mvp
version: 0.3.0
description: Euclid x DESI minimal MVP pipeline with candidate pool + six-condition selection
meta:
  mode: configurable_backend
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

  - id: selection-plan
    type: human_gate
    agent: filter-agent
    action: request_selection_plan
    depends_on: [preview-export]

  - id: filtered-export
    type: export
    agent: reporter-agent
    action: export_selection_result
    depends_on: [selection-plan]
---

# Euclid x DESI Minimal MVP Playbook

This playbook keeps compatibility with current runner and focuses on minimal MVP:

1. Parse input source (`s3://` or `RA/DEC`).
2. Query Euclid and DESI data.
3. Build candidate pool (`candidate_pool.csv`).
4. If candidate pool is zero, use region-adjust decision gate.
5. Export preview and run six-condition selection planning.
6. Export selection outputs and final artifacts.
