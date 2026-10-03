import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CheckDeclaration,
  type CheckResult,
  createEvaluationSuite,
  defineCheck,
  defineWorkflow,
  executeEvaluationPair,
  type InputDescriptor,
  input,
  runWorkflow,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Evaluator = CheckDeclaration<{ count: InputDescriptor<number> }>["evaluate"];

async function fixture(candidateCount = 1) {
  const root = await mkdtemp(join(tmpdir(), "abilitybench evaluator "));
  roots.push(root);
  await writeFile(join(root, "workflow.ts"), "workflow-v1");
  await writeFile(join(root, "evaluation.ts"), "evaluation-v1");
  const stages = vi.fn();
  const builder = defineWorkflow({ id: "research", root });
  for (const [id, dependsOn] of [
    ["seed", []],
    ["left", ["seed"]],
    ["right", ["seed"]],
    ["report", ["left", "right"]],
  ] as const) {
    builder.stage({
      id,
      dependsOn: [...dependsOn],
      implementation: "v1",
      watch: ["workflow.ts"],
      inputs: ["/count"],
      env: [],
      cache: true,
      run: ({ inputs }) => {
        stages();
        return { count: inputs["/count"] ?? null };
      },
    });
  }
  const workflow = builder.build();
  const baseline = await runWorkflow(workflow, { baseline: null, inputs: { count: 2 } });
  const candidate = await runWorkflow(workflow, {
    baseline: { runId: baseline.manifest.id },
    inputs: { count: candidateCount },
  });
  stages.mockClear();
  const suite = (
    checks: readonly { id: string; evaluate: Evaluator; revision?: string; pointer?: string }[],
  ) =>
    createEvaluationSuite({
      id: "screening",
      workflowId: "research",
      root,
      checks: checks.map(({ id, evaluate, revision = "v1", pointer = "/count" }) =>
        defineCheck({
          id,
          targetStage: "report",
          outputInputs: { count: input.number(pointer) },
          revision,
          files: ["evaluation.ts"],
          evaluate,
        }),
      ),
    });
  return {
    root,
    suite,
    stages,
    options: {
      baselineRunId: baseline.manifest.id,
      candidateRunId: candidate.manifest.id,
      criteria: {},
    },
  };
}

const pass: Evaluator = ({ output }) => ({
  passed: output.count >= 2,
  details: { count: output.count },
});

async function snapshot(root: string) {
  const entries = await readdir(join(root, ".abilitybench"), {
    recursive: true,
    withFileTypes: true,
  });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => ({
        path: join(entry.parentPath, entry.name),
        bytes: await readFile(join(entry.parentPath, entry.name)),
      })),
  );
}

