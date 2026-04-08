# Project Context

## 项目目标

本项目是一个基于 OpenCode 的天文数据处理系统，当前主线是 Euclid x DESI 查询/匹配/筛选 MVP。

## 当前主流程（已约定）

1. 输出匹配参数（RA/DEC、半径、窗口、topK、命中数）
2. 执行交叉匹配
3. 若未匹配到，进入人机交互参数调整
4. 若匹配到，输出预览摘要（preview rows、可筛字段、前 10 条样例）
5. 询问用户是否进入筛选
6. 用户确认后进行多条件筛选，并输出结果文件

## 执行可观测性（必须）

- 在首次 MCP 调用前，先输出任务说明与关键参数
- 每个阶段和每次 MCP 调用前输出进度提示
- 上传文件流程先做路径/格式校验，失败要直接报错，不可静默
- 结果统一写入 `runs/<run_id>/`，禁止落在 workspace 根目录

## 关键约束

- 交互后端可配置：`native|octto|hybrid`（由 `runtime.interaction_backend` 控制）
- MCP 优先走 Cluster DNS（可保留 hostAliases 作为兜底）
- 模型密钥与配置解耦：`apiKey` 使用 `{env:AI_MODEL_KEY}`
- 结果必须输出明确文件路径与可读预览

## 当前部署约定

- Helm chart: `helm/astro-code`
- 本地 values: `helm/astro-code/values.local.yaml`
- 镜像仓库: `crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/astro-code`
- 配置模式: `opencodeConfig.mode` (`seed`/`secret`/`external`)

## 当前已知待办

- 稳定 MCP 连通性（当前阻塞测试）
- 筛选交互进一步优化（减少用户操作成本）
- 预览表格在会话侧稳定展示（持续验收）
