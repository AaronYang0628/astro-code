# local-k8s-oneclick-deploy

- Goal: one-command update for local联调 (image build + Helm deploy + rollout check).
- Preferred command: `npm run deploy:k8s`.
- Default behavior:
  - Build local image with timestamp tag.
  - Push to `REGISTRY_IMAGE` (default aliyun registry).
  - `helm upgrade --install` with `helm/astro-code/values.local.yaml`.
  - Wait for rollout and print `kubectl get pods,svc`.
- Local-only cluster variant (skip push):
  - `PUSH_IMAGE=0 IMPORT_TO_K3S=1 npm run deploy:k8s`.
- Local development setup command:
  - `npm run deploy:dev` (install deps + run local smoke by default).
- Key env overrides:
  - `TAG`, `REGISTRY_IMAGE`, `NAMESPACE`, `RELEASE_NAME`, `VALUES_FILE`.
  - `BUILD_LOCAL_IMAGE`, `PUSH_IMAGE`, `IMPORT_TO_K3S`, `RUN_SMOKE`.
