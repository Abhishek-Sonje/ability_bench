import { computeStageFingerprint, type FingerprintComponentHashes } from "./fingerprint.js";
import type { BuiltWorkflow, JsonObject } from "./types.js";

export type DecisionReason =
  | "no_baseline"
  | "manual_invalidation"
  | "volatile_stage"
  | "cache_disabled"
  | "stage_missing_from_baseline"
  | "baseline_stage_not_reusable"
  | "dependency_executed"
  | "fingerprint_changed"
  | "fingerprint_match"
  | "baseline_artifact_unavailable";

export type BaselineStageExecutionStatus =
  | "reused"
  | "succeeded"
  | "failed"
  | "pending"
  | "skipped_dependency_failed"
  | "skipped_run_stopped";

export interface BaselineStageRecord {
  readonly stageId: string;
  readonly dependencyIds: readonly string[];
  readonly fingerprint: string;
  readonly componentHashes: FingerprintComponentHashes;
  readonly executionStatus: BaselineStageExecutionStatus;
  readonly outputArtifactHash: string | null;
  readonly artifactAvailable: boolean;
}

export interface BaselineRun {
  readonly id: string;
  readonly manifestHash: string;
  readonly workflowId: string;
  readonly executionStatus: "completed" | "failed" | "cancelled";
  readonly stages: readonly BaselineStageRecord[];
}

export interface StagePlanDecision {
  readonly stageId: string;
  readonly decision: "reuse" | "execute";
  readonly reason: DecisionReason;
  readonly details: JsonObject;
  readonly baselineRunId: string | null;
  readonly baselineArtifactHash: string | null;
  readonly fingerprint: string | null;
  readonly componentHashes: FingerprintComponentHashes | null;
}

export interface WorkflowPlan {
  readonly workflowId: string;
  readonly baselineRunId: string | null;
  readonly baselineManifestHash: string | null;
  readonly decisions: readonly StagePlanDecision[];
}

export type PlanningErrorCode =
  | "baseline_not_completed"
  | "baseline_workflow_mismatch"
  | "duplicate_baseline_stage"
  | "unknown_invalidation_target";

export class PlanningError extends Error {
  constructor(
    readonly code: PlanningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlanningError";
  }
}

export interface PlanWorkflowRequest {
  readonly workflow: BuiltWorkflow;
  readonly inputs: JsonObject;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly baseline: BaselineRun | null;
  readonly invalidate: readonly string[];
}

