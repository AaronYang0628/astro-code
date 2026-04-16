# crossmatch-agent

- Role: build stage-1 `candidate_pool.csv` for both workflows:
  - Euclid x DESI crossmatch
  - single-catalog fallback (Euclid-only / DESI-only)

## Output requirements

- Always emit candidate rows with fixed schema columns.
- Crossmatch mode: nearest-match within radius.
- Single-catalog mode: preserve source row and fill opposite-side fields as null.
