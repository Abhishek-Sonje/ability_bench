import { type ArtifactEnvelope, createArtifact, decodeArtifact } from "./serialization.js";
import type { JsonValue } from "./types.js";

export interface ArtifactStore {
  get(contentHash: string): Promise<ArtifactEnvelope | undefined>;
  put(artifact: ArtifactEnvelope): Promise<void>;
}

export class ArtifactCollisionError extends Error {
  constructor(readonly contentHash: string) {
    super(`Artifact "${contentHash}" already exists with different bytes.`);
    this.name = "ArtifactCollisionError";
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  readonly #artifacts = new Map<string, ArtifactEnvelope>();

  async get(contentHash: string): Promise<ArtifactEnvelope | undefined> {
    const artifact = this.#artifacts.get(contentHash);
    return artifact === undefined ? undefined : cloneEnvelope(artifact);
  }

  async put(artifact: ArtifactEnvelope): Promise<void> {
    decodeArtifact(artifact);
    const existing = this.#artifacts.get(artifact.contentHash);
    if (existing !== undefined && !bytesEqual(existing.payload, artifact.payload)) {
      throw new ArtifactCollisionError(artifact.contentHash);
    }
    this.#artifacts.set(artifact.contentHash, cloneEnvelope(artifact));
  }

  async putValue(value: JsonValue): Promise<ArtifactEnvelope> {
    const artifact = createArtifact(value);
    await this.put(artifact);
    return artifact;
  }

  delete(contentHash: string): boolean {
    return this.#artifacts.delete(contentHash);
  }

  get size(): number {
    return this.#artifacts.size;
  }
}

function cloneEnvelope(artifact: ArtifactEnvelope): ArtifactEnvelope {
  return Object.freeze({
    schemaVersion: artifact.schemaVersion,
    codec: artifact.codec,
    contentHash: artifact.contentHash,
    byteLength: artifact.byteLength,
    payload: Uint8Array.from(artifact.payload),
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}
