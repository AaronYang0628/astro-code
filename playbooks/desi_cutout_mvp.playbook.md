---
id: desi_cutout_mvp
version: 0.1.0
description: DESI single-catalog candidate-pool + selection + cutout aligned workflow (MVP scaffold)
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
  query_mode: search
steps:
  - id: input-router
    type: input
    agent: orchestrator-agent
    action: detect_input_source
    required: true

  - id: coord-extractor
    type: route
    agent: orchestrator-agent
    action: extract_coord_by_source
    depends_on: [input-router]

  - id: euclid-query
    type: transform
    agent: orchestrator-agent
    action: skip_euclid_for_single_catalog
    depends_on: [coord-extractor]

  - id: desi-query
    type: mcp_call
    agent: desi-agent
    action: desi_es_query_search
    depends_on: [coord-extractor]

  - id: crossmatch
    type: transform
    agent: orchestrator-agent
    action: build_candidate_pool_from_single_desi
    depends_on: [euclid-query, desi-query]

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

# DESI Single-Catalog Cutout Playbook (Scaffold)

This playbook defines the DESI-only entry route and keeps the same downstream
candidate-pool + six-condition selection flow as other pipeline modes.
