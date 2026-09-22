import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalizeJson } from "./serialization.js";
import type { JsonObject, JsonValue, StageDefinition } from "./types.js";

const FINGERPRINT_DOMAIN = "abilitybench/stage-fingerprint/v1";

export type FingerprintInputErrorCode =
  | "dependency_artifact_missing"
  | "invalid_run_inputs"
  | "invalid_watch_target"
  | "watch_path_escaped"
  | "watch_read_failed";

export class FingerprintInputError extends Error {
  constructor(
    readonly code: FingerprintInputErrorCode,
    message: string,
    readonly sourceCause?: unknown,
  ) {
    super(message, sourceCause === undefined ? undefined : { cause: sourceCause });
    this.name = "FingerprintInputError";
  }
}

export interface StageFingerprintRequest {
  readonly workflowId: string;
  readonly workflowRoot: string;
  readonly stage: StageDefinition;
  readonly runInputs: JsonObject;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly dependencyArtifacts: Readonly<Record<string, string>>;
}

export interface StageFingerprintResult {
  readonly fingerprint: string;
  readonly manifest: StageFingerprintManifest;
  readonly componentHashes: FingerprintComponentHashes;
}

export interface FingerprintComponentHashes {
  readonly cachePolicy: string;
  readonly codec: string;
  readonly dependencies: string;
  readonly environment: string;
  readonly implementation: string;
  readonly selectedInputs: string;
  readonly watchedFiles: string;
}

export interface StageFingerprintManifest extends JsonObject {
  readonly watchedFiles: JsonValue[];
}

export async function computeStageFingerprint(
  request: StageFingerprintRequest,
): Promise<StageFingerprintResult> {
  const { stage } = request;
  assertRunInputs(request.runInputs);

  const dependencies = stage.dependencyIds
    .map((stageId) => {
      const artifactHash = request.dependencyArtifacts[stageId];
      if (artifactHash === undefined) {
        throw new FingerprintInputError(
          "dependency_artifact_missing",
          `Stage "${stage.id}" is missing the artifact hash for dependency "${stageId}".`,
        );
      }
      return { artifactHash, stageId };
    })
    .sort(compareBy("stageId"));

  const selectedInputs = Object.fromEntries(
    [...stage.inputPointers].sort(compareStrings).map((pointer) => {
      const selection = resolveJsonPointer(request.runInputs, pointer);
      return [
        pointer,
        selection.found ? { state: "present", value: selection.value } : { state: "missing" },
      ];
    }),
  ) as JsonObject;

  const environment = [...stage.environmentNames].sort(compareStrings).map((name) => {
    const value = request.environment[name];
    return value === undefined
      ? { name, state: "missing" }
      : { name, state: "present", valueHash: hashBytes(Buffer.from(value, "utf8")) };
  });

  const watchedFiles = await Promise.all(
    [...stage.watchedPaths]
      .sort(compareStrings)
      .map((path) => fingerprintWatchedFile(request.workflowRoot, path)),
  );

  const components = {
    cachePolicy: stage.cachePolicy,
    codec: stage.outputCodec,
    dependencies,
    environment,
    implementation: stage.implementation,
    selectedInputs,
    watchedFiles,
  } satisfies JsonObject;

  const manifest = {
    domain: FINGERPRINT_DOMAIN,
    contractVersion: "phase0-v1",
    workflowId: request.workflowId,
    stageId: stage.id,
    ...components,
  } satisfies JsonObject;

  const componentHashes = Object.fromEntries(
    Object.entries(components).map(([name, value]) => [name, hashCanonical(value)]),
  ) as unknown as FingerprintComponentHashes;

  return Object.freeze({
    fingerprint: hashCanonical(manifest),
    manifest: Object.freeze(manifest) as StageFingerprintManifest,
    componentHashes: Object.freeze(componentHashes),
  });
}

async function fingerprintWatchedFile(root: string, path: string): Promise<JsonObject> {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, path);
  assertInsideRoot(absoluteRoot, absolutePath, path);

  let metadata: Stats;
  try {
    metadata = await lstat(absolutePath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return { path, state: "missing" };
    throw new FingerprintInputError(
      "watch_read_failed",
      `Unable to inspect watched path "${path}".`,
      error,
    );
  }

  if (metadata.isSymbolicLink()) {
    let target: string;
    try {
      target = await realpath(absolutePath);
    } catch (error: unknown) {
      throw new FingerprintInputError(
        "watch_read_failed",
        `Unable to resolve watched symbolic link "${path}".`,
        error,
      );
    }
    assertInsideRoot(absoluteRoot, target, path);
    try {
      metadata = await lstat(target);
    } catch (error: unknown) {
      throw new FingerprintInputError(
        "watch_read_failed",
        `Unable to inspect watched symbolic-link target "${path}".`,
        error,
      );
    }
  }

  if (!metadata.isFile()) {
    throw new FingerprintInputError(
      "invalid_watch_target",
      `Watched path "${path}" must resolve to a regular file.`,
    );
  }

  try {
    const bytes = await readFile(absolutePath);
    return { contentHash: hashBytes(bytes), path, state: "file" };
  } catch (error: unknown) {
    throw new FingerprintInputError(
      "watch_read_failed",
      `Unable to read watched file "${path}".`,
      error,
    );
  }
}

function assertRunInputs(inputs: JsonObject): void {
  try {
    canonicalizeJson(inputs);
  } catch (error: unknown) {
    throw new FingerprintInputError(
      "invalid_run_inputs",
      "Run inputs must satisfy the canonical JSON contract.",
      error,
    );
  }
}

function assertInsideRoot(root: string, target: string, declaredPath: string): void {
  const relativePath = relative(root, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new FingerprintInputError(
      "watch_path_escaped",
      `Watched path "${declaredPath}" resolves outside the workflow root.`,
    );
  }
}

function resolveJsonPointer(
  root: JsonValue,
  pointer: string,
): { readonly found: true; readonly value: JsonValue } | { readonly found: false } {
  if (pointer === "") return { found: true, value: root };
  let current: JsonValue = root;
  for (const encodedToken of pointer.slice(1).split("/")) {
    const token = encodedToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return { found: false };
      const index = Number(token);
      if (!Object.hasOwn(current, index)) return { found: false };
      const next = current[index];
      if (next === undefined) return { found: false };
      current = next;
    } else if (current !== null && typeof current === "object") {
      if (!Object.hasOwn(current, token)) return { found: false };
      const next = current[token];
      if (next === undefined) return { found: false };
      current = next;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function hashCanonical(value: JsonValue): string {
  return hashBytes(Buffer.from(canonicalizeJson(value), "utf8"));
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBy<Key extends string>(key: Key) {
  return (left: Record<Key, string>, right: Record<Key, string>): number =>
    compareStrings(left[key], right[key]);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
