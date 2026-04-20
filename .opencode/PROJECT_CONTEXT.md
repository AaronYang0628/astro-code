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
- 仅本地自测/回归允许使用 `npx`/`npm run run` 一键执行。
- 开发阶段优先可解释性与可观测性，历史兼容和旧路径规则可丢弃。

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

- Euclid：按 tile 目录调用 `list_catalogs`，优先 `BGSUB-MOSAIC-VIS`。
- Euclid 无匹配时：允许写 pattern 路径，但必须标记
  - `euclid_path_source=euclid-catalog.list_catalogs:fallback_pattern`
  - `missing_reasons` 包含 `euclid_fits_path_generated_pattern`
- DESI：统一 S3 规则
  - `desi_tractor_i_fits_path -> .../tractor-i/<pre>/tractor-i-<brick>.fits`
  - `desi_tractor_fits_path -> .../tractor/<pre>/tractor-<brick>.fits`
  - `desi_image_[g/r/i/z]_path -> .../coadd/<pre>/<brick>/legacysurvey-<brick>-image-<band>.fits.fz`

## 望远镜处理要点

- Euclid：
  - 先定位 `tile_id`
  - 在 MER 图像中通过 WCS 进行坐标到像素映射（后续 cutout 阶段）
- DESI：
  - 无 tile，使用 `brickname`
  - 通过 `desiutil` 计算或补全砖块定位（后续 cutout 阶段使用）

## 当前 MVP 范围

- 先跑通最小 MVP：`candidate_pool + six-condition selection + 标准工件输出`
- MCP/ES 优化（字段最小化、索引增强）暂缓。
