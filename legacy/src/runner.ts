import { isAbsolute, relative, resolve, sep } from "node:path";

import { executeWorkflow, type WorkflowExecutionResult } from "./execution.js";
import { FileArtifactStore, FileRunManifestStore } from "./filesystem-store.js";
import { PathEscapeError, resolveContainedPath } from "./path-safety.js";
import { planWorkflow, type WorkflowPlan } from "./planning.js";
import {
  type FinalizedRunManifest,
  finalizeRunManifest,
  manifestToBaseline,
} from "./run-manifest.js";
import { canonicalizeJson } from "./serialization.js";
import type { BuiltWorkflow, JsonObject } from "./types.js";

export interface PlanWorkflowRunOptions {
  readonly inputs: JsonObject;
  readonly baseline: { readonly runId: string } | null;
  readonly invalidate?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly storageDir?: string;
}

export interface RunWorkflowOptions extends PlanWorkflowRunOptions {
  readonly failureMode?: "stop";
}

export interface PlanWorkflowRunResult {
  readonly plan: WorkflowPlan;
  readonly storageDir: string;
}

export interface RunWorkflowResult {
  readonly manifest: FinalizedRunManifest;
  readonly plan: WorkflowPlan;
  readonly execution: WorkflowExecutionResult;
  readonly storageDir: string;
}

export type RunWorkflowErrorCode =
  | "baseline_not_found"
  | "invalid_inputs"
  | "storage_path_escaped"
  | "storage_path_watched";

export class RunWorkflowError extends Error {
  constructor(
    readonly code: RunWorkflowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunWorkflowError";
  }
}

interface PreparedWorkflowRun extends PlanWorkflowRunResult {
  readonly inputs: JsonObject;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly artifacts: FileArtifactStore;
  readonly manifests: FileRunManifestStore;
}

/** Computes a predictive plan without executing stages or writing run state. */
export async function planWorkflowRun(
  workflow: BuiltWorkflow,
  options: PlanWorkflowRunOptions,
): Promise<PlanWorkflowRunResult> {
  const prepared = await prepareWorkflowRun(workflow, options);
  return Object.freeze({ plan: prepared.plan, storageDir: prepared.storageDir });
}

/** Runs one candidate against exactly the baseline selected by the caller. */
export async function runWorkflow(
  workflow: BuiltWorkflow,
  options: RunWorkflowOptions,
): Promise<RunWorkflowResult> {
  const prepared = await prepareWorkflowRun(workflow, options);
  const createdAt = new Date().toISOString();
  const execution = await executeWorkflow({
    workflow,
    plan: prepared.plan,
    inputs: prepared.inputs,
    environment: prepared.environment,
    artifacts: prepared.artifacts,
  });
  const manifest = finalizeRunManifest({
    workflow,
    execution,
    createdAt,
    completedAt: new Date().toISOString(),
  });
  await prepared.manifests.put(manifest);
  return Object.freeze({
    manifest,
    plan: prepared.plan,
    execution,
    storageDir: prepared.storageDir,
  });
}

async function prepareWorkflowRun(
  workflow: BuiltWorkflow,
  options: PlanWorkflowRunOptions,
): Promise<PreparedWorkflowRun> {
  let inputs: JsonObject;
  try {
    const snapshot: unknown = JSON.parse(canonicalizeJson(options.inputs));
    if (snapshot === null || Array.isArray(snapshot) || typeof snapshot !== "object") {
      throw new TypeError("Expected a JSON object.");
    }
    inputs = snapshot as JsonObject;
  } catch (error: unknown) {
    throw new RunWorkflowError(
      "invalid_inputs",
      `Run inputs must satisfy canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let storageDir: string;
  try {
    storageDir = await resolveContainedPath(workflow.root, options.storageDir ?? ".abilitybench");
  } catch (error: unknown) {
    if (error instanceof PathEscapeError) {
      throw new RunWorkflowError("storage_path_escaped", error.message);
    }
    throw error;
  }
  for (const stage of workflow.stages) {
    for (const watchedPath of stage.watchedPaths) {
      const watchedAbsolute = resolve(workflow.root, watchedPath);
      const remainder = relative(storageDir, watchedAbsolute);
      if (
        remainder === "" ||
        (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
      ) {
        throw new RunWorkflowError(
          "storage_path_watched",
          `Stage "${stage.id}" watches "${watchedPath}" inside the storage directory.`,
        );
      }
    }
  }
  const artifacts = new FileArtifactStore(storageDir);
  const manifests = new FileRunManifestStore(storageDir);
  const baselineManifest =
    options.baseline === null ? null : await manifests.get(options.baseline.runId);
  if (options.baseline !== null && baselineManifest === undefined) {
    throw new RunWorkflowError(
      "baseline_not_found",
      `Baseline run "${options.baseline.runId}" was not found in "${storageDir}".`,
    );
  }
  const baseline =
    baselineManifest === null || baselineManifest === undefined
      ? null
      : await manifestToBaseline(baselineManifest, artifacts);
  const sourceEnvironment = options.environment ?? process.env;
  const environment = Object.freeze(
    Object.fromEntries(
      [...new Set(workflow.stages.flatMap((stage) => stage.environmentNames))]
        .sort()
        .map((name) => [name, sourceEnvironment[name]]),
    ),
  );
  const plan = await planWorkflow({
    workflow,
    inputs,
    environment,
    baseline,
    invalidate: options.invalidate ?? [],
  });
  return Object.freeze({ inputs, environment, storageDir, artifacts, manifests, plan });
}
