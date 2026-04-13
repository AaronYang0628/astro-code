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

export interface RunRequest {
  input: InputSpec;
  radiusArcsec?: number;
  topK?: number;
  previewRows?: number;
  interaction?: InteractionMode;
  filter?: FilterCondition | FilterSpec;
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
  ra_deg: number;
  dec_deg: number;
  mag: number;
  class_label: string;
  source_system?: string;
  source_index?: string;
  source_id?: string;
  source_path?: string;
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
