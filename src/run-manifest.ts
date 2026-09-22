import { createHash } from "node:crypto";

import type { ArtifactStore } from "./artifact-store.js";
import type { WorkflowExecutionResult } from "./execution.js";
import type { FingerprintComponentHashes } from "./fingerprint.js";
import type { BaselineRun, BaselineStageExecutionStatus } from "./planning.js";
import { canonicalizeJson, decodeArtifact } from "./serialization.js";
import type { BuiltWorkflow, JsonObject, JsonValue } from "./types.js";

const RUN_MANIFEST_DOMAIN = "abilitybench/run-manifest/v1\0";

export interface RunManifestStage {
  readonly stageId: string;
  readonly dependencyIds: readonly string[];
  readonly plannedDecision: "reuse" | "execute";
  readonly finalDecision: "reuse" | "execute";
  readonly decisionReason: string;
  readonly decisionDetails: JsonObject;
  readonly executionStatus: BaselineStageExecutionStatus;
  readonly evaluationStatus: "not_run";
  readonly fingerprint: string | null;
  readonly componentHashes: FingerprintComponentHashes | null;
  readonly outputArtifactHash: string | null;
  readonly error: { readonly name: string; readonly message: string } | null;
}

export interface FinalizedRunManifest {
  readonly id: string;
  readonly manifestHash: string;
  readonly schemaVersion: "phase0-run-v1";
  readonly workflowId: string;
  readonly baselineRunId: string | null;
  readonly baselineManifestHash: string | null;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly executionStatus: "completed" | "failed";
  readonly evaluationStatus: "not_run";
  readonly stages: readonly RunManifestStage[];
}

export type RunManifestErrorCode =
  | "execution_workflow_mismatch"
  | "invalid_manifest_hash"
  | "invalid_run_id"
  | "invalid_timestamp"
  | "manifest_not_completed"
  | "stage_set_mismatch";

export class RunManifestError extends Error {
  constructor(
    readonly code: RunManifestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunManifestError";
  }
}

export interface FinalizeRunRequest {
  readonly workflow: BuiltWorkflow;
  readonly execution: WorkflowExecutionResult;
  readonly createdAt: string;
  readonly completedAt: string;
}

export function finalizeRunManifest(request: FinalizeRunRequest): FinalizedRunManifest {
  validateTimestamp(request.createdAt, "createdAt");
  validateTimestamp(request.completedAt, "completedAt");
  if (request.execution.workflowId !== request.workflow.id) {
    throw new RunManifestError(
      "execution_workflow_mismatch",
      `Execution workflow "${request.execution.workflowId}" does not match "${request.workflow.id}".`,
    );
  }

  const definitions = new Map(request.workflow.stages.map((stage) => [stage.id, stage]));
  const executionIds = request.execution.stages.map(({ stageId }) => stageId);
  if (
    executionIds.length !== request.workflow.topologicalOrder.length ||
    executionIds.some((stageId, index) => stageId !== request.workflow.topologicalOrder[index])
  ) {
    throw new RunManifestError(
      "stage_set_mismatch",
      "Execution stages do not match the workflow's topological order.",
    );
  }

  const body = {
    schemaVersion: "phase0-run-v1",
    workflowId: request.workflow.id,
    baselineRunId: request.execution.baselineRunId,
    baselineManifestHash: request.execution.baselineManifestHash,
    createdAt: request.createdAt,
    completedAt: request.completedAt,
    executionStatus: request.execution.executionStatus,
    evaluationStatus: request.execution.evaluationStatus,
    stages: request.execution.stages.map((record) => {
      const definition = definitions.get(record.stageId);
      if (definition === undefined) {
        throw new RunManifestError("stage_set_mismatch", `Stage "${record.stageId}" is undefined.`);
      }
      return {
        stageId: record.stageId,
        dependencyIds: [...definition.dependencyIds],
        plannedDecision: record.plannedDecision,
        finalDecision: record.finalDecision,
        decisionReason: record.decisionReason,
        decisionDetails: cloneJson(record.decisionDetails),
        executionStatus: record.executionStatus,
        evaluationStatus: record.evaluationStatus,
        fingerprint: record.fingerprint,
        componentHashes: record.componentHashes === null ? null : { ...record.componentHashes },
        outputArtifactHash: record.outputArtifactHash,
        error: record.error === null ? null : { ...record.error },
      };
    }),
  } as const;

  const manifestHash = hashManifestBody(body as unknown as JsonValue);
  const manifest = {
    id: `run_${manifestHash.slice("sha256:".length)}`,
    manifestHash,
    ...body,
  } as FinalizedRunManifest;
  verifyRunManifest(manifest);
  return deepFreezeManifest(manifest);
}

