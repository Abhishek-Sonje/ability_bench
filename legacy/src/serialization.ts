import { createHash } from "node:crypto";

import type { JsonValue } from "./types.js";

const ARTIFACT_DOMAIN = "abilitybench/artifact/v1\0";
const ARRAY_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/;

export type SerializationErrorCode =
  | "accessor_property"
  | "custom_prototype"
  | "invalid_number"
  | "invalid_unicode"
  | "non_enumerable_property"
  | "shared_reference"
  | "sparse_array"
  | "symbol_key"
  | "unsupported_array_property"
  | "unsupported_type";

export class SerializationError extends TypeError {
  constructor(
    readonly code: SerializationErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${message} at ${path}.`);
    this.name = "SerializationError";
  }
}

export interface ArtifactEnvelope {
  readonly schemaVersion: "phase0-artifact-v1";
  readonly codec: "canonical-json-v1";
  readonly contentHash: string;
  readonly byteLength: number;
  readonly payload: Uint8Array;
}

export function canonicalizeJson(value: unknown): string {
  return serialize(value, "$", new WeakSet<object>());
}

export function encodeCanonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalizeJson(value));
}

export function createArtifact(value: unknown): ArtifactEnvelope {
  const payload = encodeCanonicalJson(value);
  const hash = createHash("sha256").update(ARTIFACT_DOMAIN).update(payload).digest("hex");
  return Object.freeze({
    schemaVersion: "phase0-artifact-v1",
    codec: "canonical-json-v1",
    contentHash: `sha256:${hash}`,
    byteLength: payload.byteLength,
    payload,
  });
}

export function decodeArtifact(artifact: ArtifactEnvelope): JsonValue {
  if (artifact.schemaVersion !== "phase0-artifact-v1" || artifact.codec !== "canonical-json-v1") {
    throw new TypeError("Unsupported artifact envelope.");
  }
  if (artifact.payload.byteLength !== artifact.byteLength) {
    throw new TypeError("Artifact byte length does not match its envelope.");
  }
  const actual = createHash("sha256")
    .update(ARTIFACT_DOMAIN)
    .update(artifact.payload)
    .digest("hex");
  if (`sha256:${actual}` !== artifact.contentHash) {
    throw new TypeError("Artifact content hash does not match its payload.");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(artifact.payload);
  const decoded: unknown = JSON.parse(text);
  if (canonicalizeJson(decoded) !== text) {
    throw new TypeError("Artifact payload is not canonical JSON.");
  }
  return decoded as JsonValue;
}

function serialize(value: unknown, path: string, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertValidUnicode(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new SerializationError(
        "invalid_number",
        path,
        "Expected a finite number other than -0",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new SerializationError("unsupported_type", path, `Unsupported ${typeof value} value`);
  }
  if (seen.has(value)) {
    throw new SerializationError(
      "shared_reference",
      path,
      "Cycles and shared references are unsupported",
    );
  }
  seen.add(value);
  return Array.isArray(value)
    ? serializeArray(value, path, seen)
    : serializeObject(value, path, seen);
}

function serializeArray(value: unknown[], path: string, seen: WeakSet<object>): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new SerializationError("custom_prototype", path, "Only plain arrays are supported");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new SerializationError("symbol_key", path, "Symbol-keyed properties are unsupported");
    }
    if (key !== "length" && (!ARRAY_INDEX_PATTERN.test(key) || Number(key) >= value.length)) {
      throw new SerializationError(
        "unsupported_array_property",
        pointer(path, key),
        "Non-index array properties are unsupported",
      );
    }
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new SerializationError(
        "sparse_array",
        pointer(path, String(index)),
        "Sparse arrays are unsupported",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    assertDataProperty(descriptor, pointer(path, String(index)));
    if (descriptor.enumerable !== true) {
      throw new SerializationError(
        "non_enumerable_property",
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
    throw new SerializationError("custom_prototype", path, "Only plain objects are supported");
  }
  const entries: Array<[string, string]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new SerializationError("symbol_key", path, "Symbol-keyed properties are unsupported");
    }
    assertValidUnicode(key, path);
    const propertyPath = pointer(path, key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assertDataProperty(descriptor, propertyPath);
    if (descriptor.enumerable !== true) {
      throw new SerializationError(
        "non_enumerable_property",
        propertyPath,
        "Non-enumerable properties are unsupported",
      );
    }
    entries.push([key, serialize(descriptor.value, propertyPath, seen)]);
  }
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${item}`).join(",")}}`;
}

function assertDataProperty(
  descriptor: PropertyDescriptor | undefined,
  path: string,
): asserts descriptor is PropertyDescriptor & { value: unknown } {
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new SerializationError("accessor_property", path, "Accessor properties are unsupported");
  }
}

function assertValidUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new SerializationError(
          "invalid_unicode",
          path,
          "String contains an unpaired surrogate",
        );
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new SerializationError(
        "invalid_unicode",
        path,
        "String contains an unpaired surrogate",
      );
    }
  }
}

function pointer(parent: string, key: string): string {
  return `${parent}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}
