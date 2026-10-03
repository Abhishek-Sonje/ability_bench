import { canonicalizeJson } from "./serialization.js";
import {
  type InputDefinitions,
  isBuiltInInputDescriptor,
  type TypedInputs,
} from "./typed-workflow.js";
import type { JsonObject } from "./types.js";
import { defineWorkflow } from "./workflow.js";

export class EvaluationValidationError extends TypeError {
  constructor(
    readonly code: "invalid_suite" | "invalid_check_result",
    message: string,
  ) {
    super(message);
    this.name = "EvaluationValidationError";
  }
}

export interface CheckResult {
  readonly passed: boolean;
  readonly details: JsonObject;
}

export interface CheckContext<Inputs extends InputDefinitions> {
  readonly output: TypedInputs<Inputs>;
  readonly criteria: Readonly<JsonObject>;
}

export interface CheckDeclaration<Inputs extends InputDefinitions> {
  readonly id: string;
  readonly targetStage: string;
  readonly outputInputs: Inputs;
  readonly revision: string;
  readonly files: readonly [string, ...string[]];
  readonly evaluate: (context: CheckContext<Inputs>) => CheckResult | Promise<CheckResult>;
}

export interface CheckHandle {
  readonly id: string;
}

export interface EvaluationCheckDefinition {
  readonly id: string;
  readonly targetStage: string;
  readonly outputInputs: InputDefinitions;
  readonly revision: string;
  readonly files: readonly string[];
}

export interface BuiltEvaluationSuite {
  readonly contractVersion: "phase2-evaluation-v1";
  readonly id: string;
  readonly workflowId: string;
  readonly root: string;
  readonly checks: readonly EvaluationCheckDefinition[];
}

const definitions = new WeakMap<CheckHandle, EvaluationCheckDefinition>();
// Keep callbacks private until the runner can validate and isolate selected artifacts.
const callbacks = new WeakMap<object, unknown>();
const suites = new WeakSet<object>();
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

function invalidSuite(message: string): never {
  throw new EvaluationValidationError("invalid_suite", message);
}

/** Internal provenance check: structural lookalikes are not sealed suites. */
export function isBuiltEvaluationSuite(value: unknown): value is BuiltEvaluationSuite {
  return typeof value === "object" && value !== null && suites.has(value);
}

/** Declares a check; never invokes its evaluator. */
export function defineCheck<const Inputs extends InputDefinitions>(
  declaration: CheckDeclaration<Inputs>,
): CheckHandle {
  if (
    typeof declaration.id !== "string" ||
    typeof declaration.targetStage !== "string" ||
    !ID_PATTERN.test(declaration.id) ||
    !ID_PATTERN.test(declaration.targetStage)
  ) {
    invalidSuite("Check and target stage IDs must use the supported identifier syntax.");
  }
  if (typeof declaration.evaluate !== "function") invalidSuite("A check requires an evaluator.");
  if (typeof declaration.revision !== "string" || declaration.revision.trim() === "") {
    invalidSuite("A check requires a nonempty revision.");
  }
  if (!Array.isArray(declaration.files) || declaration.files.length === 0) {
    invalidSuite("A check requires at least one implementation file.");
  }
  const inputs = declaration.outputInputs;
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
    invalidSuite("Check outputInputs must be an object of built-in descriptors.");
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(inputs))) {
    invalidSuite("Check outputInputs must be a plain object.");
  }
  for (const key of Reflect.ownKeys(inputs)) {
    const property = Object.getOwnPropertyDescriptor(inputs, key);
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      !property?.enumerable ||
      !("value" in property) ||
      !isBuiltInInputDescriptor(property.value)
    ) {
      invalidSuite(
        "Output aliases require enumerable data properties containing built-in descriptors.",
      );
    }
    try {
      canonicalizeJson(key);
    } catch {
      invalidSuite("Output aliases must contain valid Unicode scalar values.");
    }
  }
  const handle = Object.freeze({ id: declaration.id });
  definitions.set(
    handle,
    Object.freeze({
      id: declaration.id,
      targetStage: declaration.targetStage,
      outputInputs: Object.freeze(
        Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      ),
      revision: declaration.revision,
      files: Object.freeze([...declaration.files]),
    }),
  );
  callbacks.set(handle, declaration.evaluate);
  return handle;
}

