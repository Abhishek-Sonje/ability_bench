import { createHash } from "node:crypto";
import {
  type BuiltEvaluationSuite,
  type CheckComparison,
  type CheckVerdict,
  compareCheckVerdicts,
  freezeJson,
  getCheckEvaluator,
  summarizeCheckVerdicts,
  validateCheckResult,
} from "./evaluation.js";
import {
  type PreparedCheckSide,
  type PreparedEvaluationPair,
  type PrepareEvaluationPairOptions,
  prepareEvaluationPair,
  snapshotEvaluationSuite,
} from "./evaluation-pair.js";
import { canonicalizeJson } from "./serialization.js";
import type { JsonObject } from "./types.js";

export class EvaluationExecutionError extends Error {
  readonly code = "evaluation_inputs_changed";
  constructor() {
    super(
      "Declared evaluation implementation inputs changed or became unavailable during evaluation.",
    );
    this.name = "EvaluationExecutionError";
  }
}

export interface EvaluatedCheckSide {
  readonly sourceArtifactHash: string;
  readonly fingerprint: string;
  readonly invocationStatus: "completed" | "error";
  readonly verdict: CheckVerdict;
  readonly details: JsonObject;
  readonly error: {
    readonly code: "output_contract_failed" | "check_threw" | "invalid_check_result";
    readonly name: string;
    readonly message: string;
  } | null;
}

export interface EvaluatedCheckPair {
  readonly checkId: string;
  readonly targetStageId: string;
  readonly baseline: EvaluatedCheckSide;
  readonly candidate: EvaluatedCheckSide;
  readonly comparison: CheckComparison;
}

export interface EvaluationExecutionResult {
  readonly contractVersion: "phase2-evaluation-v1";
  readonly workflowId: string;
  readonly suiteId: string;
  readonly suiteHash: string;
  readonly suiteDescriptor: JsonObject;
  readonly baseline: { readonly runId: string; readonly manifestHash: string };
  readonly candidate: { readonly runId: string; readonly manifestHash: string };
  readonly criteriaArtifactHash: string;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly evaluationStatus: "passed" | "failed" | "error";
  readonly comparisonStatus: "no_regressions" | "regressed" | "error";
  readonly summary: ReturnType<typeof summarizeCheckVerdicts>["summary"];
  readonly checks: readonly EvaluatedCheckPair[];
}

/** Freshly prepares and evaluates both sides; never caches results or writes receipts. */
export async function executeEvaluationPair(
  suite: BuiltEvaluationSuite,
  options: PrepareEvaluationPairOptions,
): Promise<EvaluationExecutionResult> {
  const prepared = await prepareEvaluationPair(suite, options);
  return executePreparedEvaluationPair(suite, prepared);
}

