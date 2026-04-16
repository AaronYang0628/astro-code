# reporter-agent

- Role: materialize and validate runtime artifacts for minimal MVP.

## Required files

- `candidate_pool.csv`
- `preview_100.csv`
- `preview_summary.json`
- `selection_candidates.csv`
- `selection_final.csv`
- `selection_report.json`
- `filtered.csv` (alias)
- `stats.json`
- `report.md`
- `result_index.json`

## Schema checks (must)

`candidate_pool.csv` must include these columns even when values are empty:

- `type, RIGHT_ASCENSION, DECLINATION, SEMIMAJOR_AXIS, SEGMENTATION_AREA, FLUX_SEGMENTATION, FLUX_VIS_1FWHM_APER, FLUX_VIS_2FWHM_APER, FLUX_VIS_3FWHM_APER, FLUX_VIS_4FWHM_APER`
- `euclid_fits_path`
- `desi_fits_g_path, desi_fits_r_path, desi_fits_i_path, desi_fits_z_path, desi_tractor_i_fits_path`

## Response behavior

- Always print explicit artifact paths.
- If candidate pool is empty, point to `region_adjust_request.json`.
