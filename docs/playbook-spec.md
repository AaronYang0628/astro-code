# Playbook Spec (MVP)

Playbooks are markdown files with YAML frontmatter.

## Required frontmatter keys

- `id`: workflow id
- `version`: semantic version
- `steps`: ordered list of steps

## Step fields

- `id`: unique step id
- `agent`: owning agent
- `action`: action identifier
- `depends_on`: optional list of parent step ids

## Required step ids for current runner

- `input-router`
- `coord-extractor`
- `euclid-query`
- `desi-query`
- `crossmatch`
- `preview-export`
- `human-filter-gate`
- `filtered-export`

## Human-in-the-loop behavior

The runner writes `human_gate_request.json` into run directory.
If `human_gate_response.json` exists, it is used as filter condition.
If not present, pipeline continues with no filter.