/** Internal runner shared by no-write execution and receipt publication. */
export async function executePreparedEvaluationPair(
  suite: BuiltEvaluationSuite,
  prepared: PreparedEvaluationPair,
): Promise<EvaluationExecutionResult> {
  const createdAt = new Date().toISOString();
  const checks: EvaluatedCheckPair[] = [];
  for (const [index, check] of suite.checks.entries()) {
    const pair = prepared.checks[index];
    if (!pair || pair.checkId !== check.id) throw new Error("Prepared check order mismatch.");
    const evaluate = getCheckEvaluator(check);
    const baseline = await invoke(pair.baseline, check.id, check.targetStage, evaluate);
    const candidate = await invoke(pair.candidate, check.id, check.targetStage, evaluate);
    checks.push(
      Object.freeze({
        checkId: check.id,
        targetStageId: check.targetStage,
        baseline,
        candidate,
        comparison: compareCheckVerdicts(baseline.verdict, candidate.verdict),
      }),
    );
  }
  await assertStable();
  const statuses = summarizeCheckVerdicts(
    checks.map(({ baseline, candidate }) => ({
      baseline: baseline.verdict,
      candidate: candidate.verdict,
    })),
  );
  const result: EvaluationExecutionResult = {
    contractVersion: suite.contractVersion,
    workflowId: suite.workflowId,
    suiteId: suite.id,
    suiteHash: prepared.suiteHash,
    suiteDescriptor: prepared.suiteDescriptor,
    baseline: { runId: prepared.baseline.id, manifestHash: prepared.baseline.manifestHash },
    candidate: { runId: prepared.candidate.id, manifestHash: prepared.candidate.manifestHash },
    criteriaArtifactHash: prepared.criteriaArtifactHash,
    createdAt,
    completedAt: new Date().toISOString(),
    ...statuses,
    checks,
  };
  freezeJson(result);
  return result;

  async function assertStable() {
    try {
      const snapshot = await snapshotEvaluationSuite(suite, prepared.storageDir);
      if (snapshot.suiteHash !== prepared.suiteHash) throw new EvaluationExecutionError();
    } catch {
      throw new EvaluationExecutionError();
    }
  }

  async function invoke(
    side: PreparedCheckSide,
    checkId: string,
    targetStageId: string,
    evaluate: ReturnType<typeof getCheckEvaluator>,
  ): Promise<EvaluatedCheckSide> {
    await assertStable();
    const fingerprint = checkFingerprint(prepared, side, checkId, targetStageId);
    let outcome: EvaluatedCheckSide;
    if (side.error !== null || side.output === null) {
      outcome = failed(
        side,
        fingerprint,
        side.error ?? {
          code: "output_contract_failed",
          name: "Error",
          message: "Prepared selections unavailable.",
        },
      );
    } else {
      const criteria = JSON.parse(canonicalizeJson(prepared.criteria)) as JsonObject;
      freezeJson(criteria);
      let returned: unknown;
      let threw = false;
      let thrown: unknown;
      try {
        returned = await evaluate(Object.freeze({ output: side.output, criteria }));
      } catch (error: unknown) {
        threw = true;
        thrown = error;
      }
      if (threw) {
        outcome = failed(side, fingerprint, { code: "check_threw", ...serializeError(thrown) });
      } else {
        try {
          const result = validateCheckResult(returned);
          outcome = Object.freeze({
            sourceArtifactHash: side.sourceArtifactHash,
            fingerprint,
            invocationStatus: "completed",
            verdict: result.passed ? "passed" : "failed",
            details: result.details,
            error: null,
          });
        } catch (error: unknown) {
          outcome = failed(side, fingerprint, {
            code: "invalid_check_result",
            ...serializeError(error),
          });
        }
      }
    }
    await assertStable();
    return outcome;
  }
}

export function checkFingerprint(
  prepared: Pick<PreparedEvaluationPair, "suiteHash" | "criteriaArtifactHash">,
  side: PreparedCheckSide,
  checkId: string,
  targetStageId: string,
): string {
  const inputs = {
    contractVersion: "phase2-evaluation-v1",
    suiteHash: prepared.suiteHash,
    checkId,
    targetStageId,
    sourceArtifactHash: side.sourceArtifactHash,
    outputCodec: "canonical-json-v1",
    criteriaArtifactHash: prepared.criteriaArtifactHash,
    selectedInputs: side.selectedInputs,
  };
  return `sha256:${createHash("sha256").update("abilitybench/evaluation-check/v1\0").update(canonicalizeJson(inputs)).digest("hex")}`;
}

function failed(
  side: PreparedCheckSide,
  fingerprint: string,
  error: NonNullable<EvaluatedCheckSide["error"]>,
): EvaluatedCheckSide {
  return Object.freeze({
    sourceArtifactHash: side.sourceArtifactHash,
    fingerprint,
    invocationStatus: "error",
    verdict: null,
    details: Object.freeze({}),
    error: Object.freeze(error),
  });
}

function serializeError(error: unknown): { name: string; message: string } {
  // Arbitrary thrown objects/getters must not break the error-reporting path.
  try {
    if (error instanceof Error)
      return {
        name: typeof error.name === "string" ? error.name.toWellFormed() : "Error",
        message:
          typeof error.message === "string"
            ? error.message.toWellFormed()
            : "Evaluator threw an error.",
      };
    if (typeof error === "string") return { name: "Error", message: error.toWellFormed() };
  } catch {
    /* Fall through to a stable generic diagnostic. */
  }
  return { name: "Error", message: "Evaluator threw a non-Error value." };
}