/** Validates and seals a complete independent check suite without reading files. */
export function createEvaluationSuite(options: {
  readonly id: string;
  readonly workflowId: string;
  readonly root: string;
  readonly checks: readonly CheckHandle[];
}): BuiltEvaluationSuite {
  if (
    typeof options.id !== "string" ||
    typeof options.workflowId !== "string" ||
    !ID_PATTERN.test(options.workflowId)
  )
    invalidSuite("Invalid evaluation suite/workflow ID.");
  if (!Array.isArray(options.checks) || options.checks.length === 0) {
    invalidSuite("An evaluation suite must contain at least one check.");
  }
  const checks = options.checks.map((handle) => {
    const definition = definitions.get(handle);
    if (!definition) invalidSuite("Checks must be created by defineCheck().");
    return definition;
  });
  try {
    const builder = defineWorkflow({ id: options.id, root: options.root });
    for (const check of checks) {
      const contracts = new Map<string, string>();
      for (const descriptor of Object.values(check.outputInputs)) {
        const previous = contracts.get(descriptor.pointer);
        if (previous !== undefined && previous !== descriptor.contract) {
          invalidSuite(
            `Check "${check.id}" has conflicting contracts for "${descriptor.pointer}".`,
          );
        }
        contracts.set(descriptor.pointer, descriptor.contract);
      }
      builder.stage({
        id: check.id,
        dependsOn: [],
        implementation: check.revision,
        watch: check.files,
        inputs: [...contracts.keys()],
        inputContracts: Object.fromEntries(contracts),
        env: [],
        cache: true,
        run: () => {
          throw new Error("Evaluation declarations cannot execute as stages.");
        },
      });
    }
    const validated = builder.build();
    const byId = new Map(checks.map((check) => [check.id, check]));
    const suite: BuiltEvaluationSuite = Object.freeze({
      contractVersion: "phase2-evaluation-v1",
      id: options.id,
      workflowId: options.workflowId,
      root: validated.root,
      checks: Object.freeze(
        validated.stages
          .map((stage) => {
            const check = byId.get(stage.id);
            if (!check) invalidSuite("Missing validated check.");
            const normalized = Object.freeze({
              ...check,
              files: Object.freeze([...new Set(stage.watchedPaths)].sort()),
            });
            const handle = options.checks.find((value) => value.id === check.id);
            if (!handle) invalidSuite("Missing check callback handle.");
            callbacks.set(normalized, callbacks.get(handle));
            return normalized;
          })
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      ),
    });
    suites.add(suite);
    return suite;
  } catch (error: unknown) {
    if (error instanceof EvaluationValidationError) throw error;
    invalidSuite(error instanceof Error ? error.message : "Unable to validate evaluation suite.");
  }
}

/** Validates and snapshots a strict callback result; no truthiness coercion. */
export function validateCheckResult(value: unknown): CheckResult {
  try {
    const clone: unknown = JSON.parse(canonicalizeJson(value));
    if (clone === null || typeof clone !== "object" || Array.isArray(clone))
      throw new Error("Expected a check result object.");
    const record = clone as { passed?: unknown; details?: unknown };
    if (
      Object.keys(record).sort().join(",") !== "details,passed" ||
      typeof record.passed !== "boolean" ||
      record.details === null ||
      typeof record.details !== "object" ||
      Array.isArray(record.details)
    ) {
      throw new Error("Expected exactly { passed: boolean, details: JSON object }.");
    }
    freezeJson(clone);
    return clone as CheckResult;
  } catch (error: unknown) {
    throw new EvaluationValidationError(
      "invalid_check_result",
      error instanceof Error ? error.message : "Invalid check result.",
    );
  }
}

export function freezeJson(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
}

export type CheckVerdict = "passed" | "failed" | null;
export type CheckComparison =
  | "improved"
  | "regressed"
  | "unchanged_pass"
  | "unchanged_fail"
  | "incomparable";

export function compareCheckVerdicts(
  baseline: CheckVerdict,
  candidate: CheckVerdict,
): CheckComparison {
  for (const verdict of [baseline, candidate]) {
    if (verdict !== null && verdict !== "passed" && verdict !== "failed") {
      throw new EvaluationValidationError("invalid_check_result", "Invalid check verdict.");
    }
  }
  if (baseline === null || candidate === null) return "incomparable";
  if (baseline === candidate) return baseline === "passed" ? "unchanged_pass" : "unchanged_fail";
  return candidate === "passed" ? "improved" : "regressed";
}

export function summarizeCheckVerdicts(
  pairs: readonly { readonly baseline: CheckVerdict; readonly candidate: CheckVerdict }[],
) {
  if (pairs.length === 0) invalidSuite("Cannot summarize an empty evaluation suite.");
  const summary = {
    baselinePassed: 0,
    baselineFailed: 0,
    baselineErrors: 0,
    candidatePassed: 0,
    candidateFailed: 0,
    candidateErrors: 0,
    improved: 0,
    regressed: 0,
    unchangedPass: 0,
    unchangedFail: 0,
    incomparable: 0,
  };
  for (const { baseline, candidate } of pairs) {
    const comparison = compareCheckVerdicts(baseline, candidate);
    summary[
      baseline === "passed"
        ? "baselinePassed"
        : baseline === "failed"
          ? "baselineFailed"
          : "baselineErrors"
    ]++;
    summary[
      candidate === "passed"
        ? "candidatePassed"
        : candidate === "failed"
          ? "candidateFailed"
          : "candidateErrors"
    ]++;
    summary[
      comparison === "unchanged_pass"
        ? "unchangedPass"
        : comparison === "unchanged_fail"
          ? "unchangedFail"
          : comparison
    ]++;
  }
  return Object.freeze({
    evaluationStatus:
      summary.candidateErrors > 0
        ? ("error" as const)
        : summary.candidateFailed > 0
          ? ("failed" as const)
          : ("passed" as const),
    comparisonStatus:
      summary.incomparable > 0
        ? ("error" as const)
        : summary.regressed > 0
          ? ("regressed" as const)
          : ("no_regressions" as const),
    summary: Object.freeze(summary),
  });
}
