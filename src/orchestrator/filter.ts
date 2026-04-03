import type { CrossmatchRecord, FilterCondition, FilterSpec } from "./types.js";

function toComparable(value: unknown): string | number {
  if (typeof value === "number") {
    return value;
  }
  const maybe = Number(value);
  if (Number.isFinite(maybe)) {
    return maybe;
  }
  return String(value);
}

function normalizeFilterSpec(filter?: FilterCondition | FilterSpec): FilterSpec | undefined {
  if (!filter) {
    return undefined;
  }

  if ("conditions" in filter) {
    const conditions = Array.isArray(filter.conditions) ? filter.conditions : [];
    if (conditions.length === 0) {
      return undefined;
    }
    return {
      logic: filter.logic === "or" ? "or" : "and",
      conditions
    };
  }

  return {
    logic: "and",
    conditions: [filter]
  };
}

function evaluateCondition(row: CrossmatchRecord, filter: FilterCondition): boolean {
  const raw = (row as unknown as Record<string, unknown>)[filter.field];
  const left = toComparable(raw);
  const right = toComparable(filter.value);

  switch (filter.op) {
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return Number(left) > Number(right);
    case ">=":
      return Number(left) >= Number(right);
    case "<":
      return Number(left) < Number(right);
    case "<=":
      return Number(left) <= Number(right);
    case "contains":
      return String(left).includes(String(right));
    default:
      return true;
  }
}

export function applyFilter(rows: CrossmatchRecord[], filter?: FilterCondition | FilterSpec): CrossmatchRecord[] {
  const spec = normalizeFilterSpec(filter);
  if (!spec) {
    return rows;
  }

  return rows.filter((row) => {
    if (spec.logic === "or") {
      return spec.conditions.some((condition) => evaluateCondition(row, condition));
    }
    return spec.conditions.every((condition) => evaluateCondition(row, condition));
  });
}
