import type { ArtifactStore } from "./artifact-store.js";
import { computeStageFingerprint, type FingerprintComponentHashes } from "./fingerprint.js";
import type { DecisionReason, WorkflowPlan } from "./planning.js";
import { canonicalizeJson, createArtifact, decodeArtifact } from "./serialization.js";
import type { BuiltWorkflow, JsonObject, JsonValue, StageDefinition } from "./types.js";

export type StageExecutionStatus =
  | "pending"
  | "reused"
  | "succeeded"
  | "failed"
  | "skipped_dependency_failed"
  | "skipped_run_stopped";

export interface SerializedExecutionError {
  readonly name: string;
  readonly message: string;
}

export interface ExecutedStageRecord {
  readonly stageId: string;
  readonly plannedDecision: "reuse" | "execute";
  readonly finalDecision: "reuse" | "execute";
  readonly decisionReason: DecisionReason;
  readonly decisionDetails: JsonObject;
  readonly executionStatus: StageExecutionStatus;
  readonly evaluationStatus: "not_run";
  readonly fingerprint: string | null;
  readonly componentHashes: FingerprintComponentHashes | null;
  readonly outputArtifactHash: string | null;
  readonly error: SerializedExecutionError | null;
}

export interface WorkflowExecutionResult {
  readonly workflowId: string;
  readonly baselineRunId: string | null;
  readonly baselineManifestHash: string | null;
  readonly executionStatus: "completed" | "failed";
  readonly evaluationStatus: "not_run";
  readonly stages: readonly ExecutedStageRecord[];
}

export interface ExecuteWorkflowRequest {
  readonly workflow: BuiltWorkflow;
  readonly plan: WorkflowPlan;
  readonly inputs: JsonObject;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly artifacts: ArtifactStore;
}

export async function executeWorkflow(
  request: ExecuteWorkflowRequest,
): Promise<WorkflowExecutionResult> {
  assertPlanMatchesWorkflow(request.workflow, request.plan);
  const stagesById = new Map(request.workflow.stages.map((stage) => [stage.id, stage]));
  const plannedById = new Map(
    request.plan.decisions.map((decision) => [decision.stageId, decision]),
  );
  const records = new Map<string, ExecutedStageRecord>();
  const values = new Map<string, JsonValue>();
  const artifactHashes = new Map<string, string>();
  let failedStageId: string | null = null;

  for (const stageId of request.workflow.topologicalOrder) {
    const stage = required(stagesById.get(stageId), `Stage "${stageId}" is missing.`);
    const planned = required(plannedById.get(stageId), `Stage "${stageId}" has no plan decision.`);

    if (failedStageId !== null) {
      const dependsOnFailure = isDescendant(stageId, failedStageId, stagesById);
      records.set(
        stageId,
        skippedRecord(
          stageId,
          planned.decision,
          planned.reason,
          dependsOnFailure ? "skipped_dependency_failed" : "skipped_run_stopped",
        ),
      );
      continue;
    }

    const executedDependencies = stage.dependencyIds.filter(
      (dependencyId) => records.get(dependencyId)?.finalDecision === "execute",
    );
    let finalDecision = planned.decision;
    let reason = planned.reason;
    let details = planned.details;
    if (executedDependencies.length > 0 && finalDecision === "reuse") {
      finalDecision = "execute";
      reason = "dependency_executed";
      details = { dependencies: executedDependencies };
    }

    if (finalDecision === "reuse") {
      try {
        const dependencyArtifacts = Object.fromEntries(
          stage.dependencyIds.map((dependencyId) => [
            dependencyId,
            required(
              artifactHashes.get(dependencyId),
              `Dependency "${dependencyId}" has no artifact.`,
            ),
          ]),
        );
        const current = await computeStageFingerprint({
          workflowId: request.workflow.id,
          workflowRoot: request.workflow.root,
          stage,
          runInputs: request.inputs,
          environment: request.environment,
          dependencyArtifacts,
        });
        if (current.fingerprint !== planned.fingerprint) {
          finalDecision = "execute";
          reason = "fingerprint_changed";
          details = {
            changedComponents: Object.keys(current.componentHashes)
              .filter((name) => {
                const component = name as keyof FingerprintComponentHashes;
                return current.componentHashes[component] !== planned.componentHashes?.[component];
              })
              .sort(),
          };
        }
      } catch (error: unknown) {
        failedStageId = stageId;
        records.set(
          stageId,
          Object.freeze({
            stageId,
            plannedDecision: planned.decision,
            finalDecision: "execute",
            decisionReason: reason,
            decisionDetails: details,
            executionStatus: "failed",
            evaluationStatus: "not_run",
            fingerprint: null,
            componentHashes: null,
            outputArtifactHash: null,
            error: serializeError(error),
          }),
        );
        continue;
      }
    }

    if (finalDecision === "reuse") {
      const hash = planned.baselineArtifactHash;
      if (hash !== null) {
        try {
          const artifact = await request.artifacts.get(hash);
          if (artifact !== undefined) {
            const value = decodeArtifact(artifact);
            values.set(stageId, value);
            artifactHashes.set(stageId, hash);
            records.set(
              stageId,
              Object.freeze({
                stageId,
                plannedDecision: planned.decision,
                finalDecision: "reuse",
                decisionReason: reason,
                decisionDetails: details,
                executionStatus: "reused",
                evaluationStatus: "not_run",
                fingerprint: planned.fingerprint,
                componentHashes: planned.componentHashes,
                outputArtifactHash: hash,
                error: null,
              }),
            );
            continue;
          }
        } catch {
          // Integrity failures conservatively fall through to execution.
        }
      }
      finalDecision = "execute";
      reason = "baseline_artifact_unavailable";
      details = {};
    }

    try {
      const dependencyArtifacts = Object.fromEntries(
        stage.dependencyIds.map((dependencyId) => [
          dependencyId,
          required(
            artifactHashes.get(dependencyId),
            `Dependency "${dependencyId}" has no artifact.`,
          ),
        ]),
      );
      const fingerprint = await computeStageFingerprint({
        workflowId: request.workflow.id,
        workflowRoot: request.workflow.root,
        stage,
        runInputs: request.inputs,
        environment: request.environment,
        dependencyArtifacts,
      });
      const result = await stage.run({
        dependencies: Object.freeze(
          Object.fromEntries(
            stage.dependencyIds.map((dependencyId) => [
              dependencyId,
              cloneJson(
                required(values.get(dependencyId), `Dependency "${dependencyId}" has no value.`),
              ),
            ]),
          ),
        ),
        inputs: Object.freeze(projectInputs(request.inputs, stage)),
        env: Object.freeze(
          Object.fromEntries(
            stage.environmentNames.map((name) => [name, request.environment[name]]),
          ),
        ),
      });
      const artifact = createArtifact(result);
      await request.artifacts.put(artifact);
      values.set(stageId, decodeArtifact(artifact));
      artifactHashes.set(stageId, artifact.contentHash);
      records.set(
        stageId,
        Object.freeze({
          stageId,
          plannedDecision: planned.decision,
          finalDecision,
          decisionReason: reason,
          decisionDetails: details,
          executionStatus: "succeeded",
          evaluationStatus: "not_run",
          fingerprint: fingerprint.fingerprint,
          componentHashes: fingerprint.componentHashes,
          outputArtifactHash: artifact.contentHash,
          error: null,
        }),
      );
    } catch (error: unknown) {
      failedStageId = stageId;
      records.set(
        stageId,
        Object.freeze({
          stageId,
          plannedDecision: planned.decision,
          finalDecision: "execute",
          decisionReason: reason,
          decisionDetails: details,
          executionStatus: "failed",
          evaluationStatus: "not_run",
          fingerprint: null,
          componentHashes: null,
          outputArtifactHash: null,
          error: serializeError(error),
        }),
      );
    }
  }

  return Object.freeze({
    workflowId: request.workflow.id,
    baselineRunId: request.plan.baselineRunId,
    baselineManifestHash: request.plan.baselineManifestHash,
    executionStatus: failedStageId === null ? "completed" : "failed",
    evaluationStatus: "not_run",
    stages: Object.freeze(
      request.workflow.topologicalOrder.map((stageId) =>
        required(records.get(stageId), `Stage "${stageId}" has no execution record.`),
      ),
    ),
  });
}

