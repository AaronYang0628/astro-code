# Session Start Runbook

每次新会话建议按以下顺序执行，避免重复沟通成本。

## 1) 读取项目上下文

- `.opencode/PROJECT_CONTEXT.md`
- `.opencode/DECISIONS.md`
- `TODO.md`

## 2) 环境快速检查

- `opencode debug config`
- `opencode mcp list`
- `kubectl -n astro-code get pods,svc`

## 3) 运行模式确认

- 优先 OpenCode 会话内执行（MCP + 配置化交互后端 native/octto/hybrid）
- 默认后端为 `native`（仅 OpenCode 原生交互）
- `npm run` 仅用于本地回归，不与实时会话混用

## 4) 测试入口建议

- Web 侧提示词：`docs/opencode-web-testing.md`
- 本地回归：`docs/local-npm-regression.md`

## 5) 输出规范（必须）

- 打印匹配参数
- 打印 preview 摘要与 markdown 表格样例
- 打印结果文件绝对路径：
  - `candidate_pool.csv`
  - `preview_100.csv`
  - `preview_summary.json`
  - `filtered.csv`
  - `report.md`
  - `result_index.json`

## 6) 本会话开场模板（可复制）

```text
先读取 .opencode/PROJECT_CONTEXT.md、.opencode/DECISIONS.md、TODO.md，然后按项目既定流程执行：
1) 先检查 MCP 与部署状态
2) 按 Euclid x DESI 主流程跑一轮
3) 输出匹配参数、preview markdown 表格、结果文件路径
4) 如需筛选，按 `runtime.interaction_backend` 使用 native/octto/hybrid 继续
```
