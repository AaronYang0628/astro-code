# OpenCode Web Testing Guide

This guide describes how to test the Euclid x DESI workflow in OpenCode Web with real MCP servers.

## 1) Start from project root

Run all commands in `/home/aaron/ZJ_GITLAB/astro-code`.

## 2) Verify config and MCP

```bash
opencode debug config
opencode mcp list
```

Check these points:

- `model` is the one you configured in `.opencode/opencode.json`
- MCP includes `euclid-catalog` and `astro_k3s_mcp`
- plugin includes `octto`
- custom agents are visible (`orchestrator-agent`, `euclid-agent`, `desi-agent`, etc.)

If Euclid uses self-signed cert, use:

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 opencode mcp list
```

## 3) Start OpenCode Web

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 opencode web --port 7788
```

Open the printed local URL in browser.

Important:

- For Web HITL runs, do not switch to local `npm run` in the middle of the same task.
- Keep MCP calls, octto question, user answer, and continuation in one chat session.

## 4) Recommended test order

### A. End-to-end test with orchestrator-agent

Select `orchestrator-agent` and send this stricter prompt (works better for weaker models):

```text
你必须直接调用 MCP 工具，不要让我手动解析文件。
不要切换到本地 npm 进程。

目标：用这个 S3 路径跑 Euclid -> DESI 查询流程：
s3://test/1774920390_MER_FINAL_CATALOG_102018211_EUC_MER_FINAL-CAT_TILE102018211-CC66F6_20241018T214045.289017Z_00.00.fits

严格按下面步骤执行并展示每步结果：

步骤1：调用 euclid-catalog.get_catalog_info_with_stats
参数：
{
  "catalog_path": "s3://test/1774920390_MER_FINAL_CATALOG_102018211_EUC_MER_FINAL-CAT_TILE102018211-CC66F6_20241018T214045.289017Z_00.00.fits"
}

步骤2：从返回里提取 coordinate_ranges:
- ra_min
- ra_max
- dec_min
- dec_max

步骤3：调用 astro_k3s_mcp.es_query（mode=search）
参数模板：
{
  "catalog": "desi-dr10-tractor",
  "mode": "search",
  "body": {
    "query": {
      "bool": {
        "filter": [
          {"range": {"ra": {"gte": <ra_min>, "lte": <ra_max>}}},
          {"range": {"dec": {"gte": <dec_min>, "lte": <dec_max>}}},
          {"term": {"brick_primary": true}}
        ]
      }
    },
    "from": 0,
    "size": 100
  }
}

步骤4：解析 DESI 返回：
- hits_total 路径：data.result.hits.total.value
- sample_rows 路径：data.result.hits.hits（最多展示前3条）

步骤5：如果 hits_total == 0：
- 先把窗口扩大 20 倍后重试一次（保持中心不变）
- 再输出第二次查询的 hits_total 和前3条

最终输出格式：
1) Euclid 坐标范围
2) DESI 第一次命中数
3) 若重试：DESI 第二次命中数
4) 示例记录（最多3条）
5) 下一步建议
```

If model still gets stuck, force tool mode by sending one-line instruction first:

```text
先只执行步骤1：调用 euclid-catalog.get_catalog_info_with_stats 并返回 coordinate_ranges，暂时不要做其他步骤。
```

### B. Isolate issues with specialist agents

- `euclid-agent`: validate Euclid parse and coordinate ranges
- `desi-agent`: validate DESI search payload/response mapping
- `filter-agent`: validate zero-hit region-adjust suggestion and filter form
- `reporter-agent`: validate report formatting and key metrics

## 5) Expected behaviors

- Euclid step should return valid `ra_min/ra_max/dec_min/dec_max`
- DESI search may return `hits=0` for small windows (normal in some regions)
- When `hits=0`, workflow should suggest region adjustment and generate `region_adjust_request.json`
- Final answer should explicitly include artifact paths (`crossmatch.csv`, `preview_100.csv`, `filtered.csv`, `result_index.json`)

## 6) Useful debug commands

```bash
opencode agent list
opencode mcp list
opencode run "只回复: ok" --agent orchestrator-agent --model openai/gpt-5.3-codex
```
