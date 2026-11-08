import type { JsonValue } from "./types.js";
export interface Difference {
  path: string;
  reason: "type" | "value" | "object_keys" | "object_order" | "array_length";
}
export interface Comparison {
  left: { runId: string; stageId: string };
  right: { runId: string; stageId: string };
  equal: boolean;
  difference: Difference | null;
}
export function firstDifference(left: JsonValue, right: JsonValue, path = ""): Difference | null {
  const kind = (v: JsonValue) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  if (kind(left) !== kind(right)) return { path, reason: "type" };
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return { path, reason: "array_length" };
    for (let i = 0; i < left.length; i++) {
      const difference = firstDifference(
        left[i] as JsonValue,
        right[i] as JsonValue,
        `${path}/${i}`,
      );
      if (difference) return difference;
    }
  } else if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    const a = Object.keys(left),
      b = Object.keys(right);
    if (a.length !== b.length || a.some((key) => !Object.hasOwn(right, key)))
      return { path, reason: "object_keys" };
    if (a.some((key, i) => key !== b[i])) return { path, reason: "object_order" };
    for (const key of a) {
      const difference = firstDifference(
        (left as Record<string, JsonValue>)[key] as JsonValue,
        (right as Record<string, JsonValue>)[key] as JsonValue,
        `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
      );
      if (difference) return difference;
    }
  } else if (left !== right) return { path, reason: "value" };
  return null;
}
