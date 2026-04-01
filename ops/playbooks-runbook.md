# Playbooks Runbook (MVP)

## Local run

```bash
npm run run:mvp
```

## Alternative input examples

```bash
npm run run -- --request examples/request.s3.json --playbook playbooks/euclid_desi_mvp.playbook.md --config pipeline.config.yaml
npm run run -- --request examples/request.file.json --playbook playbooks/euclid_desi_mvp.playbook.md --config pipeline.config.yaml
```

## Runtime outputs

Inspect `runs/<run_id>/` for all generated artifacts.

## Troubleshooting

- Python extractor errors: verify `python3` and `astropy` are installed.
- No filter applied: provide `filter` in request JSON or create `human_gate_response.json`.
- Empty crossmatch: increase `radiusArcsec` or verify MCP query output.
