# Decisions

## 2026-04-07 — 交互方案统一为 Native

- 决策：k8s/runtime 中不再依赖 octto，统一使用 OpenCode 原生弹框交互。
- 原因：pod 内无桌面环境，`xdg-open` 路径不稳定，影响流程连续性。

## 2026-04-07 — 密钥命名统一为 AI_MODEL_KEY

- 决策：环境变量由 `OPENAI_API_KEY` 改为 `AI_MODEL_KEY`。
- 原因：模型供应商可变，避免名称绑定 OpenAI。

## 2026-04-07 — 配置与密钥解耦

- 决策：`opencode.json` 中 `apiKey` 固定为 `{env:AI_MODEL_KEY}`。
- 原因：支持快速轮换密钥，无需改动配置文件主体。

## 2026-04-07 — MCP 地址优先 Cluster DNS

- 决策：Euclid MCP 默认使用 `http://euclid-catalog-mcp.mcp.svc.cluster.local:8000/sse`。
- 原因：集群内可达性与稳定性高于 fake domain + hostAlias。

## 2026-04-07 — hostAliases 保留为兜底

- 决策：Helm 保留 `hostAliases` 配置能力。
- 原因：给用户本地/特殊网络环境保留灵活性。

## 2026-04-07 — opencodeConfig 三种模式

- 决策：`opencodeConfig.mode` 支持 `seed` / `secret` / `external`。
- 说明：
  - `seed`：init-seed + config PVC（默认）
  - `secret`：直接挂载 Secret 中的 `opencode.json`
  - `external`：Chart 不管理 config，用户自行挂载

## 2026-04-07 — 结果输出规范化

- 决策：必须输出匹配参数、preview 摘要、markdown 表格样例、结果文件绝对路径。
- 原因：降低用户手动点文件与上下文来回切换成本。
