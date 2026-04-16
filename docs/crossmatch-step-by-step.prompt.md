# Crossmatch Step-by-Step Prompt (Web/TUI)

Use this preset to force visible, one-step-at-a-time execution in Web/TUI.

```text
进入“星表交叉匹配分步执行模式”，严格遵守：

1) 一次只执行一步；每步只允许一个动作或一条命令。
2) 每步先输出：
   Step N
   Goal: <本步目标>
   Action: <本步动作/命令，不要在交互展示中使用 npx>
3) 执行后输出：
   Result: <关键结果，3-6行摘要>
   Next: <下一步>
4) 默认自动进入下一步，不要每步都等待“继续”。
5) 仅在需要用户决策时暂停并等待输入：
   - 命中为0时选择半径（1/2/3/5 arcsec）
   - 是否进入结果筛选（confirm）
   - 多条件筛选参数填写
6) 所有决策点必须通过当前交互后端执行（`native|octto|hybrid`，由 `runtime.interaction_backend` 决定）。
   默认后端为 `native`（仅 OpenCode 原生交互）。
   不允许用纯文本问答替代决策。
   若后端不可用：立即报错并停止，不得静默降级。
7) 不允许“口头判断不可用”。必须先真实调用一次后端交互再下结论。
   - 若调用成功：继续流程。
   - 若调用失败：输出原始工具错误，再停止。
8) 若失败：先给 Failed 原因，再给 Fix Step（最小修复动作），修复后继续执行。
9) 仅做当前步骤所需最小操作，不做大范围仓库扫描。
10) 全程保持同一会话（MCP + 当前交互后端 + 后续步骤）。

本次输入参数：
RA=51.12015772112324
DEC=-26.971838908444358
radiusArcsec=250.0
catalog=desi-dr10-tractor
mode=search
size=100
brick_primary=true

执行顺序：
0. 先做“交互后端能力自检”：调用当前后端的 confirm（问题：`交互能力检查，继续执行吗？`）
   - 成功才进入 Step 1
   - 失败则输出工具原始报错并停止
1. 输出匹配参数（RA/DEC、radiusArcsec、window、topK/hits占位）
2. 构建查询窗口并执行 DESI 查询
3. 返回 hits_total 和前3条样例
4. 执行交叉匹配
5. 若 hits=0：发起半径选择弹框（1/2/3/5 arcsec），阻塞等待我提交，再继续
6. 若有结果：先输出 preview 摘要（preview rows、可筛选字段、前10条样例）
7. 发起当前后端 confirm：是否进入结果筛选？
8. 仅当我回答“是”时，收集多条件筛选并应用
9. 最终逐行输出文件绝对路径：
   candidate_pool.csv
   preview_100.csv
   preview_summary.json
   filtered.csv
   report.md
   result_index.json
   （若存在）region_adjust_request.json

开始执行完整流程；仅在需要我决策时暂停等待输入。
```

## Quick Trigger Examples

RA/DEC input:

```text
按 docs/crossmatch-step-by-step.prompt.md 执行。
本次输入：RA=150.114, DEC=-2.345, radiusArcsec=5, catalog=desi-dr10-tractor, mode=search, size=100, brick_primary=true。
开始执行完整流程；仅在需要我决策时暂停。
```

S3 input:

```text
按 docs/crossmatch-step-by-step.prompt.md 执行。
本次输入：input_source=s3_path, s3_path=s3://your-bucket/path/to/catalog.fits, radiusArcsec=5, catalog=desi-dr10-tractor, mode=search, size=100, brick_primary=true。
开始执行完整流程；仅在需要我决策时暂停。
```
