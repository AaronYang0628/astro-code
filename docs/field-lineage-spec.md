# Field Lineage Spec (T1 Candidate Schema)

This document defines where each crossmatch candidate field comes from, including:

- MCP server/tool
- response location
- source field
- transform/fallback rules

It is the canonical reference for Phase-2 T1 field provenance.

## Runtime Context

- Euclid query path:
  - `astro_k3s_mcp.es_query` against catalog `euclid-q1-mer-final` (RA/DEC route)
  - `euclid-catalog.get_catalog_objects` (s3 route)
- DESI query path:
  - `astro_k3s_mcp.es_query` against catalog `desi-dr10-tractor`
- Crossmatch merge:
  - nearest-neighbor match within `radius_arcsec` (best per Euclid source)

## Required T1 Fields

| output field | source catalog | MCP server/tool | source location | source field | transform | fallback |
| --- | --- | --- | --- | --- | --- | --- |
| `obj_id` | DESI preferred / Euclid fallback | `astro_k3s_mcp.es_query` + `euclid-catalog.get_catalog_objects` | DESI: `data.result.hits.hits[*]._source`; Euclid: `objects[*]` | DESI: `OBJECT_ID` or `_id`; Euclid: `OBJECT_ID` | String mapping | fallback to Euclid `OBJECT_ID` |
| `ra` | DESI | `astro_k3s_mcp.es_query` | `data.result.hits.hits[*]._source` | `ra` | numeric cast | none |
| `dec` | DESI | `astro_k3s_mcp.es_query` | `data.result.hits.hits[*]._source` | `dec` | numeric cast | none |
| `type` | DESI preferred / Euclid fallback | `astro_k3s_mcp.es_query` + `euclid-catalog.get_catalog_objects` | DESI `_source`; Euclid `objects[*]` | DESI `type`; Euclid `TYPE`/`EXTENDED_FLAG` | normalized string | `unknown` |
| `tile_index` | Euclid | `astro_k3s_mcp.es_query` + `euclid-catalog.get_catalog_objects` + `euclid-catalog.resolve_tile_id` | Euclid `_source` / `objects[*]` / `resolve_tile_id` response | `TILE_INDEX`/`tile_index`/`TILEID` or `tile_id` | String mapping (fallback to resolver; when `s3_uri`, pass `catalog_path` so resolver can parse filename/header before mock) | `null` + `tile_index_missing` |
| `brickname` | DESI | `astro_k3s_mcp.es_query` | `data.result.hits.hits[*]._source` | `brickname` | String mapping | `null` + `brickname_missing` |
| `maskbits` | DESI preferred / Euclid fallback | `astro_k3s_mcp.es_query` + `euclid-catalog.get_catalog_objects` | DESI `_source`; Euclid `_source`/`objects[*]` | DESI `maskbits`; Euclid `MASKBITS` | numeric cast | `null` + `maskbits_missing` |
| `mag_proxy` | DESI preferred / Euclid fallback | `astro_k3s_mcp.es_query` + `euclid-catalog.get_catalog_objects` | DESI `_source`; Euclid `_source`/`objects[*]` | DESI `flux_r` or `mag_*`; Euclid `FLUX_VIS_1FWHM_APER` or `MAG_*` | DESI: `22.5 - 2.5*log10(flux_r)`; Euclid: `23.9 - 2.5*log10(flux_vis_1fwhm_aper)` | `null` + `mag_proxy_missing` |
| `seg_area` | Euclid preferred / DESI fallback | `astro_k3s_mcp.es_query` + `euclid-catalog.get_catalog_objects` | Euclid `_source`/`objects[*]`; DESI `_source` | `SEGMENTATION_AREA`/`seg_area` | numeric cast | `null` + `seg_area_missing` |

## Additional Leveraged Fields (already included in `crossmatch.csv`)

| output field | source catalog | MCP server/tool | source field |
| --- | --- | --- | --- |
| `flux_g`,`flux_r`,`flux_i`,`flux_z`,`flux_w1`,`flux_w2` | DESI | `astro_k3s_mcp.es_query` | `flux_*` |
| `shape_r`,`shape_e1`,`shape_e2`,`sersic` | DESI | `astro_k3s_mcp.es_query` | `shape_r`,`shape_e1`,`shape_e2`,`sersic` |
| `ref_id`,`release`,`brick_primary` | DESI | `astro_k3s_mcp.es_query` | `ref_id`,`release`,`brick_primary` |
| `allmask_r`,`anymask_r`,`fracmasked_r`,`fracin_r`,`fracflux_r`,`fiberflux_r` | DESI | `astro_k3s_mcp.es_query` | same names |
| `euclid_det_quality_flag`,`euclid_flag_vis` | Euclid | `astro_k3s_mcp.es_query` / `euclid-catalog.get_catalog_objects` | `DET_QUALITY_FLAG`,`FLAG_VIS` |
| `euclid_point_like_flag`,`euclid_extended_flag` | Euclid | `astro_k3s_mcp.es_query` / `euclid-catalog.get_catalog_objects` | `POINT_LIKE_FLAG`,`EXTENDED_FLAG` |
| `euclid_semimajor_axis` | Euclid | `astro_k3s_mcp.es_query` / `euclid-catalog.get_catalog_objects` | `SEMIMAJOR_AXIS` |
| `euclid_flux_vis_1fwhm_aper`,`euclid_flux_vis_2fwhm_aper`,`euclid_flux_vis_3fwhm_aper`,`euclid_flux_vis_4fwhm_aper`,`euclid_flux_vis_psf`,`euclid_flux_vis_sersic` | Euclid | `astro_k3s_mcp.es_query` / `euclid-catalog.get_catalog_objects` | corresponding `FLUX_VIS_*` |
| `tile_index_source` | derived | orchestrator | `euclid.native_field` or `euclid.resolve_tile_id:<method>` or `pending_ra_dec_to_tile_mapping` |
| `mag_proxy_source` | derived | orchestrator | source tag of proxy magnitude derivation |

## Known Gap

- `tile_index` is now resolver-backed when native Euclid fields are missing.
- Remaining `tile_index_missing` rows indicate resolver unavailable or unresolved coordinates at runtime.
