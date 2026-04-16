export type InputType = "radec_text" | "s3_uri";
export type InteractionMode = "web" | "cli";
export type InteractionBackend = "native" | "octto" | "hybrid";

export interface InputSpec {
  type: InputType;
  value: string;
  transient?: boolean;
}

export interface FilterCondition {
  field: string;
  op: "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains";
  value: string | number;
}

export type FilterLogic = "and" | "or";

export interface FilterSpec {
  logic: FilterLogic;
  conditions: FilterCondition[];
}

export type SelectionConditionId =
  | "galaxy_fraction"
  | "bright_maskbits_filter"
  | "faint_mag_limit"
  | "small_dim_galaxy_filter"
  | "oversized_galaxy_filter"
  | "uniform_mag_sampling";

export interface SelectionConditionConfig {
  id: SelectionConditionId;
  params?: Record<string, unknown>;
}

export interface SelectionPlan {
  conditions: SelectionConditionConfig[];
}

export interface RunRequest {
  input: InputSpec;
  workflow?: "euclid_desi_crossmatch" | "euclid_cutout" | "desi_cutout" | string;
  radiusArcsec?: number;
  topK?: number;
  previewRows?: number;
  interaction?: InteractionMode;
  filter?: FilterCondition | FilterSpec;
  selection?: SelectionPlan;
}

export interface RunArtifacts {
  statusJson: string;
  inputManifestJson: string;
  euclidQueryCsv?: string;
  desiQueryCsv?: string;
  desiOriginJson?: string;
  desiSearchQueryJson?: string;
  desiSearchInitialRawJson?: string;
  desiSearchSampleRawJson?: string;
  desiSearchRetryRawJson?: string;
  desiSearchRetrySampleRawJson?: string;
  candidatePoolCsv?: string;
  previewCsv?: string;
  previewSummaryJson?: string;
  filteredCsv?: string;
  statsJson: string;
  reportMd: string;
  resultIndexJson: string;
  humanGateRequestJson?: string;
  regionAdjustRequestJson?: string;
  t1SchemaReportJson?: string;
  qcReportJson?: string;
  fieldLineageDocMd?: string;
  mockContinueHandoffJson?: string;
  selectionCandidatesCsv?: string;
  selectionFinalCsv?: string;
  selectionReportJson?: string;
  selectionPlanRequestJson?: string;
  selectionPlanResponseJson?: string;
}

export interface RunSummary {
  mode: "pipeline";
  raDeg?: number;
  decDeg?: number;
  radiusArcsec?: number;
  topK?: number;
  desiHits?: number;
  candidatePoolRows?: number;
  previewRows?: number;
  filteredRows?: number;
  availableFilterFields?: string[];
  previewSample?: Record<string, unknown>[];
  humanGateMode?: "filter" | "filter_confirm" | "region_adjust" | "mock_continue" | "none";
  executionMode: "ts_orchestrator";
  t1RowsWithMissing?: number;
  mockChildRunId?: string;
}

export interface Coord {
  ra_deg: number;
  dec_deg: number;
  source: string;
  ra_min?: number;
  ra_max?: number;
  dec_min?: number;
  dec_max?: number;
  s3_path?: string;
  num_objects?: number;
}

export interface CatalogRecord {
  catalog: "euclid" | "desi";
  object_id: string;
  obj_id?: string;
  ra_deg: number;
  dec_deg: number;
  mag: number;
  mag_proxy?: number;
  type?: string;
  class_label: string;
  tile_index?: string;
  tile_index_source?: string;
  brickname?: string;
  brickid?: number;
  maskbits?: number;
  seg_area?: number;
  source_system?: string;
  source_index?: string;
  source_id?: string;
  source_path?: string;
  flux_g?: number;
  flux_r?: number;
  flux_i?: number;
  flux_z?: number;
  flux_w1?: number;
  flux_w2?: number;
  shape_r?: number;
  shape_e1?: number;
  shape_e2?: number;
  sersic?: number;
  ref_id?: number;
  release?: number;
  brick_primary?: boolean;
  allmask_r?: number;
  anymask_r?: number;
  fracmasked_r?: number;
  fracin_r?: number;
  fracflux_r?: number;
  fiberflux_r?: number;
  det_quality_flag?: number;
  flag_vis?: number;
  point_like_flag?: number;
  extended_flag?: number;
  semimajor_axis?: number;
  flux_vis_1fwhm_aper?: number;
  flux_vis_2fwhm_aper?: number;
  flux_vis_3fwhm_aper?: number;
  flux_vis_4fwhm_aper?: number;
  flux_vis_psf?: number;
  flux_vis_sersic?: number;
  flux_segmentation?: number;
}

