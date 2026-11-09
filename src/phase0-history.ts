// biome-ignore-all lint/complexity/useLiteralKeys: Unknown schema fields require bracket access.
import {
  digest,
  HASH,
  keys,
  object,
  oneOf,
  pattern,
  RUN_ID,
  requireValue,
  timestamp,
  validId,
} from "./recorded-schema.js";
import type { JsonObject, JsonValue } from "./types.js";

type Decision = "reuse" | "execute";

interface Phase0Stage {
  stageId: string;
  dependencyIds: string[];
  plannedDecision: Decision;
  finalDecision: Decision;
  decisionReason: string;
  decisionDetails: JsonObject;
  executionStatus:
    | "succeeded"
    | "reused"
    | "failed"
    | "skipped_dependency_failed"
    | "skipped_run_stopped";
  evaluationStatus: "not_run";
  fingerprint: string | null;
  componentHashes: Record<string, string> | null;
  outputArtifactHash: string | null;
  error: { name: string; message: string } | null;
}

export interface Phase0Run {
  schemaVersion: "phase0-run-v1";
  id: string;
  manifestHash: string;
  workflowId: string;
  baselineRunId: string | null;
  baselineManifestHash: string | null;
  createdAt: string;
  completedAt: string;
  executionStatus: "completed" | "failed";
  evaluationStatus: "not_run";
  stages: Phase0Stage[];
}

const reasons =
  "no_baseline,manual_invalidation,volatile_stage,cache_disabled,stage_missing_from_baseline,baseline_stage_not_reusable,dependency_executed,fingerprint_changed,fingerprint_match,baseline_artifact_unavailable";

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isPhase0Run(
  value: JsonValue,
): value is JsonObject & { schemaVersion: "phase0-run-v1" } {
  return isObject(value) && value["schemaVersion"] === "phase0-run-v1";
}

