---
id: euclid_desi_mvp
version: 0.1.0
description: Euclid x DESI crossmatch MVP with HITL filtering
defaults:
  radius_arcsec: 1.0
  top_k: 100
  preview_rows: 100
steps:
  - id: input-router
    agent: orchestrator-agent
    action: route_input
  - id: coord-extractor
    agent: orchestrator-agent
    action: extract_coord
    depends_on: [input-router]
  - id: euclid-query
    agent: euclid-agent
    action: query_catalog_mcp
    depends_on: [coord-extractor]
  - id: desi-query
    agent: desi-agent
    action: query_catalog_mcp
    depends_on: [coord-extractor]
  - id: crossmatch
    agent: crossmatch-agent
    action: positional_crossmatch
    depends_on: [euclid-query, desi-query]
  - id: preview-export
    agent: reporter-agent
    action: export_preview
    depends_on: [crossmatch]
  - id: human-filter-gate
    agent: filter-agent
    action: request_filter_condition
    depends_on: [preview-export]
  - id: filtered-export
    agent: reporter-agent
    action: export_filtered_result
    depends_on: [human-filter-gate]
---

# Euclid x DESI MVP Playbook

This playbook is the minimal end-to-end example:

1. Parse coordinate input.
2. Query Euclid and DESI MCP adapters.
3. Crossmatch by angular distance.
4. Export preview and ask for a user filter.
5. Export filtered output files.
