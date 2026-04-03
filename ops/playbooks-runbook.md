# Playbooks Runbook (MVP)

## Local pipeline run

```bash
export OPENAI_API_KEY=<your_key>
npm run run:mvp
```

Or use `direnv` with a local `.envrc` (gitignored) to auto-load `OPENAI_API_KEY`.

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

## Build image (local)

```bash
podman build -f ops/Dockerfile.orchestrator -t astro-code/opencode:dev .
podman save -o /tmp/astro-code-opencode-dev.tar astro-code/opencode:dev
sudo k3s ctr images import /tmp/astro-code-opencode-dev.tar
```

If `k3s ctr images import` asks for sudo password, run it manually in your own terminal.

## Push image to registry

```bash
TAG=v$(date +%Y%m%d-%H%M%S)
podman tag localhost/astro-code/opencode:dev crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/astro-code/opencode:${TAG}
podman push crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/astro-code/opencode:${TAG}
```

If `astro-code/opencode` push fails with `insufficient_scope`, use namespace fallback:

```bash
podman tag localhost/astro-code/opencode:dev crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/opencode-docker:${TAG}
podman push crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/opencode-docker:${TAG}
```

Create pull secret from current podman login:

```bash
kubectl -n astro-code create secret generic crpi-regcred \
  --from-file=.dockerconfigjson=$XDG_RUNTIME_DIR/containers/auth.json \
  --type=kubernetes.io/dockerconfigjson \
  --dry-run=client -o yaml | kubectl apply -f -
```

## Package Helm chart

```bash
mkdir -p dist/helm
helm lint helm/astro-code
helm package helm/astro-code -d dist/helm
```

## Deploy to local k3s

```bash
helm upgrade --install astro-code helm/astro-code \
  -n astro-code \
  --create-namespace \
  -f helm/astro-code/values.local.yaml

kubectl -n astro-code get pods,svc,pvc
kubectl -n astro-code logs deploy/astro-code --tail=100
kubectl -n astro-code port-forward svc/astro-code 4000:4000
```

Deploy with pushed image + pull secret:

```bash
helm upgrade --install astro-code helm/astro-code \
  -n astro-code \
  --create-namespace \
  -f helm/astro-code/values.local.yaml \
  --set image.repository=crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/opencode-docker \
  --set image.tag=${TAG} \
  --set image.pullPolicy=IfNotPresent \
  --set imagePullSecrets[0].name=crpi-regcred \
  --set initSeed.enabled=true \
  --set opencode.serverPassword=
```

Fallback when local image import is not available:

```bash
helm upgrade --install astro-code helm/astro-code \
  -n astro-code \
  --create-namespace \
  -f helm/astro-code/values.local.yaml \
  --set image.repository=ghcr.io/nimbleflux/opencode-docker \
  --set image.tag=1.3.13 \
  --set image.pullPolicy=IfNotPresent \
  --set initSeed.enabled=false \
  --set opencode.serverPassword=
```

## Uninstall

```bash
helm uninstall astro-code -n astro-code
kubectl delete ns astro-code
```
