import { createHash } from "node:crypto";

import { canonicalizeJson } from "./canonical-json.js";
import type { JsonValue } from "./types.js";

const ARTIFACT_DOMAIN = "abilitybench/artifact/v1\0";

export {
  canonicalizeJson,
  SerializationError,
  type SerializationErrorCode,
} from "./canonical-json.js";

export interface ArtifactEnvelope {
  readonly schemaVersion: "phase0-artifact-v1";
  readonly codec: "canonical-json-v1";
  readonly contentHash: string;
  readonly byteLength: number;
  readonly payload: Uint8Array;
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
