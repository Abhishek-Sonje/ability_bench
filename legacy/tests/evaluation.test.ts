import { resolve } from "node:path";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  type CheckDeclaration,
  type CheckVerdict,
  compareCheckVerdicts,
  createEvaluationSuite,
  defineCheck,
  input,
  summarizeCheckVerdicts,
  validateCheckResult,
} from "../src/index.js";

function check(id = "nonempty") {
  return defineCheck({
    id,
    targetStage: "report",
    outputInputs: {},
    revision: "v1",
    files: ["./evaluation.ts"],
    evaluate: () => ({ passed: true, details: {} }),
  });
}

const suite = (checks = [check()]) =>
  createEvaluationSuite({ id: "screening", workflowId: "research", root: process.cwd(), checks });

describe("evaluation declarations", () => {
  it("infers selected artifact fields without exposing execution context or invoking callbacks", () => {
    const evaluate = vi.fn();
    const handle = defineCheck({
      id: "nonempty",
      targetStage: "report",
      revision: "v1",
      files: ["evaluation.ts"],
      outputInputs: {
        candidates: input.stringArray("/candidates"),
        note: input.optional(input.string("/note")),
      },
      evaluate: ({ output, criteria }) => {
        expectTypeOf(output.candidates).toEqualTypeOf<string[]>();
        expectTypeOf(output.note).toEqualTypeOf<string | undefined>();
        // @ts-expect-error Checks do not receive unrestricted execution outputs.
        output.registry;
        evaluate(criteria);
        return { passed: output.candidates.length > 0, details: {} };
      },
    });
    const sealed = suite([handle]);
    expect(evaluate).not.toHaveBeenCalled();
    expect(sealed.root).toBe(resolve(process.cwd()));
    expect(sealed.contractVersion).toBe("phase2-evaluation-v1");
    const { candidates } = sealed.checks[0]?.outputInputs ?? {};
    expect(candidates).toMatchObject({
      pointer: "/candidates",
      contract: "required-string-array-v1",
    });
    expect(Object.isFrozen(sealed.checks)).toBe(true);
    expect(Object.isFrozen(sealed.checks[0]?.outputInputs)).toBe(true);
  });

  it("sorts checks and normalizes files independently of declaration order", () => {
    const first = suite([check("zeta"), check("alpha")]);
    const second = suite([check("alpha"), check("zeta")]);
    expect(first).toEqual(second);
    expect(first.checks.map(({ id }) => id)).toEqual(["alpha", "zeta"]);
    expect(first.checks[0]?.files).toEqual(["evaluation.ts"]);
  });

  it("snapshots declaration metadata and canonicalizes aliased files", () => {
    const files: [string, ...string[]] = ["z.ts", "./evaluation.ts", "evaluation.ts"];
    const outputInputs = { count: input.number("/count") };
    const handle = defineCheck({
      id: "check",
      targetStage: "report",
      outputInputs,
      revision: "v1",
      files,
      evaluate: () => ({ passed: true, details: {} }),
    });
    files[0] = "mutated.ts";
    outputInputs.count = input.number("/different");
    const sealed = suite([handle]);
    expect(sealed.checks[0]?.files).toEqual(["evaluation.ts", "z.ts"]);
    const { count } = sealed.checks[0]?.outputInputs ?? {};
    expect(count?.pointer).toBe("/count");
    expect(Object.isFrozen(sealed.checks[0]?.files)).toBe(true);
  });

  it("rejects alias accessors without invoking them", () => {
    const getter = vi.fn(() => input.string("/x"));
    const outputInputs = {};
    Object.defineProperty(outputInputs, "field", { enumerable: true, get: getter });
    expect(() =>
      defineCheck({
        id: "check",
        targetStage: "report",
        outputInputs,
        revision: "v1",
        files: ["evaluation.ts"],
        evaluate: () => ({ passed: true, details: {} }),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_suite" }));
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects empty, duplicate, forged, and invalid suite declarations", () => {
    for (const checks of [[], [check(), check()], [{ id: "forged" }]]) {
      expect(() => suite(checks)).toThrowError(expect.objectContaining({ code: "invalid_suite" }));
    }
    expect(() =>
      createEvaluationSuite({
        id: "Bad ID",
        workflowId: "research",
        root: process.cwd(),
        checks: [check()],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_suite" }));
  });

  it.each([
    { revision: "" },
    { files: [] },
    { targetStage: "Bad ID" },
    { id: undefined },
    { outputInputs: { field: { pointer: "/x", contract: "custom" } } },
  ])("rejects malformed check metadata %j", (override) => {
    const declaration = {
      id: "check",
      targetStage: "report",
      outputInputs: {},
      revision: "v1",
      files: ["evaluation.ts"],
      evaluate: () => ({ passed: true, details: {} }),
      ...override,
    };
    expect(() =>
      defineCheck(declaration as unknown as CheckDeclaration<Record<string, never>>),
    ).toThrowError(expect.objectContaining({ code: "invalid_suite" }));
  });

  it("rejects escaped/duplicate watched files and invalid/conflicting selectors at sealing", () => {
    for (const files of [["../outside.ts"], ["evaluation.ts", "evaluation.ts"]]) {
      const handle = defineCheck({
        id: "check",
        targetStage: "report",
        outputInputs: {},
        revision: "v1",
        files: files as [string, ...string[]],
        evaluate: () => ({ passed: true, details: {} }),
      });
      expect(() => suite([handle])).toThrowError(
        expect.objectContaining({ code: "invalid_suite" }),
      );
    }
    for (const outputInputs of [
      { a: input.string("not-a-pointer") },
      { a: input.string("/x"), b: input.number("/x") },
    ]) {
      const handle = defineCheck({
        id: "check",
        targetStage: "report",
        outputInputs,
        revision: "v1",
        files: ["evaluation.ts"],
        evaluate: () => ({ passed: true, details: {} }),
      });
      expect(() => suite([handle])).toThrowError(
        expect.objectContaining({ code: "invalid_suite" }),
      );
    }
  });
});

describe("strict evaluation results", () => {
  it("snapshots and deeply freezes valid nested JSON details", () => {
    const original = { passed: false, details: { nested: { count: 2 } } };
    const parsed = validateCheckResult(original);
    original.details.nested.count = 99;
    expect(parsed.details).toEqual({ nested: { count: 2 } });
    const { nested } = parsed.details;
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it.each([
    undefined,
    null,
    [],
    { passed: "true", details: {} },
    { passed: 1, details: {} },
    { passed: true },
    { passed: true, details: [] },
    { passed: true, details: {}, extra: 1 },
    { passed: true, details: { value: NaN } },
    { passed: true, details: { value: new Date() } },
  ])("rejects invalid results without coercion: %j", (value) => {
    expect(() => validateCheckResult(value)).toThrowError(
      expect.objectContaining({ code: "invalid_check_result" }),
    );
  });
  it("rejects shared references and accessors without invoking them", () => {
    const shared = {};
    expect(() =>
      validateCheckResult({ passed: true, details: { a: shared, b: shared } }),
    ).toThrow();
    const getter = vi.fn(() => true);
    const value = { details: {} };
    Object.defineProperty(value, "passed", { enumerable: true, get: getter });
    expect(() => validateCheckResult(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("pure evaluation comparisons", () => {
  it.each([
    ["passed", "passed", "unchanged_pass"],
    ["failed", "passed", "improved"],
    ["passed", "failed", "regressed"],
    ["failed", "failed", "unchanged_fail"],
    [null, "passed", "incomparable"],
    ["passed", null, "incomparable"],
    [null, null, "incomparable"],
  ] as const)("compares %s -> %s as %s", (baseline, candidate, comparison) => {
    expect(compareCheckVerdicts(baseline, candidate)).toBe(comparison);
  });
  it("does not confuse no regressions with absolute passing", () => {
    expect(summarizeCheckVerdicts([{ baseline: "failed", candidate: "failed" }])).toMatchObject({
      evaluationStatus: "failed",
      comparisonStatus: "no_regressions",
      summary: { unchangedFail: 1 },
    });
  });
  it("keeps candidate success separate from baseline errors", () => {
    expect(summarizeCheckVerdicts([{ baseline: null, candidate: "passed" }])).toMatchObject({
      evaluationStatus: "passed",
      comparisonStatus: "error",
      summary: { baselineErrors: 1, candidatePassed: 1, incomparable: 1 },
    });
  });
  it("preserves regressions and other counts even when errors take precedence", () => {
    const result = summarizeCheckVerdicts([
      { baseline: "passed", candidate: "failed" },
      { baseline: "failed", candidate: "passed" },
      { baseline: "passed", candidate: "passed" },
      { baseline: "failed", candidate: "failed" },
      { baseline: "passed", candidate: null },
    ]);
    expect(result).toEqual({
      evaluationStatus: "error",
      comparisonStatus: "error",
      summary: {
        baselinePassed: 3,
        baselineFailed: 2,
        baselineErrors: 0,
        candidatePassed: 2,
        candidateFailed: 2,
        candidateErrors: 1,
        improved: 1,
        regressed: 1,
        unchangedPass: 1,
        unchangedFail: 1,
        incomparable: 1,
      },
    });
    expect(Object.isFrozen(result.summary)).toBe(true);
  });
  it("rejects empty comparisons and malformed verdicts", () => {
    expect(() => summarizeCheckVerdicts([])).toThrowError(
      expect.objectContaining({ code: "invalid_suite" }),
    );
    expect(() => compareCheckVerdicts("error" as CheckVerdict, "passed")).toThrowError(
      expect.objectContaining({ code: "invalid_check_result" }),
    );
  });
});
