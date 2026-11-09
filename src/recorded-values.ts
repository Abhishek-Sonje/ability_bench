import { AbilityBenchError } from "./errors.js";
import type { JsonValue } from "./types.js";

const ARRAY_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/;
class ValueError extends AbilityBenchError {
  constructor(path: string, message: string) {
    super("invalid_json_value", message, "value", { path });
  }
}
export function orderedJson(value: unknown): string {
  return serialize(value, "", new WeakSet<object>());
}
export function copyValue(value: unknown): JsonValue {
  return JSON.parse(orderedJson(value)) as JsonValue;
}
export function decodeRecordedJson(bytes: Uint8Array): { text: string; value: JsonValue } {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return { text, value: JSON.parse(text) as JsonValue };
}
export function parseOrdered(bytes: Uint8Array): JsonValue {
  const { text, value } = decodeRecordedJson(bytes);
  // Reencoding also rejects duplicate keys, noncanonical number/string spellings,
  // BOM, whitespace and keys whose textual order violates Object.keys order.
  if (orderedJson(value) !== text) throw new Error("Noncanonical ordered JSON.");
  return value;
}
function serialize(value: unknown, path: string, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new ValueError(path, "Expected a finite number other than -0");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new ValueError(path, `Unsupported ${typeof value} value`);
  }
  if (seen.has(value)) {
    throw new ValueError(path, "Cycles are unsupported");
  }
  seen.add(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value, path, seen)
      : serializeObject(value, path, seen);
  } finally {
    seen.delete(value);
  }
}

function serializeArray(value: unknown[], path: string, seen: WeakSet<object>): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new ValueError(path, "Only plain arrays are supported");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new ValueError(path, "Symbol-keyed properties are unsupported");
    }
    if (key !== "length" && (!ARRAY_INDEX_PATTERN.test(key) || Number(key) >= value.length)) {
      throw new ValueError(pointer(path, key), "Non-index array properties are unsupported");
    }
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new ValueError(pointer(path, String(index)), "Sparse arrays are unsupported");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    assertDataProperty(descriptor, pointer(path, String(index)));
    if (descriptor.enumerable !== true) {
      throw new ValueError(
        pointer(path, String(index)),
        "Non-enumerable array elements are unsupported",
      );
    }
    items.push(serialize(descriptor.value, pointer(path, String(index)), seen));
  }
  return `[${items.join(",")}]`;
}

function serializeObject(value: object, path: string, seen: WeakSet<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ValueError(path, "Only plain objects are supported");
  }
  const entries: Array<[string, string]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new ValueError(path, "Symbol-keyed properties are unsupported");
    }

    const propertyPath = pointer(path, key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assertDataProperty(descriptor, propertyPath);
    if (descriptor.enumerable !== true) {
      throw new ValueError(propertyPath, "Non-enumerable properties are unsupported");
    }
    entries.push([key, serialize(descriptor.value, propertyPath, seen)]);
  }

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${item}`).join(",")}}`;
}

function assertDataProperty(
  descriptor: PropertyDescriptor | undefined,
  path: string,
): asserts descriptor is PropertyDescriptor & { value: unknown } {
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new ValueError(path, "Accessor properties are unsupported");
  }
}

function pointer(parent: string, key: string): string {
  return `${parent}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}
