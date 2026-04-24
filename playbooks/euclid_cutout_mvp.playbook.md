---
id: euclid_cutout_mvp
version: 0.1.0
description: Euclid single-catalog candidate-pool + selection + cutout aligned workflow (MVP scaffold)
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
  catalog_name: euclid-q1-mer-final
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
    type: mcp_call
    agent: euclid-agent
    action: euclid_es_query_search
    depends_on: [coord-extractor]

  - id: desi-query
    type: transform
    agent: orchestrator-agent
    action: skip_desi_for_single_catalog
    depends_on: [euclid-query]

  - id: crossmatch
    type: transform
    agent: orchestrator-agent
    action: build_candidate_pool_from_single_euclid
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

  - id: cutout-execute
    type: mcp_call
    agent: orchestrator-agent
    action: execute_grouped_cutout
    depends_on: [filtered-export]
---

# Euclid Single-Catalog Cutout Playbook (Scaffold)

This playbook defines the Euclid-only entry route and keeps the same downstream
candidate-pool + six-condition selection flow as the crossmatch pipeline.