export async function planWorkflow(request: PlanWorkflowRequest): Promise<WorkflowPlan> {
  const { workflow, baseline } = request;
  validateBaseline(workflow, baseline);

  const stagesById = new Map(workflow.stages.map((stage) => [stage.id, stage]));
  const invalidated = new Set(request.invalidate);
  for (const stageId of invalidated) {
    if (!stagesById.has(stageId)) {
      throw new PlanningError(
        "unknown_invalidation_target",
        `Cannot invalidate unknown stage "${stageId}".`,
      );
    }
  }

  const baselineStages = new Map<string, BaselineStageRecord>();
  for (const stage of baseline?.stages ?? []) {
    if (baselineStages.has(stage.stageId)) {
      throw new PlanningError(
        "duplicate_baseline_stage",
        `Baseline "${baseline?.id}" contains stage "${stage.stageId}" more than once.`,
      );
    }
    baselineStages.set(stage.stageId, stage);
  }

  const decisions = new Map<string, StagePlanDecision>();
  for (const stageId of workflow.topologicalOrder) {
    const stage = stagesById.get(stageId);
    if (stage === undefined) throw new Error(`Validated stage "${stageId}" is unavailable.`);
    const baselineStage = baselineStages.get(stageId);

    const decideExecute = (reason: DecisionReason, details: JsonObject = {}): void => {
      decisions.set(
        stageId,
        Object.freeze({
          stageId,
          decision: "execute",
          reason,
          details: Object.freeze(details),
          baselineRunId: baseline?.id ?? null,
          baselineArtifactHash: baselineStage?.outputArtifactHash ?? null,
          fingerprint: null,
          componentHashes: null,
        }),
      );
    };

    if (baseline === null) {
      decideExecute("no_baseline");
      continue;
    }
    if (invalidated.has(stageId)) {
      decideExecute("manual_invalidation");
      continue;
    }
    if (stage.cachePolicy === "volatile") {
      decideExecute("volatile_stage");
      continue;
    }
    if (stage.cachePolicy === "disabled") {
      decideExecute("cache_disabled");
      continue;
    }

    const executingDependencies = stage.dependencyIds.filter(
      (dependencyId) => decisions.get(dependencyId)?.decision === "execute",
    );
    if (executingDependencies.length > 0) {
      decideExecute("dependency_executed", {
        dependencies: [...executingDependencies].sort(compareStrings),
      });
      continue;
    }
    if (baselineStage === undefined) {
      decideExecute("stage_missing_from_baseline");
      continue;
    }
    if (
      (baselineStage.executionStatus !== "reused" &&
        baselineStage.executionStatus !== "succeeded") ||
      baselineStage.outputArtifactHash === null
    ) {
      decideExecute("baseline_stage_not_reusable", {
        baselineExecutionStatus: baselineStage.executionStatus,
      });
      continue;
    }
    if (!baselineStage.artifactAvailable) {
      decideExecute("baseline_artifact_unavailable");
      continue;
    }

    const dependencyArtifacts = Object.fromEntries(
      stage.dependencyIds.map((dependencyId) => {
        const decision = decisions.get(dependencyId);
        if (
          decision?.baselineArtifactHash === null ||
          decision?.baselineArtifactHash === undefined
        ) {
          throw new Error(`Reusable dependency "${dependencyId}" has no baseline artifact.`);
        }
        return [dependencyId, decision.baselineArtifactHash];
      }),
    );
    const current = await computeStageFingerprint({
      workflowId: workflow.id,
      workflowRoot: workflow.root,
      stage,
      runInputs: request.inputs,
      environment: request.environment,
      dependencyArtifacts,
    });

    if (current.fingerprint !== baselineStage.fingerprint) {
      decideExecute("fingerprint_changed", {
        changedComponents: changedComponents(
          baselineStage.componentHashes,
          current.componentHashes,
        ),
      });
      continue;
    }

    decisions.set(
      stageId,
      Object.freeze({
        stageId,
        decision: "reuse",
        reason: "fingerprint_match",
        details: Object.freeze({}),
        baselineRunId: baseline.id,
        baselineArtifactHash: baselineStage.outputArtifactHash,
        fingerprint: current.fingerprint,
        componentHashes: current.componentHashes,
      }),
    );
  }

  return Object.freeze({
    workflowId: workflow.id,
    baselineRunId: baseline?.id ?? null,
    baselineManifestHash: baseline?.manifestHash ?? null,
    decisions: Object.freeze(
      workflow.topologicalOrder.map((stageId) => {
        const decision = decisions.get(stageId);
        if (decision === undefined) throw new Error(`Stage "${stageId}" has no plan decision.`);
        return decision;
      }),
    ),
  });
}

function validateBaseline(workflow: BuiltWorkflow, baseline: BaselineRun | null): void {
  if (baseline === null) return;
  if (baseline.workflowId !== workflow.id) {
    throw new PlanningError(
      "baseline_workflow_mismatch",
      `Baseline workflow "${baseline.workflowId}" does not match "${workflow.id}".`,
    );
  }
  if (baseline.executionStatus !== "completed") {
    throw new PlanningError(
      "baseline_not_completed",
      `Baseline "${baseline.id}" is not completed.`,
    );
  }
}

function changedComponents(
  baseline: FingerprintComponentHashes,
  current: FingerprintComponentHashes,
): string[] {
  return Object.keys(current)
    .filter((name) => {
      const key = name as keyof FingerprintComponentHashes;
      return current[key] !== baseline[key];
    })
    .sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
