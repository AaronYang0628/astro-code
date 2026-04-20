# astro-code

专注于 Euclid x DESI MVP 流程的多智能体天文学工作流项目。

## MVP 范围

- 输入：`RA/DEC` 文本或 `s3://bucket/key`
- 通过确定性路由提取坐标
- 查询 Euclid 和 DESI MCP 适配器
- 在 DESI 查询前将 Euclid 输出规范化为稳定的区域字段
- 可配置半径的交叉匹配（默认 `1.0 角秒`）
- 仅输出到文件（无数据库）
- 通过 Web（主要）和 CLI（辅助）进行人工介入过滤

## 项目结构

- `.opencode/opencode.json`: OpenCode 运行时模型/提供者/MCP/plugin 配置（数据源）
- `pipeline.config.yaml`: 工作流管道运行时配置
- `playbooks/`: Markdown frontmatter 格式的工作流剧本
- `src/orchestrator/`: TypeScript 编排在 MVP 实现
- `py/workers/`: Python 辅助脚本（用于本地数据处理工具）
- `.opencode/agents|skills|plugins/`: 智能体运行时契约
- `runs/`: 运行时输出（`status.json`、`candidate_pool.csv`、`preview_10.csv`、`selection_final.csv`）
- `docs/`: 架构和契约文档

## 快速开始

1) 安装依赖

```bash
npm install
python3 -m pip install -r py/requirements.txt
```

2) 使用示例 RA/DEC 输入运行 MVP

```bash
npm run run:mvp
```

3) 检查 `runs/<run_id>/` 下的输出文件

- `candidate_pool.csv`
- `preview_10.csv`
- `selection_final.csv`（仅在明确完成六条件筛选后生成）
- `stats.json`
- `report.md`

## 测试

### 快速测试（使用示例数据）

```bash
npm run run:mvp
```

这将使用内置的示例请求运行，坐标为 `150.114000, -2.345000`。

### 自定义测试

创建自定义请求 JSON 文件，然后运行：

```bash
npx tsx src/orchestrator/index.ts \
  --request <your_request.json> \
  --playbook playbooks/euclid_desi_mvp.playbook.md \
  --config pipeline.config.yaml
```

### 支持的输入类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `radec_text` | 直接 RA,DEC 坐标 | `{"input":{"type":"radec_text","value":"150.114,-2.345"}}` |
| `s3_uri` | S3 路径 | 参见 `examples/request.s3.json` |

### 输出位置

结果写入 `runs/<run_id>/`：
- `candidate_pool.csv`
- `preview_10.csv`
- `selection_final.csv`
- `stats.json`
- `report.md`
- `result_index.json`
- `input_manifest.json`
- `status.json`（实时阶段/状态/错误信息）
- `desi_origin.json`（DESI 来源元数据：ES/S3/local 提示 + 若暴露则包含源路径）
- `mcp/desi_search_query.json`
- `mcp/desi_search_initial.raw.json`
- `mcp/desi_search_sample.raw.json`
- `mcp/desi_search_retry.raw.json`（仅在触发 retry 时）
- `mcp/desi_search_retry_sample.raw.json`（仅在触发 retry 时）

所有产物文件均写入 `runs/<run_id>/` 目录。

## 执行策略

- Web 与 CLI 现在使用同一条 TypeScript orchestrator 执行内核。
- 两个入口都走同一状态机（MCP 查询 + crossmatch + human gate + 导出）。
- 每次运行会先写入 `runs/<run_id>/status.json`，随后持续更新阶段、统计与产物信息。

## 注意事项

