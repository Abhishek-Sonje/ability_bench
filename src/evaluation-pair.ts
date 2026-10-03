import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type BuiltEvaluationSuite,
  type EvaluationCheckDefinition,
  freezeJson,
  isBuiltEvaluationSuite,
} from "./evaluation.js";
import { FileArtifactStore, FileRunManifestStore, PersistenceError } from "./filesystem-store.js";
import { fingerprintWatchedFile, resolveJsonPointer } from "./fingerprint.js";
import { PathEscapeError, resolveContainedPath } from "./path-safety.js";
import type { FinalizedRunManifest } from "./run-manifest.js";
import { RunWorkflowError } from "./runner.js";
import { canonicalizeJson, createArtifact, decodeArtifact } from "./serialization.js";
import { parseBuiltInInputDescriptor } from "./typed-workflow.js";
import type { JsonObject, JsonValue } from "./types.js";

export type EvaluationPairErrorCode =
  | "invalid_suite"
  | "invalid_criteria"
  | "run_not_found"
  | "run_pair_not_completed"
  | "run_pair_workflow_mismatch"
  | "run_pair_same_run"
  | "run_pair_lineage_mismatch"
  | "target_stage_unavailable";

export class EvaluationPairError extends Error {
  constructor(
    readonly code: EvaluationPairErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EvaluationPairError";
  }
}

export interface PrepareEvaluationPairOptions {
  readonly baselineRunId: string;
  readonly candidateRunId: string;
  readonly criteria: JsonObject;
  readonly storageDir?: string;
}

export interface PreparedCheckSide {
  readonly sourceArtifactHash: string;
  readonly selectedInputs: JsonObject;
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly error: {
    readonly code: "output_contract_failed";
    readonly name: string;
    readonly message: string;
  } | null;
}

export interface PreparedEvaluationPair {
  readonly storageDir: string;
  readonly baseline: FinalizedRunManifest;
  readonly candidate: FinalizedRunManifest;
  readonly criteria: JsonObject;
  readonly criteriaArtifactHash: string;
  readonly suiteDescriptor: JsonObject;
  readonly suiteHash: string;
  readonly checks: readonly {
    readonly checkId: string;
    readonly targetStageId: string;
    readonly baseline: PreparedCheckSide;
    readonly candidate: PreparedCheckSide;
  }[];
}

