import fs from "node:fs";
import yaml from "js-yaml";
import type { Playbook } from "./types.js";

function parseFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error("Playbook frontmatter is required.");
  }
  return match[1];
}

export function loadPlaybook(playbookPath: string): Playbook {
  const raw = fs.readFileSync(playbookPath, "utf8");
  const frontmatter = parseFrontmatter(raw);
  const parsed = yaml.load(frontmatter) as Playbook;

  if (!parsed?.id || !parsed?.version || !Array.isArray(parsed.steps)) {
    throw new Error("Invalid playbook: id, version, and steps are required.");
  }

  return parsed;
}
