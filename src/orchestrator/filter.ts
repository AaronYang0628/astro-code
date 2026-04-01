import type { CrossmatchRecord, FilterCondition } from "./types.js";

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

export function applyFilter(rows: CrossmatchRecord[], filter?: FilterCondition): CrossmatchRecord[] {
  if (!filter) {
    return rows;
  }

  return rows.filter((row) => {
    const raw = (row as Record<string, unknown>)[filter.field];
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
  });
}
