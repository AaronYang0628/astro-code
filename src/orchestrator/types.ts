export type InputType = "radec_text" | "file_upload" | "s3_uri";
export type InteractionMode = "web" | "cli";

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

export interface RunRequest {
  input: InputSpec;
  radiusArcsec?: number;
  topK?: number;
  previewRows?: number;
  interaction?: InteractionMode;
  filter?: FilterCondition;
}

export interface Coord {
  ra_deg: number;
  dec_deg: number;
  source: string;
}

export interface CatalogRecord {
  catalog: "euclid" | "desi";
  object_id: string;
  ra_deg: number;
  dec_deg: number;
  mag: number;
  class_label: string;
}

export interface CrossmatchRecord {
  euclid_object_id: string;
  desi_object_id: string;
  ra_deg: number;
  dec_deg: number;
  euclid_mag: number;
  desi_mag: number;
  separation_arcsec: number;
  class_label: string;
}

export interface PlaybookStep {
  id: string;
  agent: string;
  action: string;
  depends_on?: string[];
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
  };
}
