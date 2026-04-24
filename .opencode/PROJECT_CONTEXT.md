# Project Context

## 项目目标（北极星）

本项目是一个天文训练数据流水线：

1. 获取 RA/DEC（用户直接输入，或从用户给定 `s3://` 星表 FITS 读取）。
2. 找到不同望远镜（Euclid / DESI）在该天区的重合图像区域。
3. 生成统一候选池（`candidate_pool.csv`）。
4. 执行六条件自由组合筛选（匹配阶段仅一次筛选）。
5. 后续进行图像裁切，形成训练数据样本组。

`file_upload` 当前不支持，不在本阶段范围内。

## 输入与路由

- 支持输入：`radec_text`、`s3_uri`
- Web 交互默认执行模式：`interactive_debug`
- 批处理/一键回归默认执行模式：`pipeline_strict`

## Agent 交互规范（开发阶段）

- 先交互、后执行：默认不要一上来直接 `npx`/`npm run run`。
- 每步都要有明确结构：`STEP` / `GOAL` / `ACTION` / `RESULT`。
- 每一步执行前后都必须打印完整结构：先 `STEP/GOAL/ACTION`，执行后 `RESULT`，禁止静默调用 MCP。
- Web 页面中禁止 one-shot 一键产出最终结果；必须按 playbook 步骤逐步执行。
- Web 模式默认连续执行（不需要每步都停）；仅在 `waiting_selection` 或 `zero-result` 门禁暂停。
- 当 `interaction_backend=native` 且进入 selection 门禁时，必须主动触发 OpenCode 原生弹框（question UI）；仅写 request 文件不算完成交互。
- 仅本地终端回归允许使用 `npx`/`npm run run` 一键执行；在 web 对话会话中禁止 one-shot。
- 进入 `waiting_selection` 后禁止切换到 CLI 请求（例如 `*.cli*.json`）绕过门禁；必须同 run 续跑并提供确认回执。
- 开发阶段优先可解释性与可观测性，历史兼容和旧路径规则可丢弃。
- 默认禁止在 Step 1 前做探索式检索（package.json/playbook/docs/examples/scripts）。直接按固定流程执行（euclid_cutout/desi_cutout）。
- 仅在首个白名单调用发生契约错误、run 产物缺失/不一致、或 workflow 未识别时，允许一次受限探索（最多 2 次读取/搜索）后回到固定流程。
- 同一阶段只输出一个 `STEP/GOAL/ACTION/RESULT` 块，禁止重复同一 STEP 序号。

## 数据策略

- 当前阶段仅保留真实数据流程，不保留开发回退分支。

## 关键规则

- `tile_id` 必须是纯数字字符串（例如 `102018211`）。
- 对于 `s3_uri` 输入：优先从路径/文件名截取 `tile_id`。
- 对于 `RA/DEC` 输入：通过 MCP 解析 `tile_id`。
- `candidate_pool.csv` 必须包含固定字段名（值可空），尤其：
  - 星表字段：`type, RIGHT_ASCENSION, DECLINATION, SEMIMAJOR_AXIS, SEGMENTATION_AREA, FLUX_SEGMENTATION, FLUX_VIS_1FWHM_APER, FLUX_VIS_2FWHM_APER, FLUX_VIS_3FWHM_APER, FLUX_VIS_4FWHM_APER`
  - Euclid 路径字段：`euclid_fits_path, euclid_path_source`
  - DESI 路径字段：`desi_tractor_i_fits_path, desi_tractor_fits_path, desi_image_g_path, desi_image_r_path, desi_image_i_path, desi_image_z_path`

## 路径规则（当前生效）

- Euclid 单星表流程中，`euclid_fits_path` 默认使用输入 `s3_uri`（不做 list_catalogs 探索）。
- DESI：统一 S3 规则
  - `desi_tractor_i_fits_path -> .../tractor-i/<pre>/tractor-i-<brick>.fits`
  - `desi_tractor_fits_path -> .../tractor/<pre>/tractor-<brick>.fits`
  - `desi_image_[g/r/i/z]_path -> .../coadd/<pre>/<brick>/legacysurvey-<brick>-image-<band>.fits.fz`

## 固化流程（单星表）

- 固定执行顺序：
  1. input-router（resolve_tile_id + es_query）
  2. coord-extractor（按输入类型提取中心坐标与查询窗口）
  3. euclid-query
  4. desi-query
  5. crossmatch
  6. preview-export（必须打印 preview CSV 路径 + top10 表）
  7. selection-plan（web gate）
  8. filtered-export
  9. cutout-execute（selection_final>0 自动触发）
- workflow 分支规则：
  - `euclid_cutout`：`desi-query` 跳过，crossmatch 走 Euclid-only candidate pool。
  - `desi_cutout`：`euclid-query` 跳过，`desi-query` 必须执行，crossmatch 走 DESI-only candidate pool。
    - 当输入为 DESI `s3_uri` 时，coord-extractor 优先使用 ES（按 `brickname`/路径）提取 RA/DEC；ES 无结果再退回 Python 解析 FITS 表。
    - DESI catalog 版本暂按路径推断：`/dr10/` -> `desi-dr10-tractor`，`/dr9/` -> `desi-dr9-tractor`。
    - DESI 查询默认以 `brickname` 为主过滤条件；不要依赖路径字段（index schema 未保证提供 source_path/path/uri/s3_path）。
- cutout 规则：按路径自动执行。只要某波段路径字段有值就尝试切图；路径字段为空则跳过该波段。

## 望远镜处理要点

- Euclid：
  - 先定位 `tile_id`
  - 在 MER 图像中通过 WCS 进行坐标到像素映射（后续 cutout 阶段）
  - 对 DESI-only 输入，允许使用本地 tile 映射文件（`config/euclid_tiles_q1.json`）做 RA/DEC -> tile_id；若未命中则保持 Euclid 路径为空。
- DESI：
  - 无 tile，使用 `brickname`
  - 通过 `desiutil` 计算或补全砖块定位（后续 cutout 阶段使用）

## 当前 MVP 范围

- 先跑通最小 MVP：`candidate_pool + six-condition selection + 标准工件输出`
- MCP/ES 优化（字段最小化、索引增强）暂缓。
