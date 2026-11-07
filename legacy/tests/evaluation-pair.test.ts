import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BuiltEvaluationSuite,
  createEvaluationSuite,
  defineCheck,
  defineWorkflow,
  input,
  prepareEvaluationPair,
  runWorkflow,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench eval pair "));
  roots.push(root);
  await writeFile(join(root, "workflow.ts"), "workflow-v1");
  await writeFile(join(root, "evaluation.ts"), "evaluation-v1");
  const builder = defineWorkflow({ id: "research", root });
  for (const [id, dependencies] of [
    ["seed", []],
    ["left", ["seed"]],
    ["right", ["seed"]],
    ["join", ["left", "right"]],
    ["report", ["join"]],
  ] as const) {
    builder.stage({
      id,
      dependsOn: [...dependencies],
      implementation: "v1",
      watch: ["workflow.ts"],
      inputs: ["/candidates", "/fail"],
      env: [],
      cache: true,
      run: ({ inputs }) => {
        if (id === "report" && inputs["/fail"] === true) throw new Error("Intentional failure.");
        return { candidates: inputs["/candidates"] ?? [], nested: { count: 1 } };
      },
    });
  }
  const workflow = builder.build();
  const baseline = await runWorkflow(workflow, {
    baseline: null,
    inputs: { candidates: ["one", "two"], fail: false },
  });
  const candidate = await runWorkflow(workflow, {
    baseline: { runId: baseline.manifest.id },
    inputs: { candidates: ["one"], fail: false },
  });
  const evaluate = vi.fn(() => ({ passed: true, details: {} }));
  const makeSuite = (
    targetStage = "report",
    outputInputs = { candidates: input.stringArray("/candidates") },
    files: [string, ...string[]] = ["evaluation.ts"],
  ) =>
    createEvaluationSuite({
      id: "screening",
      workflowId: "research",
      root,
      checks: [
        defineCheck({ id: "nonempty", targetStage, outputInputs, revision: "v1", files, evaluate }),
      ],
    });
  const options = {
    baselineRunId: baseline.manifest.id,
    candidateRunId: candidate.manifest.id,
    criteria: {},
  };
  return { root, workflow, baseline, candidate, makeSuite, options, evaluate };
}

async function storageSnapshot(root: string) {
  const directory = join(root, ".abilitybench");
  const paths = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  return Promise.all(paths.map(async (path) => ({ path, bytes: await readFile(path) })));
}