/** Read-only preflight: never invokes evaluators, runs stages, or publishes artifacts. */
export async function prepareEvaluationPair(
  suite: BuiltEvaluationSuite,
  options: PrepareEvaluationPairOptions,
): Promise<PreparedEvaluationPair> {
  if (!isBuiltEvaluationSuite(suite))
    throw new EvaluationPairError("invalid_suite", "Expected a sealed evaluation suite.");
  const baselineRunId = options.baselineRunId;
  const candidateRunId = options.candidateRunId;
  const requestedStorageDir = options.storageDir ?? ".abilitybench";
  let criteria: JsonObject;
  try {
    const value = clone(options.criteria);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new TypeError("Expected a criteria object.");
    criteria = value;
    freezeJson(criteria);
  } catch (error: unknown) {
    throw new EvaluationPairError(
      "invalid_criteria",
      error instanceof Error ? error.message : "Invalid criteria.",
    );
  }
  if (baselineRunId === candidateRunId)
    throw new EvaluationPairError(
      "run_pair_same_run",
      "Baseline and candidate must be different runs.",
    );
  let storageDir: string;
  try {
    storageDir = await resolveContainedPath(suite.root, requestedStorageDir);
  } catch (error: unknown) {
    if (error instanceof PathEscapeError)
      throw new RunWorkflowError("storage_path_escaped", error.message);
    throw error;
  }
  for (const check of suite.checks) {
    for (const path of check.files) {
      const remainder = relative(storageDir, resolve(suite.root, path));
      if (
        remainder === "" ||
        (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
      ) {
        throw new RunWorkflowError(
          "storage_path_watched",
          `Check "${check.id}" watches storage path "${path}".`,
        );
      }
    }
  }
  const manifests = new FileRunManifestStore(storageDir);
  const baseline = await manifests.get(baselineRunId);
  const candidate = await manifests.get(candidateRunId);
  if (!baseline || !candidate)
    throw new EvaluationPairError(
      "run_not_found",
      "The explicitly selected baseline or candidate was not found.",
    );
  for (const run of [baseline, candidate]) {
    if (run.workflowId !== suite.workflowId)
      throw new EvaluationPairError(
        "run_pair_workflow_mismatch",
        "Both runs must belong to the evaluation workflow.",
      );
    if (run.executionStatus !== "completed")
      throw new EvaluationPairError(
        "run_pair_not_completed",
        "Evaluation requires two completed executions.",
      );
  }
  if (
    candidate.baselineRunId !== baseline.id ||
    candidate.baselineManifestHash !== baseline.manifestHash
  ) {
    throw new EvaluationPairError(
      "run_pair_lineage_mismatch",
      "Candidate must directly name the selected immutable baseline.",
    );
  }
  const sources = suite.checks.map((check) => ({
    check,
    baselineHash: targetArtifact(baseline, check.targetStage),
    candidateHash: targetArtifact(candidate, check.targetStage),
  }));
  const artifacts = new FileArtifactStore(storageDir);
  const decoded = new Map<string, JsonValue>();
  for (const hash of new Set(
    sources.flatMap(({ baselineHash, candidateHash }) => [baselineHash, candidateHash]),
  )) {
    const artifact = await artifacts.get(hash);
    if (!artifact)
      throw new PersistenceError(
        "read_failed",
        `Required evaluation artifact "${hash}" is missing.`,
      );
    decoded.set(hash, decodeArtifact(artifact));
  }
  const watched = new Map<string, JsonObject>();
  const physicalStorage = await realpath(storageDir);
  for (const path of [...new Set(suite.checks.flatMap(({ files }) => files))].sort()) {
    const snapshot = await fingerprintWatchedFile(suite.root, path);
    const { state } = snapshot;
    if (state === "file") {
      const physicalPath = await realpath(resolve(suite.root, path));
      const remainder = relative(physicalStorage, physicalPath);
      if (
        remainder === "" ||
        (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
      ) {
        throw new RunWorkflowError(
          "storage_path_watched",
          `Watched path "${path}" resolves inside evaluation storage.`,
        );
      }
    }
    watched.set(path, snapshot);
  }
  const suiteDescriptor: JsonObject = {
    contractVersion: suite.contractVersion,
    suiteId: suite.id,
    workflowId: suite.workflowId,
    checks: suite.checks.map((check) => ({
      id: check.id,
      targetStage: check.targetStage,
      revision: check.revision,
      watchedFiles: check.files.map((path) => clone(watched.get(path))),
      outputInputs: Object.entries(check.outputInputs).map(([alias, descriptor]) => ({
        alias,
        pointer: descriptor.pointer,
        contract: descriptor.contract,
      })),
    })),
    runner: {
      order: "sequential-check-id",
      sideOrder: "baseline-first",
      results: "strict-boolean",
      ordinaryErrors: "continue",
      outputCodec: "canonical-json-v1",
    },
  };
  freezeJson(suiteDescriptor);
  const suiteHash = `sha256:${createHash("sha256").update("abilitybench/evaluation-suite/v1\0").update(canonicalizeJson(suiteDescriptor)).digest("hex")}`;
  const checks = sources.map(({ check, baselineHash, candidateHash }) =>
    Object.freeze({
      checkId: check.id,
      targetStageId: check.targetStage,
      baseline: select(check, baselineHash, decoded.get(baselineHash)),
      candidate: select(check, candidateHash, decoded.get(candidateHash)),
    }),
  );
  return Object.freeze({
    storageDir,
    baseline,
    candidate,
    criteria,
    criteriaArtifactHash: createArtifact(criteria).contentHash,
    suiteDescriptor,
    suiteHash,
    checks: Object.freeze(checks),
  });
}

function targetArtifact(run: FinalizedRunManifest, stageId: string): string {
  const stage = run.stages.find((stage) => stage.stageId === stageId);
  if (
    !stage ||
    !["succeeded", "reused"].includes(stage.executionStatus) ||
    stage.outputArtifactHash === null
  ) {
    throw new EvaluationPairError(
      "target_stage_unavailable",
      `Target stage "${stageId}" has no successful output in "${run.id}".`,
    );
  }
  return stage.outputArtifactHash;
}

function select(
  check: EvaluationCheckDefinition,
  hash: string,
  artifact: JsonValue | undefined,
): PreparedCheckSide {
  if (artifact === undefined)
    throw new PersistenceError("read_failed", "Verified source artifact is unavailable.");
  const selectedInputs: JsonObject = {};
  const values = Object.entries(check.outputInputs).map(([alias, descriptor]) => {
    const selection = resolveJsonPointer(artifact, descriptor.pointer);
    const value = selection.found ? clone(selection.value) : undefined;
    Object.defineProperty(selectedInputs, alias, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: selection.found
        ? { contract: descriptor.contract, state: "present", value: clone(selection.value) }
        : { contract: descriptor.contract, state: "missing" },
    });
    return { alias, descriptor, value };
  });
  freezeJson(selectedInputs);
  try {
    const output = Object.fromEntries(
      values.map(({ alias, descriptor, value }) => [
        alias,
        parseBuiltInInputDescriptor(descriptor, value),
      ]),
    );
    freezeJson(output);
    return Object.freeze({ sourceArtifactHash: hash, selectedInputs, output, error: null });
  } catch (error: unknown) {
    return Object.freeze({
      sourceArtifactHash: hash,
      selectedInputs,
      output: null,
      error: Object.freeze({
        code: "output_contract_failed",
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : "Unable to validate output selections.",
      }),
    });
  }
}

function clone(value: unknown): JsonValue {
  return JSON.parse(canonicalizeJson(value)) as JsonValue;
}
