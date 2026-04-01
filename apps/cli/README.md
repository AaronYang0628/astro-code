# CLI Interaction (MVP)

CLI mode is mainly for developer testing.

## Run example

```bash
npm run run -- --request examples/request.radec.json --playbook playbooks/euclid_desi_mvp.playbook.md --config pipeline.config.yaml
```

## Provide inline filter in request JSON

```json
{
  "input": { "type": "radec_text", "value": "150.114,-2.345" },
  "filter": { "field": "desi_mag", "op": "<=", "value": 20 }
}
```
