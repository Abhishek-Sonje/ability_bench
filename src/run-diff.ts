import {
  type FinalizedRunManifest,
  type RunManifestStage,
  verifyRunManifest,
} from "./run-manifest.js";
import { canonicalizeJson } from "./serialization.js";
import type { JsonValue } from "./types.js";

export type StageDiffKind = "added" | "removed" | "changed" | "unchanged";

export interface StageRunDiff {
  readonly stageId: string;
  readonly kind: StageDiffKind;
  readonly changedFields: readonly string[];
  readonly before: RunManifestStage | null;
  readonly after: RunManifestStage | null;
}

export interface RunDiffSummary {
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly unchanged: number;
}

export interface RunDiff {
  readonly schemaVersion: "phase1-run-diff-v1";
  readonly workflowId: string;
  readonly from: RunDiffIdentity;
  readonly to: RunDiffIdentity;
  readonly summary: RunDiffSummary;
  readonly stages: readonly StageRunDiff[];
}

export interface RunDiffIdentity {
  readonly runId: string;
  readonly manifestHash: string;
  readonly baselineRunId: string | null;
  readonly executionStatus: "completed" | "failed";
  readonly evaluationStatus: "not_run";
  readonly createdAt: string;
  readonly completedAt: string;
}

export class RunDiffError extends Error {
  constructor(
    readonly code: "workflow_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "RunDiffError";
  }
}

const STAGE_FIELDS = [
  "dependencyIds",
  "plannedDecision",
  "finalDecision",
  "decisionReason",
  "decisionDetails",
  "executionStatus",
  "evaluationStatus",
  "fingerprint",
  "componentHashes",
  "outputArtifactHash",
  "error",
] as const satisfies readonly Exclude<keyof RunManifestStage, "stageId">[];

export function diffRunManifests(from: FinalizedRunManifest, to: FinalizedRunManifest): RunDiff {
  verifyRunManifest(from);
  verifyRunManifest(to);
  if (from.workflowId !== to.workflowId) {
    throw new RunDiffError(
      "workflow_mismatch",
      `Cannot diff workflow "${from.workflowId}" against "${to.workflowId}".`,
    );
  }

  const fromStages = new Map(from.stages.map((stage) => [stage.stageId, stage]));
  const toStages = new Map(to.stages.map((stage) => [stage.stageId, stage]));
  const stageIds = [
    ...from.stages.map(({ stageId }) => stageId),
    ...to.stages.map(({ stageId }) => stageId).filter((stageId) => !fromStages.has(stageId)),
  ];
  const stages = stageIds.map((stageId): StageRunDiff => {
    const before = fromStages.get(stageId) ?? null;
    const after = toStages.get(stageId) ?? null;
    if (before === null) {
      return Object.freeze({ stageId, kind: "added", changedFields: [], before, after });
    }
    if (after === null) {
      return Object.freeze({ stageId, kind: "removed", changedFields: [], before, after });
    }
    const changedFields = STAGE_FIELDS.filter(
      (field) => !canonicallyEqual(before[field], after[field]),
    );
    return Object.freeze({
      stageId,
      kind: changedFields.length === 0 ? "unchanged" : "changed",
      changedFields: Object.freeze(changedFields),
      before,
      after,
    });
  });
  const count = (kind: StageDiffKind) => stages.filter((stage) => stage.kind === kind).length;

  return Object.freeze({
    schemaVersion: "phase1-run-diff-v1",
    workflowId: from.workflowId,
    from: identity(from),
    to: identity(to),
    summary: Object.freeze({
      added: count("added"),
      removed: count("removed"),
      changed: count("changed"),
      unchanged: count("unchanged"),
    }),
    stages: Object.freeze(stages),
  });
}

function identity(manifest: FinalizedRunManifest): RunDiffIdentity {
  return Object.freeze({
    runId: manifest.id,
    manifestHash: manifest.manifestHash,
    baselineRunId: manifest.baselineRunId,
    executionStatus: manifest.executionStatus,
    evaluationStatus: manifest.evaluationStatus,
    createdAt: manifest.createdAt,
    completedAt: manifest.completedAt,
  });
}

function canonicallyEqual(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue);
}
