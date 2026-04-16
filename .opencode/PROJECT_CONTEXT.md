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
- 默认执行模式：`pipeline_strict`
- `pipeline_strict` 下，agent 负责对话收集参数，执行统一走 `runMvpPipeline`。

## 关键规则

- `tile_id` 必须是纯数字字符串（例如 `102018211`）。
- 对于 `s3_uri` 输入：优先从路径/文件名截取 `tile_id`。
- 对于 `RA/DEC` 输入：通过 MCP 解析 `tile_id`。
- `candidate_pool.csv` 必须包含固定字段名（值可空），尤其：
  - 星表字段：`type, RIGHT_ASCENSION, DECLINATION, SEMIMAJOR_AXIS, SEGMENTATION_AREA, FLUX_SEGMENTATION, FLUX_VIS_1FWHM_APER, FLUX_VIS_2FWHM_APER, FLUX_VIS_3FWHM_APER, FLUX_VIS_4FWHM_APER`
  - Euclid 图像路径：`euclid_fits_path`
  - DESI 图像路径：`desi_fits_g_path, desi_fits_r_path, desi_fits_i_path, desi_fits_z_path, desi_tractor_i_fits_path`

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
