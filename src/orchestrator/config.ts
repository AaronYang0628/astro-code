import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { AppConfig } from "./types.js";

const DEFAULT_CONFIG: AppConfig = {
  defaults: {
    default_radius_arcsec: 1.0,
    top_k: 100,
    preview_rows: 100,
    max_result_rows: 10000,
    interaction_primary: "web",
    interaction_secondary: "cli"
  },
  paths: {
    default_playbook: "playbooks/euclid_desi_mvp.playbook.md",
    runs_dir: "runs"
  },
  runtime: {
    python_bin: "python3",
    strict_playbook_validation: true,
    interaction_backend: "hybrid"
  }
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeInteractionBackend(value: unknown, fallback: AppConfig["runtime"]["interaction_backend"]): AppConfig["runtime"]["interaction_backend"] {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "native" || normalized === "octto" || normalized === "hybrid") {
    return normalized;
  }
  return fallback;
}

export function loadConfig(configPath: string): AppConfig {
  const absolute = path.resolve(configPath);
  if (!fs.existsSync(absolute)) {
    return DEFAULT_CONFIG;
  }

  const raw = fs.readFileSync(absolute, "utf8");
  const parsed = yaml.load(raw);

  if (!isObject(parsed)) {
    return DEFAULT_CONFIG;
  }

  const defaults = isObject(parsed.defaults) ? parsed.defaults : {};
  const paths = isObject(parsed.paths) ? parsed.paths : {};
  const runtime = isObject(parsed.runtime) ? parsed.runtime : {};
  const envInteractionBackend = process.env.INTERACTION_BACKEND;

  return {
    defaults: {
      default_radius_arcsec: Number(defaults.default_radius_arcsec ?? DEFAULT_CONFIG.defaults.default_radius_arcsec),
      top_k: Number(defaults.top_k ?? DEFAULT_CONFIG.defaults.top_k),
      preview_rows: Number(defaults.preview_rows ?? DEFAULT_CONFIG.defaults.preview_rows),
      max_result_rows: Number(defaults.max_result_rows ?? DEFAULT_CONFIG.defaults.max_result_rows),
      interaction_primary: (defaults.interaction_primary as AppConfig["defaults"]["interaction_primary"]) ?? DEFAULT_CONFIG.defaults.interaction_primary,
      interaction_secondary: (defaults.interaction_secondary as AppConfig["defaults"]["interaction_secondary"]) ?? DEFAULT_CONFIG.defaults.interaction_secondary
    },
    paths: {
      default_playbook: String(paths.default_playbook ?? DEFAULT_CONFIG.paths.default_playbook),
      runs_dir: String(paths.runs_dir ?? DEFAULT_CONFIG.paths.runs_dir)
    },
    runtime: {
      python_bin: String(runtime.python_bin ?? DEFAULT_CONFIG.runtime.python_bin),
      strict_playbook_validation: Boolean(runtime.strict_playbook_validation ?? DEFAULT_CONFIG.runtime.strict_playbook_validation),
      interaction_backend: normalizeInteractionBackend(
        envInteractionBackend ?? runtime.interaction_backend,
        DEFAULT_CONFIG.runtime.interaction_backend
      )
    }
  };
}
