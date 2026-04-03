# Local NPM Regression Guide

Use this file for local replay/regression only.

## Setup

```bash
npm install
python3 -m pip install -r py/requirements.txt
```

If Euclid MCP uses self-signed cert:

```bash
export MCP_INSECURE_TLS=1
```

## Run Cases

### 1) RA/DEC sample

```bash
npm run run:mvp
```

### 1b) Verified matching RA/DEC (recommended for downstream filter flow)

```bash
npm run run -- --request examples/request.radec.match.json --playbook playbooks/euclid_desi_mvp.playbook.md --config pipeline.config.yaml
```

### 1c) Preview-rich RA/DEC profile (recommended)

```bash
npm run run -- --request examples/request.radec.match.radius250.json --playbook playbooks/euclid_desi_mvp.playbook.md --config pipeline.config.yaml
```

### 1d) Multi-condition filter replay

```bash
npm run run -- --request examples/request.radec.match.radius250.filter.json --playbook playbooks/euclid_desi_mvp.playbook.md --config pipeline.config.yaml
```

### 2) Real S3 request

```bash
npm run run -- --request examples/request.s3.json --playbook playbooks/euclid_desi_mvp.playbook.md --config pipeline.config.yaml
```

Optional (radius 3 arcsec):

```bash
npm run run -- --request examples/request.s3.radius3.json --playbook playbooks/euclid_desi_mvp.playbook.md --config pipeline.config.yaml
```

### 3) File upload simulation

```bash
npm run run -- --request examples/request.file.json --playbook playbooks/euclid_desi_mvp.playbook.md --config pipeline.config.yaml
```

## Expected output

Command output should print absolute paths for:

- `crossmatch.csv`
- `preview_100.csv`
- `preview_summary.json`
- `filtered.csv`
- `report.md`
- `result_index.json`

And print preview markdown table (top rows) directly in terminal output.

When no matched rows are found, it should also print:

- `region_adjust_request.json`

## Notes

- Do not mix this local flow with an active Web octto session.
- Web HITL runs should stay entirely in one OpenCode chat session.
