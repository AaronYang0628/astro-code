# fits-cutout service scaffold

This directory contains the core `execute_cutout_group` implementation for the
`fits-cutout` MCP tool contract used by orchestrator.

## Implemented contract

- Tool name: `execute_cutout_group`
- Input fields:
  - `run_id`
  - `telescope` (`euclid|desi`)
  - `band`
  - `source_uri` (local path or `s3://`)
  - `targets` (required array with `obj_id,row_index,ra_deg,dec_deg`, optional `tile_index,brickname`)
  - `size_deg`
  - `output_prefix`
  - `resolve_wildcard`
- Output fields:
  - `resolved_source_uri`
  - `results[]` with `status,row_index,obj_id,ra_deg,dec_deg,output_uri|error,meta`
  - optional top-level `error`

## Run locally

```bash
python3 py/mcp/fits_cutout/service.py --input-json /path/to/payload.json
```

The script prints one JSON response line to stdout.

## Notes

- This module reuses cutout core logic from `py/cutout/core.py`.
- For `s3://` paths, `astropy` is opened with `use_fsspec=True`.
- Output files are written to:
  - `<output_prefix>/<run_id>/<telescope>/<band>/...fits`