function projectInputs(inputs: JsonObject, stage: StageDefinition): JsonObject {
  const projected: JsonObject = {};
  for (const pointer of stage.inputPointers) {
    const selected = resolvePointer(inputs, pointer);
    if (selected.found) projected[pointer] = cloneJson(selected.value);
  }
  return projected;
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(canonicalizeJson(value)) as JsonValue;
}

function resolvePointer(
  root: JsonValue,
  pointer: string,
): { found: true; value: JsonValue } | { found: false } {
  if (pointer === "") return { found: true, value: root };
  let current = root;
  for (const part of pointer.slice(1).split("/")) {
    const token = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return { found: false };
      const next = current[Number(token)];
      if (next === undefined) return { found: false };
      current = next;
    } else if (current !== null && typeof current === "object") {
      const next = current[token];
      if (next === undefined) return { found: false };
      current = next;
    } else return { found: false };
  }
  return { found: true, value: current };
}

function isDescendant(
  candidateId: string,
  ancestorId: string,
  stages: ReadonlyMap<string, StageDefinition>,
): boolean {
  const pending = [...(stages.get(candidateId)?.dependencyIds ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    if (current === ancestorId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(stages.get(current)?.dependencyIds ?? []));
  }
  return false;
}

function skippedRecord(
  stageId: string,
  plannedDecision: "reuse" | "execute",
  reason: DecisionReason,
  status: "skipped_dependency_failed" | "skipped_run_stopped",
): ExecutedStageRecord {
  return Object.freeze({
    stageId,
    plannedDecision,
    finalDecision: "execute",
    decisionReason: reason,
    decisionDetails: {},
    executionStatus: status,
    evaluationStatus: "not_run",
    fingerprint: null,
    componentHashes: null,
    outputArtifactHash: null,
    error: null,
  });
}

function serializeError(error: unknown): SerializedExecutionError {
  return error instanceof Error
    ? Object.freeze({ name: error.name, message: error.message })
    : Object.freeze({ name: "UnknownError", message: String(error) });
}

function assertPlanMatchesWorkflow(workflow: BuiltWorkflow, plan: WorkflowPlan): void {
  if (workflow.id !== plan.workflowId) {
    throw new TypeError(`Plan workflow "${plan.workflowId}" does not match "${workflow.id}".`);
  }
  const plannedIds = plan.decisions.map(({ stageId }) => stageId);
  if (
    plannedIds.length !== workflow.topologicalOrder.length ||
    plannedIds.some((stageId, index) => stageId !== workflow.topologicalOrder[index])
  ) {
    throw new TypeError("Plan stages do not match the workflow's topological order.");
  }
}

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new Error(message);
  return value;
}
