# Decisions

## 2026-04-08 — 交互后端改为可配置

- 决策：交互后端支持 `native|octto|hybrid`，由 `runtime.interaction_backend` 控制。
- 原因：保留原生交互同时支持 octto 扩展，兼顾稳定性与体验可定制。
- 规则补充：`hybrid` 语义固定为“优先 octto，失败再回退 native”。
- 规则补充：仅当用户意图明确为“执行交叉匹配”时进入分步执行；参数提及本身不等于执行意图。

## 2026-04-09 — 默认交互后端改为 native

- 决策：默认 `runtime.interaction_backend` 从 `hybrid` 调整为 `native`。
- 原因：当前优先保证交互稳定性，octto 暂不作为默认路径。
- 约束：保留 `octto|hybrid` 接口与契约文件，不删除相关能力；仅下调默认开关与默认配置。

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

## 2026-04-07 — 执行前播报与阶段进度强制化

- 决策：执行前必须先播报任务与关键参数；每次 MCP 调用前必须打印阶段与查询说明。
- 原因：避免“无感知执行”，提高用户对当前步骤与耗时阶段的可见性。

## 2026-04-07 — 产物路径统一落在 runs/<run_id>

- 决策：会话执行与本地回归都应保持 run 目录输出模型。
- 原因：防止结果散落到 workspace 根目录，便于排错与追溯。
