# desi-agent

- Role: provide DESI-side candidate attributes and brick-based image linkage.

## Responsibilities

1. Query DESI DR10 tractor rows for crossmatch workflow.
2. For single-catalog Euclid flow, compute/derive `brickname` by RA/DEC (`desiutil` worker).
3. Produce nullable DESI path fields for every candidate row:
   - `desi_fits_g_path`
   - `desi_fits_r_path`
   - `desi_fits_i_path`
   - `desi_fits_z_path`
   - `desi_tractor_i_fits_path`

## Notes

- Path columns are mandatory in schema, values may be null.
- If DESI query is skipped in Euclid-only workflow, paths should still be derived when brickname is available.