export function verifyRunManifest(manifest: FinalizedRunManifest): void {
  const body = manifestBody(manifest);
  const expectedHash = hashManifestBody(body as unknown as JsonValue);
  if (manifest.manifestHash !== expectedHash) {
    throw new RunManifestError(
      "invalid_manifest_hash",
      `Run manifest hash mismatch: expected "${expectedHash}".`,
    );
  }
  const expectedId = `run_${expectedHash.slice("sha256:".length)}`;
  if (manifest.id !== expectedId) {
    throw new RunManifestError("invalid_run_id", `Run ID must be "${expectedId}".`);
  }
  validateTimestamp(manifest.createdAt, "createdAt");
  validateTimestamp(manifest.completedAt, "completedAt");
}

export async function manifestToBaseline(
  manifest: FinalizedRunManifest,
  artifacts: ArtifactStore,
): Promise<BaselineRun> {
  verifyRunManifest(manifest);
  if (manifest.executionStatus !== "completed") {
    throw new RunManifestError(
      "manifest_not_completed",
      `Run "${manifest.id}" did not complete successfully and cannot be a baseline.`,
    );
  }

  const stages = await Promise.all(
    manifest.stages.map(async (stage) => {
      let artifactAvailable = false;
      if (stage.outputArtifactHash !== null) {
        try {
          const artifact = await artifacts.get(stage.outputArtifactHash);
          if (artifact !== undefined) {
            decodeArtifact(artifact);
            artifactAvailable = true;
          }
        } catch {
          artifactAvailable = false;
        }
      }
      return Object.freeze({
        stageId: stage.stageId,
        dependencyIds: Object.freeze([...stage.dependencyIds]),
        fingerprint: stage.fingerprint ?? "",
        componentHashes: stage.componentHashes ?? emptyComponentHashes(),
        executionStatus: stage.executionStatus,
        outputArtifactHash: stage.outputArtifactHash,
        artifactAvailable,
      });
    }),
  );

  return Object.freeze({
    id: manifest.id,
    manifestHash: manifest.manifestHash,
    workflowId: manifest.workflowId,
    executionStatus: "completed",
    stages: Object.freeze(stages),
  });
}

function manifestBody(
  manifest: FinalizedRunManifest,
): Omit<FinalizedRunManifest, "id" | "manifestHash"> {
  return {
    schemaVersion: manifest.schemaVersion,
    workflowId: manifest.workflowId,
    baselineRunId: manifest.baselineRunId,
    baselineManifestHash: manifest.baselineManifestHash,
    createdAt: manifest.createdAt,
    completedAt: manifest.completedAt,
    executionStatus: manifest.executionStatus,
    evaluationStatus: manifest.evaluationStatus,
    stages: manifest.stages,
  };
}

function hashManifestBody(body: JsonValue): string {
  const hash = createHash("sha256")
    .update(RUN_MANIFEST_DOMAIN)
    .update(canonicalizeJson(body))
    .digest("hex");
  return `sha256:${hash}`;
}

function validateTimestamp(value: string, field: string): void {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new RunManifestError(
      "invalid_timestamp",
      `${field} must be a canonical ISO 8601 UTC timestamp.`,
    );
  }
}

function cloneJson(value: JsonObject): JsonObject {
  return JSON.parse(canonicalizeJson(value)) as JsonObject;
}

function deepFreezeManifest(manifest: FinalizedRunManifest): FinalizedRunManifest {
  for (const stage of manifest.stages) {
    Object.freeze(stage.dependencyIds);
    Object.freeze(stage.decisionDetails);
    if (stage.componentHashes !== null) Object.freeze(stage.componentHashes);
    if (stage.error !== null) Object.freeze(stage.error);
    Object.freeze(stage);
  }
  Object.freeze(manifest.stages);
  return Object.freeze(manifest);
}

function emptyComponentHashes(): FingerprintComponentHashes {
  return {
    cachePolicy: "",
    codec: "",
    dependencies: "",
    environment: "",
    implementation: "",
    selectedInputs: "",
    watchedFiles: "",
  };
}
