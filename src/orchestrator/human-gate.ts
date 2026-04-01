import fs from "node:fs";
import path from "node:path";
import type { FilterCondition, InteractionMode } from "./types.js";

export function resolveHumanFilter(
  runDir: string,
  interaction: InteractionMode,
  inlineFilter?: FilterCondition
): FilterCondition | undefined {
  if (inlineFilter) {
    return inlineFilter;
  }

  if (interaction === "web") {
    const requestPath = path.join(runDir, "human_gate_request.json");
    const responsePath = path.join(runDir, "human_gate_response.json");

    const requestBody = {
      title: "Post-crossmatch filtering",
      instruction: "Set a field filter and write it into human_gate_response.json",
      format: {
        field: "desi_mag",
        op: "<=",
        value: 20
      }
    };

    fs.writeFileSync(requestPath, JSON.stringify(requestBody, null, 2));

    if (fs.existsSync(responsePath)) {
      const response = JSON.parse(fs.readFileSync(responsePath, "utf8")) as FilterCondition;
      return response;
    }

    return undefined;
  }

  return undefined;
}