export interface CrossmatchRecord {
  match_rank: number;
  center_ra: number;
  center_dec: number;
  radius_arcsec: number;
  dist_arcsec: number;
  separation_arcsec: number;
  obj_id: string;
  ra: number;
  dec: number;
  type: string | null;
  tile_index: string | null;
  tile_id?: string | null;
  brickname: string | null;
  maskbits: number | null;
  mag_proxy: number | null;
  seg_area: number | null;
  segmentation_area?: number | null;
  semimajor_axis?: number | null;
  flux_segmentation?: number | null;
  RIGHT_ASCENSION?: number | null;
  DECLINATION?: number | null;
  SEMIMAJOR_AXIS?: number | null;
  SEGMENTATION_AREA?: number | null;
  FLUX_SEGMENTATION?: number | null;
  FLUX_VIS_1FWHM_APER?: number | null;
  FLUX_VIS_2FWHM_APER?: number | null;
  FLUX_VIS_3FWHM_APER?: number | null;
  FLUX_VIS_4FWHM_APER?: number | null;
  euclid_object_id: string;
  desi_object_id: string | null;
  euclid_ra: number;
  euclid_dec: number;
  desi_ra: number | null;
  desi_dec: number | null;
  brickid: number | null;
  ra_deg: number;
  dec_deg: number;
  euclid_mag: number;
  desi_mag: number | null;
  class_label: string;
  source_id: string | null;
  target_id: string | null;
  tile_index_source: string;
  mag_proxy_source: string;
  flux_g: number | null;
  flux_r: number | null;
  flux_i: number | null;
  flux_z: number | null;
  flux_w1: number | null;
  flux_w2: number | null;
  shape_r: number | null;
  shape_e1: number | null;
  shape_e2: number | null;
  sersic: number | null;
  ref_id: number | null;
  release: number | null;
  brick_primary: boolean | null;
  allmask_r: number | null;
  anymask_r: number | null;
  fracmasked_r: number | null;
  fracin_r: number | null;
  fracflux_r: number | null;
  fiberflux_r: number | null;
  euclid_det_quality_flag: number | null;
  euclid_flag_vis: number | null;
  euclid_point_like_flag: number | null;
  euclid_extended_flag: number | null;
  euclid_semimajor_axis: number | null;
  euclid_flux_vis_1fwhm_aper: number | null;
  euclid_flux_vis_2fwhm_aper: number | null;
  euclid_flux_vis_3fwhm_aper: number | null;
  euclid_flux_vis_4fwhm_aper: number | null;
  euclid_flux_vis_psf: number | null;
  euclid_flux_vis_sersic: number | null;
  euclid_vis_path_pattern: string | null;
  euclid_fits_path?: string | null;
  desi_tractor_i_path: string | null;
  desi_tractor_i_fits_path?: string | null;
  desi_image_g_path: string | null;
  desi_fits_g_path?: string | null;
  desi_image_r_path: string | null;
  desi_fits_r_path?: string | null;
  desi_image_i_path: string | null;
  desi_fits_i_path?: string | null;
  desi_image_z_path: string | null;
  desi_fits_z_path?: string | null;
  path_source: string;
  missing_reasons: string;
}

export interface PlaybookStep {
  id: string;
  type?: "input" | "route" | "mcp_call" | "transform" | "human_gate" | "export";
  agent: string;
  action: string;
  depends_on?: string[];
  when?: string;
  on_fail?: {
    action: "continue" | "stop";
    guidance?: string;
  };
  mcp?: {
    server: string;
    tool: string;
    input?: Record<string, unknown>;
  };
  output_mapping?: Record<string, string>;
  plugin?: {
    name: string;
    tool: string;
    input?: Record<string, unknown>;
  };
}

export interface Playbook {
  id: string;
  version: string;
  defaults?: {
    radius_arcsec?: number;
    top_k?: number;
    preview_rows?: number;
  };
  steps: PlaybookStep[];
}

export interface AppConfig {
  defaults: {
    default_radius_arcsec: number;
    top_k: number;
    preview_rows: number;
    max_result_rows: number;
    interaction_primary: InteractionMode;
    interaction_secondary: InteractionMode;
  };
  paths: {
    default_playbook: string;
    runs_dir: string;
  };
  runtime: {
    python_bin: string;
    strict_playbook_validation: boolean;
    interaction_backend: InteractionBackend;
  };
}