// Phase 0 sorts keys lexically in the serialized bytes, including integer-like keys.
function phase0Json(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(phase0Json).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${phase0Json(key)}:${phase0Json(value[key] as JsonValue)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") requireValue(value.isWellFormed());
  if (typeof value === "number") requireValue(Number.isFinite(value) && !Object.is(value, -0));
  return JSON.stringify(value);
}

export function parsePhase0(text: string, value: JsonValue): JsonValue {
  requireValue(phase0Json(value) === text);
  return value;
}

const componentFields =
  "cachePolicy,codec,dependencies,environment,implementation,selectedInputs,watchedFiles";
const componentNames = componentFields.split(",");

function validateDecisionDetails(details: unknown, reason: unknown, dependencyIds: string[]): void {
  switch (reason) {
    case "fingerprint_changed": {
      keys(details, "changedComponents");
      const { changedComponents } = details;
      requireValue(
        Array.isArray(changedComponents) &&
          changedComponents.every(
            (name) => typeof name === "string" && componentNames.includes(name),
          ) &&
          new Set(changedComponents).size === changedComponents.length,
      );
      break;
    }
    case "dependency_executed": {
      keys(details, "dependencies");
      const { dependencies } = details;
      requireValue(
        Array.isArray(dependencies) &&
          dependencies.length > 0 &&
          dependencies.every((id) => validId(id) && dependencyIds.includes(id)) &&
          new Set(dependencies).size === dependencies.length,
      );
      break;
    }
    case "baseline_stage_not_reusable":
      keys(details, "baselineExecutionStatus");
      oneOf(
        details["baselineExecutionStatus"],
        "succeeded,reused,failed,pending,skipped_dependency_failed,skipped_run_stopped",
      );
      break;
    default:
      object(details);
      requireValue(Object.keys(details).length === 0);
  }
}

function validateStages(stages: unknown[], hasBaseline: boolean): boolean {
  const seen = new Set<string>();
  const blocked = new Set<string>();
  let failed = false;
  for (const stage of stages) {
    keys(
      stage,
      "componentHashes,decisionDetails,decisionReason,dependencyIds,error,evaluationStatus,executionStatus,finalDecision,fingerprint,outputArtifactHash,plannedDecision,stageId",
    );
    const {
      stageId,
      dependencyIds,
      plannedDecision,
      finalDecision,
      decisionReason,
      decisionDetails,
      executionStatus,
      evaluationStatus,
      fingerprint,
      componentHashes,
      outputArtifactHash,
      error,
    } = stage;
    requireValue(validId(stageId) && !seen.has(stageId));
    requireValue(
      Array.isArray(dependencyIds) &&
        dependencyIds.every((id) => validId(id) && seen.has(id)) &&
        new Set(dependencyIds).size === dependencyIds.length,
    );
    seen.add(stageId);
    oneOf(plannedDecision, "reuse,execute");
    oneOf(finalDecision, "reuse,execute");
    oneOf(decisionReason, reasons);
    requireValue(evaluationStatus === "not_run");
    requireValue(plannedDecision !== "reuse" || hasBaseline);
    if (failed) {
      const dependsOnFailure = dependencyIds.some((id) => blocked.has(id));
      requireValue(
        executionStatus ===
          (dependsOnFailure ? "skipped_dependency_failed" : "skipped_run_stopped"),
      );
      validateDecisionDetails(decisionDetails, null, dependencyIds);
      if (dependsOnFailure) blocked.add(stageId);
      requireValue(finalDecision === "execute" && error === null);
    } else {
      validateDecisionDetails(decisionDetails, decisionReason, dependencyIds);
      oneOf(executionStatus, "succeeded,reused,failed");
      requireValue(finalDecision === (executionStatus === "reused" ? "reuse" : "execute"));
      if (executionStatus === "reused") {
        requireValue(plannedDecision === "reuse" && decisionReason === "fingerprint_match");
      }
      if (executionStatus === "failed") {
        keys(error, "message,name");
        requireValue(typeof error["message"] === "string" && typeof error["name"] === "string");
        failed = true;
        blocked.add(stageId);
      } else {
        requireValue(error === null);
      }
    }
    if (executionStatus === "succeeded" || executionStatus === "reused") {
      pattern(outputArtifactHash, HASH);
      pattern(fingerprint, HASH);
      keys(componentHashes, componentFields);
      for (const hash of Object.values(componentHashes)) pattern(hash, HASH);
    } else {
      requireValue(outputArtifactHash === null && fingerprint === null && componentHashes === null);
    }
  }
  return failed;
}

export function validatePhase0Run(text: string, value: JsonObject, runId: string): Phase0Run {
  parsePhase0(text, value);
  keys(
    value,
    "baselineManifestHash,baselineRunId,completedAt,createdAt,evaluationStatus,executionStatus,id,manifestHash,schemaVersion,stages,workflowId",
  );
  const { id, manifestHash, ...body } = value;
  const { baselineRunId, baselineManifestHash, createdAt, completedAt, executionStatus, stages } =
    body;
  requireValue(validId(body["workflowId"]) && body["evaluationStatus"] === "not_run");
  timestamp(createdAt);
  timestamp(completedAt);
  requireValue(String(completedAt) >= String(createdAt));
  if (baselineRunId === null) requireValue(baselineManifestHash === null);
  else {
    pattern(baselineRunId, RUN_ID);
    pattern(baselineManifestHash, HASH);
    requireValue(
      baselineRunId === `run_${String(baselineManifestHash).slice(7)}` && baselineRunId !== id,
    );
  }
  requireValue(Array.isArray(stages));
  const failed = validateStages(stages, baselineRunId !== null);
  requireValue(executionStatus === (failed ? "failed" : "completed"));
  const hash = digest("abilitybench/run-manifest/v1", phase0Json(body));
  requireValue(id === runId && id === `run_${hash.slice(7)}` && manifestHash === hash);
  return value as unknown as Phase0Run;
}