describe("read-only evaluation pair preparation", () => {
  it("isolates both sides even when execution reused the same artifact", async () => {
    const { workflow, baseline, makeSuite, options } = await fixture();
    const unchanged = await runWorkflow(workflow, {
      baseline: { runId: baseline.manifest.id },
      inputs: { candidates: ["one", "two"], fail: false },
    });
    const prepared = await prepareEvaluationPair(makeSuite(), {
      ...options,
      candidateRunId: unchanged.manifest.id,
    });
    const check = prepared.checks[0];
    expect(check?.baseline.sourceArtifactHash).toBe(check?.candidate.sourceArtifactHash);
    const baselineOutput = check?.baseline.output;
    const candidateOutput = check?.candidate.output;
    expect(baselineOutput).toEqual(candidateOutput);
    expect(baselineOutput).not.toBe(candidateOutput);
    const { candidates: baselineCandidates } = baselineOutput ?? {};
    const { candidates: candidateCandidates } = candidateOutput ?? {};
    expect(baselineCandidates).not.toBe(candidateCandidates);
    expect(Object.isFrozen(baselineCandidates)).toBe(true);
  });
  it("verifies direct lineage and typed selections without callbacks or storage changes", async () => {
    const { root, makeSuite, options, evaluate, baseline } = await fixture();
    const before = await storageSnapshot(root);
    const prepared = await prepareEvaluationPair(makeSuite(), options);
    expect(prepared.baseline.id).toBe(baseline.manifest.id);
    expect(prepared.candidate.baselineRunId).toBe(prepared.baseline.id);
    expect(prepared.checks[0]?.baseline.output).toEqual({ candidates: ["one", "two"] });
    expect(prepared.checks[0]?.candidate.output).toEqual({ candidates: ["one"] });
    expect(prepared.checks[0]?.baseline.error).toBeNull();
    expect(prepared.suiteHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(prepared.criteriaArtifactHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(evaluate).not.toHaveBeenCalled();
    expect(await storageSnapshot(root)).toEqual(before);
  });

  it("snapshots mutable options and criteria before asynchronous reads", async () => {
    const { makeSuite, options, baseline } = await fixture();
    const criteria = { nested: { minimum: 1 } };
    const mutableOptions = { ...options, criteria };
    const pending = prepareEvaluationPair(makeSuite(), mutableOptions);
    mutableOptions.baselineRunId = "invalid";
    criteria.nested.minimum = 99;
    const prepared = await pending;
    expect(prepared.baseline.id).toBe(baseline.manifest.id);
    expect(prepared.criteria).toEqual({ nested: { minimum: 1 } });
    const { nested } = prepared.criteria;
    expect(Object.isFrozen(nested)).toBe(true);
  });

  it("isolates overlapping aliases, both sides, and optional selections", async () => {
    const { root, options, evaluate } = await fixture();
    const suite = createEvaluationSuite({
      id: "screening",
      workflowId: "research",
      root,
      checks: [
        defineCheck({
          id: "check",
          targetStage: "report",
          revision: "v1",
          files: ["evaluation.ts"],
          outputInputs: {
            entire: input.json(""),
            nested: input.json("/nested"),
            optional: input.optional(input.string("/absent")),
          },
          evaluate,
        }),
      ],
    });
    const prepared = await prepareEvaluationPair(suite, options);
    const side = prepared.checks[0]?.baseline;
    expect(side?.output).toMatchObject({
      entire: { nested: { count: 1 } },
      nested: { count: 1 },
      optional: undefined,
    });
    const { entire, nested } = side?.output ?? {};
    expect((entire as { nested: unknown }).nested).not.toBe(nested);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(side?.output).not.toBe(prepared.checks[0]?.candidate.output);
    expect(side?.selectedInputs).toMatchObject({
      optional: { state: "missing" },
      nested: { state: "present", value: { count: 1 } },
    });
  });

  it("records output contract failures without rejecting the verified pair", async () => {
    const { makeSuite, options, evaluate } = await fixture();
    const prepared = await prepareEvaluationPair(
      makeSuite("report", { candidates: input.stringArray("/absent") }),
      options,
    );
    expect(prepared.checks[0]?.baseline).toMatchObject({
      output: null,
      error: { code: "output_contract_failed", name: "InputValidationError" },
    });
    expect(prepared.checks[0]?.candidate.error?.code).toBe("output_contract_failed");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("changes identity for criteria and evaluator files but not absolute roots", async () => {
    const first = await fixture();
    const second = await fixture();
    const a = await prepareEvaluationPair(first.makeSuite(), first.options);
    const b = await prepareEvaluationPair(second.makeSuite(), second.options);
    expect(a.suiteHash).toBe(b.suiteHash);
    const criteriaChanged = await prepareEvaluationPair(first.makeSuite(), {
      ...first.options,
      criteria: { minimum: 2 },
    });
    expect(criteriaChanged.suiteHash).toBe(a.suiteHash);
    expect(criteriaChanged.criteriaArtifactHash).not.toBe(a.criteriaArtifactHash);
    await writeFile(join(first.root, "evaluation.ts"), "evaluation-v2");
    const fileChanged = await prepareEvaluationPair(first.makeSuite(), first.options);
    expect(fileChanged.suiteHash).not.toBe(a.suiteHash);
  });

  it("rejects self-pairs, unrelated baselines, missing runs, and unavailable targets", async () => {
    const { workflow, baseline, makeSuite, options } = await fixture();
    await expect(
      prepareEvaluationPair(makeSuite(), { ...options, candidateRunId: baseline.manifest.id }),
    ).rejects.toMatchObject({ code: "run_pair_same_run" });
    await expect(
      prepareEvaluationPair(makeSuite(), { ...options, candidateRunId: `run_${"0".repeat(64)}` }),
    ).rejects.toMatchObject({ code: "run_not_found" });
    const unrelated = await runWorkflow(workflow, {
      baseline: null,
      inputs: { candidates: [], fail: false },
    });
    await expect(
      prepareEvaluationPair(makeSuite(), { ...options, candidateRunId: unrelated.manifest.id }),
    ).rejects.toMatchObject({ code: "run_pair_lineage_mismatch" });
    await expect(prepareEvaluationPair(makeSuite("missing"), options)).rejects.toMatchObject({
      code: "target_stage_unavailable",
    });
  });

  it("rejects failed execution and workflow mismatch", async () => {
    const { root, workflow, baseline, options, makeSuite } = await fixture();
    const failed = await runWorkflow(workflow, {
      baseline: { runId: baseline.manifest.id },
      inputs: { candidates: [], fail: true },
    });
    await expect(
      prepareEvaluationPair(makeSuite(), { ...options, candidateRunId: failed.manifest.id }),
    ).rejects.toMatchObject({ code: "run_pair_not_completed" });
    const wrongWorkflow = createEvaluationSuite({
      id: "screening",
      workflowId: "other",
      root,
      checks: [
        defineCheck({
          id: "check",
          targetStage: "report",
          outputInputs: {},
          revision: "v1",
          files: ["evaluation.ts"],
          evaluate: () => ({ passed: true, details: {} }),
        }),
      ],
    });
    await expect(prepareEvaluationPair(wrongWorkflow, options)).rejects.toMatchObject({
      code: "run_pair_workflow_mismatch",
    });
  });

  it("fails closed on corrupt or missing required artifacts without invoking callbacks", async () => {
    const { root, baseline, makeSuite, options, evaluate } = await fixture();
    const hash = baseline.manifest.stages.find(
      ({ stageId }) => stageId === "report",
    )?.outputArtifactHash;
    expect(hash).toBeTruthy();
    const object = join(root, ".abilitybench", "objects", "sha256", hash?.slice(7) ?? "");
    await writeFile(object, "{}");
    await expect(prepareEvaluationPair(makeSuite(), options)).rejects.toMatchObject({
      code: "corrupt_artifact",
    });
    await rm(object);
    await expect(prepareEvaluationPair(makeSuite(), options)).rejects.toMatchObject({
      code: "read_failed",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("rejects corrupted manifests before any evaluator can run", async () => {
    const { root, candidate, makeSuite, options, evaluate } = await fixture();
    await writeFile(join(root, ".abilitybench", "runs", `${candidate.manifest.id}.json`), "{}");
    await expect(prepareEvaluationPair(makeSuite(), options)).rejects.toMatchObject({
      code: "corrupt_manifest",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("rejects forged suites, invalid criteria, escaped storage, and watched storage", async () => {
    const { root, makeSuite, options } = await fixture();
    await expect(
      prepareEvaluationPair({ ...makeSuite() } as BuiltEvaluationSuite, options),
    ).rejects.toMatchObject({ code: "invalid_suite" });
    await expect(
      prepareEvaluationPair(makeSuite(), { ...options, criteria: { value: NaN } }),
    ).rejects.toMatchObject({ code: "invalid_criteria" });
    await expect(
      prepareEvaluationPair(makeSuite(), { ...options, storageDir: "../outside" }),
    ).rejects.toMatchObject({ code: "storage_path_escaped" });
    await expect(
      prepareEvaluationPair(makeSuite("report", undefined, [".abilitybench/state.json"]), options),
    ).rejects.toMatchObject({ code: "storage_path_watched" });
    await mkdir(join(root, "directory"));
    await expect(
      prepareEvaluationPair(makeSuite("report", undefined, ["directory"]), options),
    ).rejects.toMatchObject({ code: "invalid_watch_target" });
  });

  it("rejects watched/storage paths escaping through directory links", async () => {
    const { root, makeSuite, options } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "abilitybench eval outside "));
    roots.push(outside);
    await writeFile(join(outside, "evaluation.ts"), "outside");
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(
      prepareEvaluationPair(makeSuite("report", undefined, ["linked/evaluation.ts"]), options),
    ).rejects.toMatchObject({ code: "watch_path_escaped" });
    await expect(
      prepareEvaluationPair(makeSuite(), { ...options, storageDir: "linked/store" }),
    ).rejects.toMatchObject({ code: "storage_path_escaped" });
  });

  it("rejects a watched storage alias even when its lexical path is outside storage", async () => {
    const { root, makeSuite, options } = await fixture();
    await writeFile(join(root, ".abilitybench", "watched.json"), "{}");
    await symlink(
      join(root, ".abilitybench"),
      join(root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      prepareEvaluationPair(makeSuite("report", undefined, ["alias/watched.json"]), options),
    ).rejects.toMatchObject({ code: "storage_path_watched" });
  });

  it("does not create a missing store and fingerprints missing watched files explicitly", async () => {
    const { root, makeSuite, options } = await fixture();
    await expect(
      prepareEvaluationPair(makeSuite(), { ...options, storageDir: "missing-store" }),
    ).rejects.toMatchObject({ code: "run_not_found" });
    await expect(readdir(join(root, "missing-store"))).rejects.toMatchObject({ code: "ENOENT" });
    const prepared = await prepareEvaluationPair(
      makeSuite("report", undefined, ["absent.ts"]),
      options,
    );
    expect(prepared.suiteDescriptor).toMatchObject({
      checks: [{ watchedFiles: [{ path: "absent.ts", state: "missing" }] }],
    });
  });
});
