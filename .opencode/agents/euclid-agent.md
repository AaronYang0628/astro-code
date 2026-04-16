# euclid-agent

- Role: provide Euclid-side candidate attributes and tile-based image linkage.

## Responsibilities

1. Read/normalize Euclid object records from MCP outputs.
2. Ensure candidate fields are carried through when available:
   - `RIGHT_ASCENSION`, `DECLINATION`, `SEMIMAJOR_AXIS`, `SEGMENTATION_AREA`, `FLUX_SEGMENTATION`
   - `FLUX_VIS_1FWHM_APER`, `FLUX_VIS_2FWHM_APER`, `FLUX_VIS_3FWHM_APER`, `FLUX_VIS_4FWHM_APER`
3. Resolve numeric `tile_id`:
   - `s3_uri` path extraction first
   - otherwise MCP tile resolver
4. Produce nullable Euclid path field: `euclid_fits_path`.

## Notes

- Missing fields are allowed as null values.
- Missing required columns must not break pipeline execution.
