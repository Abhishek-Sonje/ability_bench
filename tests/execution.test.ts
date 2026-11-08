// biome-ignore-all lint/complexity/useLiteralKeys: TypeScript requires index access for dictionaries.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWorkflow, openHistory, prepare, stage } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench execute "));
  roots.push(root);
  return { root, history: join(root, ".abilitybench") };
}
it("captures caller inputs, graph, callback, options and named environment; isolates each consumer", async () => {
  const f = await fixture();
  const inputs = { z: [3, 1], a: "original" };
  const previous = process.env["ABILITYBENCH_CAPTURE"];
  process.env["ABILITYBENCH_CAPTURE"] = "captured";
  try {
    const options = {
      id: "seed",
      inputs,
      environment: ["ABILITYBENCH_CAPTURE"],
      reuse: { revision: "r1" },
      run: ({
        inputs,
        env,
      }: {
        inputs: { z: number[]; a: string };
        env: Record<string, string | undefined>;
      }) => ({ inputs, env: env["ABILITYBENCH_CAPTURE"] ?? "missing" }),
    };
    const seed = stage(options);
    const deps = { renamed: seed };
    const left = stage({
      id: "left",
      dependencies: deps,
      run: ({ dependencies }) => {
        dependencies.renamed.inputs.z.sort();
        return dependencies.renamed;
      },
    });
    const right = stage({
      id: "right",
      dependencies: { seed },
      run: ({ dependencies }) => dependencies.seed,
    });
    const list = [seed, left, right];
    const workflow = createWorkflow({ id: "isolation", root: f.root, stages: list });
    const executionOptions = {
      baseline: null,
      historyDirectory: f.history,
      failureMode: "continue-independent" as const,
    };
    const prepared = await prepare(workflow, executionOptions);
    inputs.z.push(9);
    inputs.a = "changed";
    options.run = () => ({ inputs: { z: [], a: "wrong" }, env: "wrong" });
    options.reuse.revision = "changed";
    options.environment.push("EXTRA");
    list.reverse();
    delete (deps as Partial<typeof deps>).renamed;
    executionOptions.historyDirectory = join(f.root, "wrong");
    process.env["ABILITYBENCH_CAPTURE"] = "changed";
    const result = await prepared.execute();
    expect(result.status).toBe("completed");
    const history = openHistory(f.history);
    expect(await history.output(result.runId, "left")).toEqual({
      inputs: { z: [1, 3], a: "original" },
      env: "captured",
    });
    expect(await history.output(result.runId, "right")).toEqual({
      inputs: { z: [3, 1], a: "original" },
      env: "captured",
    });
    expect(await history.output(result.runId, "seed")).toEqual({
      inputs: { z: [3, 1], a: "original" },
      env: "captured",
    });
    expect(inputs).toEqual({ z: [3, 1, 9], a: "changed" });
    const record = await history.run(result.runId);
    expect(JSON.stringify(record)).not.toContain('"captured"');
    expect(record.stages[0]?.fingerprint).toMatch(/^sha256:/);
  } finally {
    if (previous === undefined) delete process.env["ABILITYBENCH_CAPTURE"];
    else process.env["ABILITYBENCH_CAPTURE"] = previous;
  }
});
it.each(["fail-fast", "continue-independent"] as const)(
  "retains earlier successes with %s failure scheduling",
  async (failureMode) => {
    const f = await fixture();
    let failedCalls = 0,
      descendantCalls = 0,
      independentCalls = 0;
    const seed = stage({ id: "seed", run: () => null });
    const bad = stage({
      id: "bad",
      dependencies: { seed },
      run: () => {
        failedCalls++;
        throw new Error("provider credential must not leak");
      },
    });
    const blocked = stage({
      id: "blocked",
      dependencies: { bad },
      run: () => {
        descendantCalls++;
        return 2;
      },
    });
    const independent = stage({
      id: "independent",
      run: () => {
        independentCalls++;
        return 3;
      },
    });
    const result = await (
      await prepare(
        createWorkflow({ id: "failures", root: f.root, stages: [seed, bad, blocked, independent] }),
        { baseline: null, failureMode },
      )
    ).execute();
    expect(result.status).toBe("failed");
    expect(failedCalls).toBe(1);
    expect(descendantCalls).toBe(0);
    expect(independentCalls).toBe(failureMode === "fail-fast" ? 0 : 1);
    expect(result.stages[1]).toMatchObject({
      status: "failed",
      actual: { decision: "execute", details: { callbackInvoked: true } },
      error: { code: "callback_failed" },
    });
    expect(result.stages[2]?.actual.reason).toBe("dependency_blocked");
    expect(result.stages[3]?.actual.reason).toBe(
      failureMode === "fail-fast" ? "run_stopped" : "reuse_not_enabled",
    );
    expect(await openHistory(f.history).output(result.runId, "seed")).toBeNull();
    expect(JSON.stringify(await openHistory(f.history).run(result.runId))).not.toContain(
      "credential",
    );
  },
);
it("reports unavailable watches in preview and fails before callback without retry", async () => {
  const f = await fixture();
  let calls = 0;
  const s = stage({
    id: "watched",
    reuse: { files: ["missing.ts"] },
    run: () => {
      calls++;
      return null;
    },
  });
  const p = await prepare(createWorkflow({ id: "watch", root: f.root, stages: [s] }), {
    baseline: null,
  });
  expect(p.preview.stages[0]?.details).toMatchObject({ error: { code: "influence_unavailable" } });
  const result = await p.execute();
  expect(calls).toBe(0);
  expect(result.stages[0]).toMatchObject({
    status: "failed",
    actual: { details: { callbackInvoked: false } },
    error: { code: "influence_unavailable" },
  });
});
it("checks reusable influences around callbacks, accepts absolute files and exempts always-execute", async () => {
  const f = await fixture();
  const external = await fixture();
  const file = join(external.root, "source.ts");
  await writeFile(file, "before");
  const reusable = stage({
    id: "reusable",
    reuse: { files: [file] },
    run: async () => {
      await writeFile(file, "after");
      return "discard";
    },
  });
  const effect = stage({
    id: "effect",
    run: async () => {
      await writeFile(file, "again");
      return "retained";
    },
  });
  const p = await prepare(
    createWorkflow({ id: "stability", root: f.root, stages: [reusable, effect] }),
    { baseline: null, failureMode: "continue-independent" },
  );
  const result = await p.execute();
  expect(result.stages[0]?.error?.["code"]).toBe("influence_changed_during_execution");
  expect(result.stages[1]).toMatchObject({
    status: "succeeded",
    fingerprint: null,
    components: null,
  });
  expect(await openHistory(f.history).output(result.runId, "effect")).toBe("retained");
});
it("copies synchronous outputs before callback-scheduled mutation and preserves safe aliases", async () => {
  const f = await fixture();
  const value = { z: [2, 1], a: 0 };
  const seed = stage({
    id: "seed",
    run: () => {
      queueMicrotask(() => value.z.push(9));
      return value;
    },
  });
  const aliases = stage({
    id: "aliases",
    dependencies: Object.fromEntries([
      ["__proto__", seed],
      ["other", seed],
    ]),
    run: ({ dependencies }) => {
      // biome-ignore lint/suspicious/noProto: This is a safe own binding, explicitly required by the contract.
      const first = dependencies["__proto__"] as typeof value;
      first.z.sort();
      return { first, other: dependencies["other"] as typeof value };
    },
  });
  const result = await (
    await prepare(createWorkflow({ id: "copies", root: f.root, stages: [seed, aliases] }), {
      baseline: null,
    })
  ).execute();
  expect(await openHistory(f.history).output(result.runId, "aliases")).toEqual({
    first: { z: [1, 2], a: 0 },
    other: { z: [2, 1], a: 0 },
  });
});
it("rejects omitted or deferred baseline selection and remains used after finalization rejects", async () => {
  const f = await fixture();
  const workflow = createWorkflow({ id: "once", root: f.root, stages: [] });
  // @ts-expect-error Deliberate JavaScript misuse.
  await expect(prepare(workflow, {})).rejects.toMatchObject({ code: "invalid_argument" });
  // @ts-expect-error Retained selection is outside this slice.
  await expect(prepare(workflow, { baseline: "latest" })).rejects.toMatchObject({
    code: "invalid_argument",
  });
  await writeFile(f.history, "blocked by real file");
  const p = await prepare(workflow, { baseline: null });
  await expect(p.execute()).rejects.toMatchObject({
    code: "finalization_failed",
    attemptId: expect.any(String),
    runId: expect.stringMatching(/^run_/),
  });
  await expect(p.execute()).rejects.toMatchObject({ code: "prepared_execution_used" });
});
it("persists accepted artifacts before the immutable finalized record", async () => {
  const f = await fixture();
  const s = stage({ id: "source", run: () => ({ a: 1 }) });
  const result = await (
    await prepare(createWorkflow({ id: "identity", root: f.root, stages: [s] }), { baseline: null })
  ).execute();
  const bytes = await readFile(join(f.history, "runs", `${result.runId}.json`));
  expect(JSON.parse(bytes.toString()).attemptId).toBe(result.attemptId);
  const ref = result.stages[0]?.output;
  expect(ref).not.toBeNull();
  expect(
    (
      await stat(
        join(
          f.history,
          "objects",
          "abilitybench-artifact-v2",
          "sha256",
          ref?.hash.slice(7) ?? "missing",
        ),
      )
    ).isFile(),
  ).toBe(true);
});
it("fail-fast marks descendants of stopped independent work as run_stopped", async () => {
  const f = await fixture();
  const bad = stage({
    id: "bad",
    run: () => {
      throw new Error("fail");
    },
  });
  const independent = stage({ id: "independent", run: () => null });
  const child = stage({ id: "child", dependencies: { independent }, run: () => null });
  const result = await (
    await prepare(createWorkflow({ id: "stop", root: f.root, stages: [bad, independent, child] }), {
      baseline: null,
    })
  ).execute();
  expect(result.status).toBe("failed");
  expect(result.stages.map((s) => s.actual.reason)).toEqual([
    "reuse_not_enabled",
    "run_stopped",
    "run_stopped",
  ]);
});
it("accepts asynchronous callbacks from another JavaScript realm", async () => {
  const { runInNewContext } = await import("node:vm");
  const f = await fixture();
  const foreign = runInNewContext("async () => null") as () => Promise<null>;
  const s = stage({ id: "async", run: foreign });
  const result = await (
    await prepare(createWorkflow({ id: "realm", root: f.root, stages: [s] }), { baseline: null })
  ).execute();
  expect(result.status).toBe("completed");
});
it("fingerprints full local ordered inputs, captured environment and dependency aliases", async () => {
  const f = await fixture();
  const previous = process.env["ABILITYBENCH_CAPTURE"];
  try {
    const execute = async (prompt: string, environment: string | undefined, alias = "source") => {
      if (environment === undefined) delete process.env["ABILITYBENCH_CAPTURE"];
      else process.env["ABILITYBENCH_CAPTURE"] = environment;
      const source = stage({
        id: "source",
        inputs: { prompt: "constant" },
        reuse: { revision: "v1" },
        run: () => ({ z: 1, a: 2 }),
      });
      const target = stage({
        id: "target",
        inputs: { prompt },
        environment: ["ABILITYBENCH_CAPTURE"],
        dependencies: Object.fromEntries([[alias, source]]),
        reuse: { revision: "v1" },
        run: () => null,
      });
      const prepared = await prepare(
        createWorkflow({ id: "components", root: f.root, stages: [source, target] }),
        { baseline: null },
      );
      process.env["ABILITYBENCH_CAPTURE"] = "changed-after-prepare";
      return prepared.execute();
    };
    const a = await execute("a", "captured"),
      b = await execute("b", "captured"),
      c = await execute("a", undefined),
      d = await execute("a", "captured", "alias");
    expect(a.stages[0]?.fingerprint).toBe(b.stages[0]?.fingerprint);
    expect(a.stages[1]?.components?.["inputs"]).not.toBe(b.stages[1]?.components?.["inputs"]);
    expect(a.stages[1]?.components?.["environment"]).toBe(b.stages[1]?.components?.["environment"]);
    expect(a.stages[1]?.components?.["environment"]).not.toBe(
      c.stages[1]?.components?.["environment"],
    );
    expect(a.stages[1]?.components?.["dependencies"]).not.toBe(
      d.stages[1]?.components?.["dependencies"],
    );
  } finally {
    if (previous === undefined) delete process.env["ABILITYBENCH_CAPTURE"];
    else process.env["ABILITYBENCH_CAPTURE"] = previous;
  }
});
it("gives mutable private inputs and environment without changing captured identities", async () => {
  const f = await fixture();
  const original = { list: [2, 1] };
  const old = process.env["ABILITYBENCH_MUTABLE"];
  process.env["ABILITYBENCH_MUTABLE"] = "original";
  try {
    const source = stage({
      id: "source",
      inputs: original,
      environment: ["ABILITYBENCH_MUTABLE"],
      reuse: { revision: "v1" },
      run: ({ inputs, env }) => {
        inputs.list.sort();
        env["ABILITYBENCH_MUTABLE"] = "private";
        return { inputs, env: env["ABILITYBENCH_MUTABLE"] };
      },
    });
    const other = stage({
      id: "other",
      inputs: original,
      environment: ["ABILITYBENCH_MUTABLE"],
      reuse: { revision: "v1" },
      run: ({ inputs, env }) => ({ inputs, env: env["ABILITYBENCH_MUTABLE"] ?? "missing" }),
    });
    const result = await (
      await prepare(createWorkflow({ id: "mutable", root: f.root, stages: [source, other] }), {
        baseline: null,
      })
    ).execute();
    expect(result.status).toBe("completed");
    expect(original.list).toEqual([2, 1]);
    expect(process.env["ABILITYBENCH_MUTABLE"]).toBe("original");
    expect(await openHistory(f.history).output(result.runId, "other")).toEqual({
      inputs: { list: [2, 1] },
      env: "original",
    });
    expect(result.stages[0]?.components?.["inputs"]).toBe(result.stages[1]?.components?.["inputs"]);
  } finally {
    if (old === undefined) delete process.env["ABILITYBENCH_MUTABLE"];
    else process.env["ABILITYBENCH_MUTABLE"] = old;
  }
});