- `file_upload` 已按策略禁用；请使用 `s3://` 或直接 `RA/DEC` 输入。
- `s3://` 输入委托给 MCP 进行权限和检索处理。
- OpenCode 提供商 `apiKey` 通过环境变量 `AI_MODEL_KEY` 注入（`.opencode/opencode.json` 中使用 `{env:AI_MODEL_KEY}`）。
- 建议把本地密钥放在 shell 环境变量或 `.envrc`（direnv）中，不要把密钥提交到 git。
- 在 k8s Helm 部署中，请设置 `opencode.aiModelKey`，Chart 会通过 Secret 将其注入为 Pod 环境变量 `AI_MODEL_KEY`。
- 交互后端可通过 `pipeline.config.yaml` 中 `runtime.interaction_backend` 配置（默认：`native`）：
  - `native`：仅 OpenCode 原生弹框
  - `octto`：仅 octto 交互
  - `hybrid`：优先 octto，失败时切 native
- 本地 cutout worker（无需单独 MCP 服务）：`py/workers/cutout_stamp_worker.py`。

## Cutout 小图（本地 worker）

建议使用筛选后的 `selection_final.csv` 生成 Euclid/DESI FITS stamp：

```bash
python3 py/workers/cutout_stamp_worker.py \
  --input-csv runs/<run_id>/selection_final.csv \
  --output-dir runs/<run_id>/cutouts
```

说明：

- worker 会按源 FITS 路径分组，同一张图一次打开切多个目标，减少 IO。
- Euclid 使用 `euclid_fits_path`；DESI 使用 `desi_image_g/r/i/z_path`。
- 若 CSV 中是 S3 路径，可通过可重复参数 `--path-map SRC=DST` 做本地映射。
- 输出目录包含 `cutout_index.csv` 与 `cutout_report.json`。

## 远程 cutout MCP 执行

当远程 `fits-cutout` MCP 可用时，orchestrator 可直接对 S3 图像执行分组 cutout（无需本地挂载大文件）。

请求示例：

```json
{
  "workflow": "euclid_cutout",
  "input": { "type": "s3_uri", "value": "s3://.../catalog.fits" },
  "interaction": "web",
  "selection": {
    "conditions": [
      { "id": "oversized_galaxy_filter", "params": { "stamp_size_px": 160 } }
    ]
  },
  "selection_confirmed": true,
  "cutout": {
    "enabled": true,
    "mcp_server": "fits-cutout",
    "output_prefix": "s3://data-and-computing/projects/CSST/shared-data/astro/cutouts",
    "size_deg": 0.008,
    "desi_bands": ["g", "r", "i", "z"]
  }
}
```

运行产物会新增：

- `cutout_index.csv`
- `cutout_report.json`
- `cutout_raw_reports.json`

## Octto 插件

若要启用 octto 交互，请将 octto 插件契约文件放到：

- `.opencode/plugins/octto-interaction.plugin.md`

运行镜像已预装 npm 包 `octto`，并在 `opencode.json` 中启用对应 plugin。
同时会下发可选运行配置 `.opencode/octto.json`（容器内对应 `/home/opencode/.config/opencode/octto.json`）。

并在 `pipeline.config.yaml` 设置：

```yaml
runtime:
  interaction_backend: octto
```

如需回退策略可使用混合模式：

```yaml
runtime:
  interaction_backend: hybrid
```

## OpenCode 测试

使用以下命令在 OpenCode 中测试（不仅仅是 `npm`）：

```bash
opencode debug config
opencode mcp list
NODE_TLS_REJECT_UNAUTHORIZED=0 opencode web --port 7788
```

注意事项：

- `opencode web .` 对此 CLI 版本无效；`web` 子命令不接受项目位置参数。
- 要使用项目配置，请在此仓库根目录运行命令，以便 OpenCode 加载 `.opencode/opencode.json`。
- 对于 TUI，您可以在当前目录使用 `opencode`，或从任何地方使用 `opencode /home/aaron/ZJ_GITLAB/astro-code`。
- 使用 `opencode debug config` 验证加载的配置，并确认 `model`、`mcp` 和自定义 `agent` 条目存在。
- 如果在本地 k8s 中使用自签名 MCP 证书，请使用 `NODE_TLS_REJECT_UNAUTHORIZED=0 opencode mcp list` 进行本地调试。

快速非交互式检查：

```bash
opencode run "只回复: ok" --agent orchestrator-agent --model openai/gpt-5.3-codex
```