describe("sequential evaluation execution", () => {
  it("runs sorted checks baseline-first and detects a regression without storage writes", async () => {
    const { root, suite, options, stages } = await fixture();
    const calls: string[] = [];
    const make =
      (id: string): Evaluator =>
      async (context) => {
        calls.push(`${id}:${context.output.count}`);
        return pass(context);
      };
    const before = await snapshot(root);
    const result = await executeEvaluationPair(
      suite([
        { id: "zeta", evaluate: make("zeta") },
        { id: "alpha", evaluate: make("alpha") },
      ]),
      options,
    );
    expect(calls).toEqual(["alpha:2", "alpha:1", "zeta:2", "zeta:1"]);
    expect(result).toMatchObject({
      evaluationStatus: "failed",
      comparisonStatus: "regressed",
      summary: { regressed: 2, baselinePassed: 2, candidateFailed: 2 },
    });
    expect(result.checks[0]?.baseline).toMatchObject({
      invocationStatus: "completed",
      verdict: "passed",
      details: { count: 2 },
      error: null,
    });
    expect(result.checks[0]?.candidate.verdict).toBe("failed");
    expect(Object.isFrozen(result.checks[0]?.baseline.details)).toBe(true);
    expect(await snapshot(root)).toEqual(before);
    expect(stages).not.toHaveBeenCalled();
  });

  it("never reuses evaluator results even when source artifacts and fingerprints match", async () => {
    const { suite, options } = await fixture(2);
    const evaluate = vi.fn(pass);
    const sealed = suite([{ id: "check", evaluate }]);
    const first = await executeEvaluationPair(sealed, options);
    const second = await executeEvaluationPair(sealed, options);
    expect(evaluate).toHaveBeenCalledTimes(4);
    expect(first.checks[0]?.baseline.fingerprint).toBe(first.checks[0]?.candidate.fingerprint);
    expect(first.checks[0]?.baseline.fingerprint).toBe(second.checks[0]?.baseline.fingerprint);
    expect(first).toMatchObject({ evaluationStatus: "passed", comparisonStatus: "no_regressions" });
    const contexts = evaluate.mock.calls.map(([context]) => context);
    expect(contexts[0]?.output).not.toBe(contexts[1]?.output);
    expect(contexts[0]?.criteria).not.toBe(contexts[1]?.criteria);
    expect(Object.keys(contexts[0] ?? {})).toEqual(["output", "criteria"]);
  });

  it("continues the candidate and other checks after a baseline exception", async () => {
    const { suite, options } = await fixture();
    const broken = vi.fn<Evaluator>(({ output }) => {
      if (output.count === 2) throw new Error("Baseline assertion could not run.");
      return { passed: true, details: {} };
    });
    const healthy = vi.fn<Evaluator>(() => ({ passed: true, details: {} }));
    const result = await executeEvaluationPair(
      suite([
        { id: "broken", evaluate: broken },
        { id: "healthy", evaluate: healthy },
      ]),
      options,
    );
    expect(broken).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      evaluationStatus: "passed",
      comparisonStatus: "error",
      summary: { incomparable: 1, unchangedPass: 1 },
    });
    expect(result.checks[0]?.baseline).toMatchObject({
      verdict: null,
      invocationStatus: "error",
      details: {},
      error: { code: "check_threw", name: "Error", message: "Baseline assertion could not run." },
    });
    expect(Object.keys(result.checks[0]?.baseline.error ?? {})).toEqual([
      "code",
      "name",
      "message",
    ]);
  });

  it("separates invalid returns from thrown/rejected callbacks", async () => {
    const { suite, options } = await fixture();
    const result = await executeEvaluationPair(
      suite([
        {
          id: "invalid",
          evaluate: () => ({ passed: "yes", details: {} }) as unknown as CheckResult,
        },
        {
          id: "rejected",
          evaluate: async () => {
            throw "Rejected check";
          },
        },
      ]),
      options,
    );
    expect(result.checks[0]?.baseline.error?.code).toBe("invalid_check_result");
    expect(result.checks[1]?.candidate.error).toMatchObject({
      code: "check_threw",
      message: "Rejected check",
    });
    expect(result).toMatchObject({
      evaluationStatus: "error",
      comparisonStatus: "error",
      summary: { baselineErrors: 2, candidateErrors: 2, incomparable: 2 },
    });
  });

  it("does not invoke callbacks for invalid selections but still fingerprints and continues", async () => {
    const { suite, options } = await fixture();
    const missing = vi.fn(pass);
    const healthy = vi.fn(pass);
    const result = await executeEvaluationPair(
      suite([
        { id: "missing", pointer: "/absent", evaluate: missing },
        { id: "healthy", evaluate: healthy },
      ]),
      options,
    );
    expect(missing).not.toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(result.checks[1]?.baseline.error?.code).toBe("output_contract_failed");
    expect(result.checks[1]?.baseline.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("isolates frozen criteria and outputs across attempted callback mutations", async () => {
    const { suite, options } = await fixture();
    const mutation: Evaluator = ({ output, criteria }) => {
      Object.assign(output, { count: 99 });
      Object.assign(criteria, { min: 99 });
      return { passed: true, details: {} };
    };
    const observed = vi.fn<Evaluator>(({ output, criteria }) => {
      expect(output.count).toBeLessThan(3);
      expect(criteria).toEqual({ min: 1 });
      return { passed: true, details: {} };
    });
    const result = await executeEvaluationPair(
      suite([
        { id: "mutation", evaluate: mutation },
        { id: "observed", evaluate: observed },
      ]),
      { ...options, criteria: { min: 1 } },
    );
    expect(result.checks[0]?.baseline.error?.code).toBe("check_threw");
    expect(result.checks[1]?.comparison).toBe("unchanged_pass");
    expect(observed).toHaveBeenCalledTimes(2);
  });

  it("rejects changed watched inputs even when the callback itself throws", async () => {
    const { root, suite, options } = await fixture();
    const evaluate = vi.fn<Evaluator>(async () => {
      await writeFile(join(root, "evaluation.ts"), "evaluation-v2");
      throw new Error("Ordinary error must not conceal changed implementation.");
    });
    await expect(
      executeEvaluationPair(suite([{ id: "check", evaluate }]), options),
    ).rejects.toMatchObject({ code: "evaluation_inputs_changed" });
    expect(evaluate).toHaveBeenCalledTimes(1);
    await expect(readdir(join(root, ".abilitybench", "evaluations"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects watched files that become invalid during a callback", async () => {
    const { root, suite, options } = await fixture();
    const evaluate: Evaluator = async () => {
      await rm(join(root, "evaluation.ts"));
      return { passed: true, details: {} };
    };
    await expect(
      executeEvaluationPair(suite([{ id: "check", evaluate }]), options),
    ).rejects.toMatchObject({ code: "evaluation_inputs_changed" });
  });

  it("changes fingerprints for declared criteria and revisions, not run IDs or root paths", async () => {
    const a = await fixture();
    const b = await fixture();
    const one = await executeEvaluationPair(a.suite([{ id: "check", evaluate: pass }]), a.options);
    const two = await executeEvaluationPair(b.suite([{ id: "check", evaluate: pass }]), b.options);
    expect(a.options.baselineRunId).toBe(one.baseline.runId);
    expect(one.checks[0]?.baseline.fingerprint).toBe(two.checks[0]?.baseline.fingerprint);
    const criteria = await executeEvaluationPair(a.suite([{ id: "check", evaluate: pass }]), {
      ...a.options,
      criteria: { min: 2 },
    });
    const revision = await executeEvaluationPair(
      a.suite([{ id: "check", revision: "v2", evaluate: pass }]),
      a.options,
    );
    expect(criteria.checks[0]?.baseline.fingerprint).not.toBe(one.checks[0]?.baseline.fingerprint);
    expect(revision.checks[0]?.baseline.fingerprint).not.toBe(one.checks[0]?.baseline.fingerprint);
  });

  it("uses canonical criteria key order and freshly fingerprints changed implementation bytes", async () => {
    const { root, suite, options } = await fixture();
    const sealed = suite([{ id: "check", evaluate: pass }]);
    const first = await executeEvaluationPair(sealed, { ...options, criteria: { min: 1, max: 9 } });
    const reordered = await executeEvaluationPair(sealed, {
      ...options,
      criteria: { max: 9, min: 1 },
    });
    expect(first.checks[0]?.baseline.fingerprint).toBe(reordered.checks[0]?.baseline.fingerprint);
    await writeFile(join(root, "evaluation.ts"), "evaluation-v2");
    const changed = await executeEvaluationPair(sealed, options);
    const originalCriteria = await executeEvaluationPair(sealed, {
      ...options,
      criteria: { min: 1, max: 9 },
    });
    expect(originalCriteria.checks[0]?.baseline.fingerprint).not.toBe(
      first.checks[0]?.baseline.fingerprint,
    );
    expect(changed.suiteHash).not.toBe(first.suiteHash);
  });

  it("handles hostile thrown Error accessors without breaking continuation", async () => {
    const { suite, options } = await fixture();
    const evaluate: Evaluator = () => {
      const error = new Error("bad");
      Object.defineProperty(error, "message", {
        get: () => {
          throw new Error("getter");
        },
      });
      throw error;
    };
    const result = await executeEvaluationPair(suite([{ id: "check", evaluate }]), options);
    expect(result.checks[0]?.candidate.error).toMatchObject({
      code: "check_threw",
      name: "Error",
      message: "Evaluator threw a non-Error value.",
    });
  });
});
