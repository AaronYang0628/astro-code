# astro-code

专注于 Euclid x DESI MVP 流程的多智能体天文学工作流项目。

## MVP 范围

- 输入：`RA/DEC` 文本、上传的 `CSV/FITS`、或 `s3://bucket/key`
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
- `py/workers/`: Python 辅助脚本，用于 CSV/FITS 坐标提取
- `.opencode/agents|skills|plugins/`: 智能体运行时契约
- `runs/`: 运行时输出（`crossmatch.csv`、`preview_100.csv`、`filtered.csv`）
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

- `crossmatch.csv`
- `preview_100.csv`
- `filtered.csv`
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
| `file_upload` | CSV/FITS 文件上传 | 参见 `examples/request.file.json` |
| `s3_uri` | S3 路径 | 参见 `examples/request.s3.json` |

### 输出位置

结果写入 `runs/<run_id>/`：
- `crossmatch.csv`
- `preview_100.csv`
- `filtered.csv`
- `stats.json`
- `report.md`

## 注意事项

- 上传解析设计为临时文件；Web 层应在提取后删除上传文件。
- `s3://` 输入委托给 MCP 进行权限和检索处理。
- OpenCode 提供商 `apiKey` 通过环境变量 `OPENAI_API_KEY` 注入（`.opencode/opencode.json` 中使用 `{env:OPENAI_API_KEY}`）。
- 建议把本地密钥放在 shell 环境变量或 `.envrc`（direnv）中，不要把密钥提交到 git。
- Octto 通过 `.opencode/opencode.json` 中的 `"plugin": ["octto"]` 启用。

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
