# OpenCode Web Prompt Pack

This file is prompt-first for Web testing.

## Pre-check (once)

```bash
opencode debug config
opencode mcp list
NODE_TLS_REJECT_UNAUTHORIZED=0 opencode web --port 7788
```

Expected:

- MCP includes `euclid-catalog` and `astro_k3s_mcp`
- interaction backend follows `pipeline.config.yaml` -> `runtime.interaction_backend` (`native|octto|hybrid`)
- default backend is `hybrid` (octto first, native fallback)
- use one chat session end-to-end (do not switch to local `npm run` mid-task)

## Short Prompt (daily check)

```text
使用这个已验证可命中的坐标执行流程：
RA=51.12015772112324, DEC=-26.971838908444358, radiusArcsec=250.0

步骤：
1) 先输出匹配参数（RA/DEC、radiusArcsec、window、topK、hits）
2) 用 RA/DEC 直接构建查询窗口并查询 desi-dr10-tractor（astro_k3s_mcp.es_query, mode=search,size=100）
3) 执行交叉匹配
4) 若 hits=0，发起当前交互后端让我选半径(1/2/3/5 arcsec)，阻塞等待我提交
5) 收到选择后继续执行后续步骤
6) 如果有匹配结果，先输出 preview 摘要（preview rows、可筛选字段、前10条样例）
7) 使用当前交互后端（native/octto/hybrid）询问我“是否进入结果筛选？”
8) 只有我回答“是”后，才发起多条件筛选（逻辑+多条件），并应用筛选

输出必须包含：
- hits统计（首次/重试）
- preview统计（preview rows / 可筛选字段 / 前3条样例）
- 结果文件绝对路径（逐行）：
crossmatch.csv
preview_100.csv
preview_summary.json
filtered.csv
report.md
result_index.json
（若存在）region_adjust_request.json
```

## Long Prompt (full validation)

```text
请作为 orchestrator-agent 直接执行（不是计划）一次完整 Euclid -> DESI 测试。

输入：
RA=51.12015772112324
DEC=-26.971838908444358
radiusArcsec=250.0

严格顺序：
1) 输出匹配参数（RA/DEC、radiusArcsec、window、topK、hits）
2) 用以上 RA/DEC 构建查询窗口
3) 调 astro_k3s_mcp.es_query：
   catalog=desi-dr10-tractor
   mode=search
   body.size=100
   filter: RA/DEC range + brick_primary=true
4) 解析：
   hits_total = data.result.hits.total.value
   sample_rows = data.result.hits.hits(最多3条)
5) 若 hits_total==0：
   - 发起当前交互后端（hybrid 默认优先 octto，失败回退 native）选择半径（1/2/3/5 arcsec）
   - 阻塞等待我的选择（不要继续其他步骤）
   - 收到后打印：Received selection: radius=<X> arcsec
   - 用所选半径继续执行并给出重试结果
6) 若 crossmatch_rows > 0：
    - 先输出 preview 摘要：`preview rows`、`available filter fields`、前10条样例
    - 通过当前交互后端问用户：是否进入结果筛选？
7) 若用户回答“是”：
    - 发起交互收集完整筛选条件（native/octto/hybrid）：
     {
       "logic": "and",
       "conditions": [
         {"field": "separation_arcsec", "op": "<=", "value": 220},
         {"field": "class_label", "op": "contains", "value": "327"}
       ]
     }
   - 阻塞等待输入并应用筛选
   - 应用筛选并生成 filtered 结果
8) 最终输出：
   - Euclid 坐标范围
   - DESI 首次命中数
   - 若重试：半径与第二次命中数
   - preview统计：`preview rows`、`available filter fields`、前3条样例
   - 示例记录（最多3条）
   - 文件绝对路径（逐行）：
     crossmatch.csv
     preview_100.csv
     preview_summary.json
     filtered.csv
     report.md
     result_index.json
     region_adjust_request.json(如存在)
   - 下一步建议（若 crossmatch=0 也必须给）

约束：
- 不要做大范围仓库扫描
- 不要在会话中混用本地 npm 流程，保持同一会话内 MCP+configured interaction backend+继续执行
```

## One-line Recovery Prompt

```text
先用 RA=51.12015772112324, DEC=-26.971838908444358 执行一次 DESI search，并仅返回 hits_total 和前3条样例。
```

## Minimal full-run trigger

Use this short prompt to force full step-by-step execution:

```text
使用 RA=<ra>，DEC=<dec>，radiusArcsec=<radius> 执行一次完整星表交叉匹配流程。
```

Expected behavior: agent must print each step as `Step / Goal / Action / Result / Next` and only pause at decision gates.

## Step-by-step preset (recommended)

- Reusable preset file: `docs/crossmatch-step-by-step.prompt.md`
- Use this preset when you need visible step-by-step execution.
- It auto-continues by default and pauses only when user decisions are required (radius adjust / filter confirm / filter conditions).

## Notes for current test profile

- This RA/DEC + `radiusArcsec=250` profile is for preview/filter UX development.
- It is expected to return enough rows for table preview and multi-condition filter testing.
