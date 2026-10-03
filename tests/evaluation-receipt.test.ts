import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeJson,
  createEvaluationSuite,
  defineCheck,
  defineWorkflow,
  type EvaluationReceipt,
  evaluateRunPair,
  FileEvaluationReceiptStore,
  input,
  runWorkflow,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench receipt "));
  roots.push(root);
  await writeFile(join(root, "workflow.ts"), "workflow-v1");
  await writeFile(join(root, "evaluation.ts"), "evaluation-v1");
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
      run: ({ inputs }) => ({ count: inputs["/count"] ?? 0 }),
    });
  }
  const workflow = builder.build();
  const baseline = await runWorkflow(workflow, { baseline: null, inputs: { count: 2 } });
  const candidate = await runWorkflow(workflow, {
    baseline: { runId: baseline.manifest.id },
    inputs: { count: 1 },
  });
  const evaluate = vi.fn(({ output }: { output: { count: number } }) => ({
    passed: output.count >= 2,
    details: { count: output.count },
  }));
  const suite = createEvaluationSuite({
    id: "screening",
    workflowId: "research",
    root,
    checks: [
      defineCheck({
        id: "nonempty",
        targetStage: "report",
        outputInputs: { count: input.number("/count") },
        revision: "v1",
        files: ["evaluation.ts"],
        evaluate,
      }),
    ],
  });
  const storage = join(root, ".abilitybench");
  return {
    root,
    baseline,
    candidate,
    evaluate,
    suite,
    storage,
    store: new FileEvaluationReceiptStore(storage),
    options: {
      baselineRunId: baseline.manifest.id,
      candidateRunId: candidate.manifest.id,
      criteria: {},
    },
  };
}

function resign(receipt: EvaluationReceipt): EvaluationReceipt {
  const { id: _id, receiptHash: _hash, ...body } = receipt;
  const digest = createHash("sha256")
    .update("abilitybench/evaluation-receipt/v1\0")
    .update(canonicalizeJson(body))
    .digest("hex");
  return { ...body, id: `eval_${digest}`, receiptHash: `sha256:${digest}` };
}

