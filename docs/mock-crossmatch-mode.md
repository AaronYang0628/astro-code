# Mock Crossmatch Mode (for non-overlap sky coverage)

When Euclid and DESI coverage barely overlap in current ES data, you can enable
a deterministic DESI mock fallback to keep Phase-2 pipeline development moving.

Default is disabled (`DESI_MOCK_ENABLE` unset/false).

## Why

- Real `desi_rows` may be `0` even after retry window expansion.
- Downstream tasks (T2 path resolver, cutout indexing, QC/sampling wiring) still
  need non-empty candidate rows for integration tests.

## How it works

- Trigger condition:
  - real DESI query returns 0 rows (after retry)
  - `DESI_MOCK_ENABLE=true`
- Fallback behavior:
  - query real DESI seed rows from MCP/ES first
  - clone real DESI metadata fields (`brickname`, `maskbits`, `flux*`, `type`, ...)
  - only reposition RA/DEC near Euclid rows (small jitter) so crossmatch can proceed
  - write mock origin metadata into `desi_origin.json`
  - mark path lineage with `path_source=mock`

## Environment variables

- `DESI_MOCK_ENABLE=true` enable fallback mode
- `DESI_MOCK_MAX_ROWS=<n>` max synthetic rows (default: `topK`)
- `DESI_MOCK_JITTER_ARCSEC=<float>` coordinate jitter in arcsec
- `DESI_MOCK_MIN_CROSSMATCH_ROWS=<n>` minimum target rows for crossmatch (default: `10`)
- `DESI_MOCK_TILE_INDEX=<tile>` fallback tile index for generated Euclid rows (default: `102018211`)

## Example

```bash
DESI_MOCK_ENABLE=true DESI_MOCK_MAX_ROWS=200 DESI_MOCK_MIN_CROSSMATCH_ROWS=10 DESI_MOCK_JITTER_ARCSEC=0.2 \
npm run run -- --request /tmp/request.t1.verify.json --playbook playbooks/euclid_desi_mvp.playbook.md --config pipeline.config.yaml
```

## Audit signals in outputs

- `report.md` contains:
  - `desi_mock_applied: yes/no`
  - `desi_mock_reason: ...`
- `stats.json` contains:
  - `desi_mock_applied`
  - `desi_mock_reason`
- `desi_origin.json` contains:
  - `backend_type: mock_seeded_from_real_desi`

- `candidate_pool.csv` contains:
  - `path_source=mock`
  - derived Euclid/DESI path fields for downstream T2 validation

## Important

- This mode is for development/integration only.
- Do not use mock-generated pairs for scientific statistics or model quality claims.
