import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { ArtifactStore } from "./artifact-store.js";
import { type FinalizedRunManifest, freezeRunManifest, verifyRunManifest } from "./run-manifest.js";
import { type ArtifactEnvelope, canonicalizeJson, decodeArtifact } from "./serialization.js";

const ARTIFACT_HASH_PATTERN = /^sha256:([a-f0-9]{64})$/;
const RUN_ID_PATTERN = /^run_([a-f0-9]{64})$/;
const RUN_FILENAME_PATTERN = /^(run_[a-f0-9]{64})\.json$/;

export type PersistenceErrorCode =
  | "content_collision"
  | "corrupt_artifact"
  | "corrupt_manifest"
  | "invalid_artifact_hash"
  | "invalid_run_id"
  | "read_failed"
  | "write_failed";

export class PersistenceError extends Error {
  constructor(
    readonly code: PersistenceErrorCode,
    message: string,
    readonly sourceCause?: unknown,
  ) {
    super(message, sourceCause === undefined ? undefined : { cause: sourceCause });
    this.name = "PersistenceError";
  }
}

export class FileArtifactStore implements ArtifactStore {
  readonly #root: string;

  constructor(storageRoot: string) {
    this.#root = resolve(storageRoot);
  }

  async get(contentHash: string): Promise<ArtifactEnvelope | undefined> {
    const path = this.#pathForHash(contentHash);
    let payload: Uint8Array;
    try {
      payload = Uint8Array.from(await readFile(path));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new PersistenceError("read_failed", `Unable to read artifact "${contentHash}".`, error);
    }

    const artifact: ArtifactEnvelope = Object.freeze({
      schemaVersion: "phase0-artifact-v1",
      codec: "canonical-json-v1",
      contentHash,
      byteLength: payload.byteLength,
      payload,
    });
    try {
      decodeArtifact(artifact);
    } catch (error: unknown) {
      throw new PersistenceError(
        "corrupt_artifact",
        `Artifact "${contentHash}" failed integrity verification.`,
        error,
      );
    }
    return artifact;
  }

  async put(artifact: ArtifactEnvelope): Promise<void> {
    try {
      decodeArtifact(artifact);
    } catch (error: unknown) {
      throw new PersistenceError(
        "corrupt_artifact",
        `Artifact "${artifact.contentHash}" failed integrity verification.`,
        error,
      );
    }
    const path = this.#pathForHash(artifact.contentHash);
    await writeImmutable(path, artifact.payload, artifact.contentHash);
  }

  #pathForHash(contentHash: string): string {
    const match = ARTIFACT_HASH_PATTERN.exec(contentHash);
    if (match?.[1] === undefined) {
      throw new PersistenceError(
        "invalid_artifact_hash",
        `Artifact hash "${contentHash}" is not a canonical SHA-256 identity.`,
      );
    }
    return join(this.#root, "objects", "sha256", match[1]);
  }
}

export class FileRunManifestStore {
  readonly #root: string;

  constructor(storageRoot: string) {
    this.#root = resolve(storageRoot);
  }

  async get(runId: string): Promise<FinalizedRunManifest | undefined> {
    const path = this.#pathForRun(runId);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new PersistenceError("read_failed", `Unable to read run "${runId}".`, error);
    }

    let manifest: FinalizedRunManifest;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      manifest = JSON.parse(text) as FinalizedRunManifest;
      verifyRunManifest(manifest);
      if (canonicalizeJson(manifest) !== text) {
        throw new TypeError("Run manifest is not canonical JSON.");
      }
    } catch (error: unknown) {
      throw new PersistenceError(
        "corrupt_manifest",
        `Run manifest "${runId}" failed integrity verification.`,
        error,
      );
    }
    if (manifest.id !== runId) {
      throw new PersistenceError(
        "corrupt_manifest",
        `Run manifest at "${runId}" identifies itself as "${manifest.id}".`,
      );
    }
    return freezeRunManifest(manifest);
  }

  async put(manifest: FinalizedRunManifest): Promise<void> {
    try {
      verifyRunManifest(manifest);
    } catch (error: unknown) {
      throw new PersistenceError(
        "corrupt_manifest",
        `Run manifest "${manifest.id}" failed integrity verification.`,
        error,
      );
    }
    const path = this.#pathForRun(manifest.id);
    const bytes = new TextEncoder().encode(canonicalizeJson(manifest));
    await writeImmutable(path, bytes, manifest.id);
  }

  async list(): Promise<readonly FinalizedRunManifest[]> {
    let filenames: string[];
    try {
      filenames = await readdir(join(this.#root, "runs"));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return Object.freeze([]);
      throw new PersistenceError("read_failed", "Unable to list stored runs.", error);
    }

    const manifests: FinalizedRunManifest[] = [];
    for (const filename of filenames.sort()) {
      const runId = RUN_FILENAME_PATTERN.exec(filename)?.[1];
      if (runId === undefined) continue;
      const manifest = await this.get(runId);
      if (manifest === undefined) {
        throw new PersistenceError("read_failed", `Run "${runId}" disappeared while listing.`);
      }
      manifests.push(manifest);
    }
    manifests.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    );
    return Object.freeze(manifests);
  }

  #pathForRun(runId: string): string {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new PersistenceError(
        "invalid_run_id",
        `Run ID "${runId}" is not a content-addressed Phase 0 run ID.`,
      );
    }
    return join(this.#root, "runs", `${runId}.json`);
  }
}

export async function writeImmutable(
  path: string,
  bytes: Uint8Array,
  identity: string,
): Promise<void> {
  const temporaryPath = join(dirname(path), `.tmp-${randomUUID()}`);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    try {
      await link(temporaryPath, path);
      return;
    } catch (error: unknown) {
      if (!(isNodeError(error) && (error.code === "EEXIST" || error.code === "EPERM"))) {
        throw error;
      }
    }

    const existing = await readFile(path);
    if (!bytesEqual(existing, bytes)) {
      throw new PersistenceError(
        "content_collision",
        `Immutable content "${identity}" already exists with different bytes.`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError("write_failed", `Unable to persist "${identity}".`, error);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error: unknown) {
      if (!(isNodeError(error) && error.code === "ENOENT")) {
        // A stale temp file is harmless and intentionally never treated as committed content.
      }
    }
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