describe("immutable evaluation receipts", () => {
  it("publishes and verifies exact receipts without rewriting execution manifests", async () => {
    const { suite, options, store, storage, baseline, candidate, evaluate } = await fixture();
    const sourcePaths = [baseline.manifest.id, candidate.manifest.id].map((id) =>
      join(storage, "runs", `${id}.json`),
    );
    const before = await Promise.all(sourcePaths.map((path) => readFile(path)));
    const receipt = await evaluateRunPair(suite, options);
    expect(receipt.id).toMatch(/^eval_[a-f0-9]{64}$/);
    expect(receipt).toMatchObject({
      schemaVersion: "phase2-evaluation-receipt-v1",
      evaluationStatus: "failed",
      comparisonStatus: "regressed",
      runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch },
    });
    expect(await store.get(receipt.id)).toEqual(receipt);
    await store.put(receipt);
    expect(await readdir(join(storage, "evaluations"))).toEqual([`${receipt.id}.json`]);
    expect(await Promise.all(sourcePaths.map((path) => readFile(path)))).toEqual(before);
    expect(baseline.manifest.evaluationStatus).toBe("not_run");
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("looks up historical evaluation after current implementation changes without callbacks", async () => {
    const { root, suite, options, store, evaluate } = await fixture();
    const receipt = await evaluateRunPair(suite, options);
    await writeFile(join(root, "evaluation.ts"), "completely different evaluator");
    await rm(join(root, "evaluation.ts"));
    evaluate.mockClear();
    const loaded = await store.get(receipt.id);
    expect(loaded).toEqual(receipt);
    expect(Object.isFrozen(loaded?.checks[0]?.baseline.details)).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("rejects altered summaries even when a caller recomputes the receipt identity", async () => {
    const { suite, options, store } = await fixture();
    const receipt = await evaluateRunPair(suite, options);
    const altered = resign({ ...receipt, summary: { ...receipt.summary, regressed: 99 } });
    await expect(store.put(altered)).rejects.toMatchObject({ code: "corrupt_receipt" });
  });

  it("persists and verifies output-contract errors without invoking historical callbacks", async () => {
    const { root, options, store } = await fixture();
    const evaluate = vi.fn(() => ({ passed: true, details: {} }));
    const suite = createEvaluationSuite({
      id: "screening",
      workflowId: "research",
      root,
      checks: [
        defineCheck({
          id: "check",
          targetStage: "report",
          outputInputs: { label: input.string("/count") },
          revision: "v1",
          files: ["evaluation.ts"],
          evaluate,
        }),
      ],
    });
    const receipt = await evaluateRunPair(suite, options);
    expect(receipt).toMatchObject({ evaluationStatus: "error", comparisonStatus: "error" });
    expect(receipt.checks[0]?.baseline.error?.code).toBe("output_contract_failed");
    expect(await store.get(receipt.id)).toEqual(receipt);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("records ordinary check errors as diagnostics, not failed assertions", async () => {
    const { root, options, store } = await fixture();
    const suite = createEvaluationSuite({
      id: "screening",
      workflowId: "research",
      root,
      checks: [
        defineCheck({
          id: "check",
          targetStage: "report",
          outputInputs: {},
          revision: "v1",
          files: ["evaluation.ts"],
          evaluate: () => {
            throw new Error("Intentional evaluator error.");
          },
        }),
      ],
    });
    const receipt = await evaluateRunPair(suite, options);
    expect(receipt.checks[0]?.baseline.verdict).toBeNull();
    expect(receipt.checks[0]?.candidate.error?.code).toBe("check_threw");
    expect(await store.get(receipt.id)).toEqual(receipt);
  });

  it("evaluates again rather than treating an existing receipt as a cache", async () => {
    const { suite, options, evaluate } = await fixture();
    const first = await evaluateRunPair(suite, options);
    const second = await evaluateRunPair(suite, options);
    expect(evaluate).toHaveBeenCalledTimes(4);
    expect(first.checks[0]?.baseline.fingerprint).toBe(second.checks[0]?.baseline.fingerprint);
  });

  it("recomputes artifact-dependent fingerprints rather than trusting stored digests", async () => {
    const { suite, options, store } = await fixture();
    const receipt = await evaluateRunPair(suite, options);
    const pair = receipt.checks[0];
    if (!pair) throw new Error("Missing fixture check.");
    const altered = resign({
      ...receipt,
      checks: [
        { ...pair, baseline: { ...pair.baseline, fingerprint: `sha256:${"0".repeat(64)}` } },
      ],
    });
    await expect(store.put(altered)).rejects.toMatchObject({ code: "corrupt_receipt" });
  });

  it("fails verified lookup when referenced criteria or source outputs are missing/corrupt", async () => {
    const { suite, options, store, storage } = await fixture();
    const receipt = await evaluateRunPair(suite, options);
    const criteriaPath = join(storage, "objects", "sha256", receipt.criteriaArtifactHash.slice(7));
    const criteriaBytes = await readFile(criteriaPath);
    await rm(criteriaPath);
    await expect(store.get(receipt.id)).rejects.toMatchObject({ code: "read_failed" });
    await writeFile(criteriaPath, criteriaBytes);
    const source = receipt.checks[0]?.candidate.sourceArtifactHash;
    if (!source) throw new Error("Missing fixture artifact.");
    await writeFile(join(storage, "objects", "sha256", source.slice(7)), "{}");
    await expect(store.get(receipt.id)).rejects.toMatchObject({ code: "corrupt_artifact" });
  });

  it("rejects noncanonical bytes and unknown fields", async () => {
    const { suite, options, store, storage } = await fixture();
    const receipt = await evaluateRunPair(suite, options);
    const path = join(storage, "evaluations", `${receipt.id}.json`);
    await writeFile(path, JSON.stringify(receipt, null, 2));
    await expect(store.get(receipt.id)).rejects.toMatchObject({ code: "corrupt_receipt" });
    await writeFile(path, canonicalizeJson({ ...receipt, extra: true }));
    await expect(store.get(receipt.id)).rejects.toMatchObject({ code: "corrupt_receipt" });
  });

  it("never overwrites an immutable receipt collision and cleans publication temp files", async () => {
    const { suite, options, store, storage } = await fixture();
    const receipt = await evaluateRunPair(suite, options);
    const path = join(storage, "evaluations", `${receipt.id}.json`);
    await writeFile(path, "different existing bytes");
    await expect(store.put(receipt)).rejects.toMatchObject({ code: "content_collision" });
    expect(await readFile(path, "utf8")).toBe("different existing bytes");
    expect(
      (await readdir(join(storage, "evaluations"))).filter((name) => name.startsWith(".tmp-")),
    ).toEqual([]);
  });

  it("rejects invalid IDs and unavailable run references", async () => {
    const { suite, options, store, storage, baseline } = await fixture();
    const receipt = await evaluateRunPair(suite, options);
    await expect(store.get("../../outside")).rejects.toMatchObject({
      code: "invalid_evaluation_id",
    });
    expect(await store.get(`eval_${"0".repeat(64)}`)).toBeUndefined();
    await rm(join(storage, "runs", `${baseline.manifest.id}.json`));
    await expect(store.get(receipt.id)).rejects.toMatchObject({ code: "read_failed" });
  });

  it("does not publish receipts when implementation inputs change during evaluation", async () => {
    const { root, options, storage } = await fixture();
    const suite = createEvaluationSuite({
      id: "screening",
      workflowId: "research",
      root,
      checks: [
        defineCheck({
          id: "check",
          targetStage: "report",
          outputInputs: {},
          revision: "v1",
          files: ["evaluation.ts"],
          evaluate: async () => {
            await writeFile(join(root, "evaluation.ts"), "changed");
            return { passed: true, details: {} };
          },
        }),
      ],
    });
    await expect(evaluateRunPair(suite, options)).rejects.toMatchObject({
      code: "evaluation_inputs_changed",
    });
    await expect(readdir(join(storage, "evaluations"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects evaluation directories redirected outside storage", async () => {
    const { suite, options, store, storage } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "abilitybench eval outside "));
    roots.push(outside);
    await symlink(
      outside,
      join(storage, "evaluations"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(evaluateRunPair(suite, options)).rejects.toThrow("resolves outside");
    await expect(store.get(`eval_${"0".repeat(64)}`)).rejects.toThrow("resolves outside");
    expect(await readdir(outside)).toEqual([]);
  });

  it("does not expose a partial receipt when publication fails", async () => {
    const { suite, options, store, storage } = await fixture();
    const receipt = await evaluateRunPair(suite, options);
    const path = join(storage, "evaluations", `${receipt.id}.json`);
    await rm(path);
    await mkdir(path);
    await expect(store.put(receipt)).rejects.toMatchObject({ code: "write_failed" });
    expect(
      (await readdir(join(storage, "evaluations"))).filter((name) => name.startsWith(".tmp-")),
    ).toEqual([]);
  });

  it("rejects before publication when the final stability guard fails", async () => {
    const { suite, options, store, storage } = await fixture();
    const receipt = await evaluateRunPair(suite, options);
    await rm(join(storage, "evaluations", `${receipt.id}.json`));
    await expect(
      store.put(receipt, async () => {
        throw new Error("stability guard failed");
      }),
    ).rejects.toThrow("stability guard failed");
    expect(await readdir(join(storage, "evaluations"))).toEqual([]);
  });
});
