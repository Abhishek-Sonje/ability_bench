import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createWorkflow,
  type JsonValue,
  openHistory,
  prepare,
  type ReuseOptions,
  stage,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it.each(["equal", "changed", "intermediate", "object-order", "array-order", "requestHash"])(
  "propagates whole actual outputs through %s barriers and leaves independent work reusable",
  async (change) => {
    const f = await fixture();
    const calls: string[] = [];
    function graph(changed: boolean) {
      let output: JsonValue = { text: "same", requestHash: "original" };
      if (change === "changed" || change === "intermediate") output = changed ? 2 : 1;
      if (change === "object-order") output = changed ? { b: 2, a: 1 } : { a: 1, b: 2 };
      if (change === "array-order") output = changed ? [2, 1] : [1, 2];
      if (change === "requestHash" && changed) output = { text: "same", requestHash: "different" };
      const source = stage({
        id: "source",
        inputs: { prompt: changed ? "new" : "old" },
        reuse: { revision: "v1" },
        run: () => {
          calls.push("source");
          return output;
        },
      });
      const middle = stage({
        id: "middle",
        dependencies: { source },
        reuse: { revision: "v1" },
        run: ({ dependencies }) => {
          calls.push("middle");
          return change === "intermediate" ? "stable" : dependencies.source;
        },
      });
      const leaf = stage({
        id: "leaf",
        dependencies: { middle },
        reuse: { revision: "v1" },
        run: ({ dependencies }) => {
          calls.push("leaf");
          return dependencies.middle;
        },
      });
      const independent = stage({
        id: "independent",
        reuse: { revision: "v1" },
        run: () => {
          calls.push("independent");
          return "untouched";
        },
      });
      return createWorkflow({
        id: "barriers",
        root: f.root,
        stages: [source, middle, leaf, independent],
      });
    }
    const first = await (await prepare(graph(false), { baseline: null })).execute();
    calls.length = 0;
    const prepared = await prepare(graph(true), { baseline: { runId: first.runId } });
    expect(calls).toEqual([]);
    expect(prepared.preview.stages.map((s) => s.decision)).toEqual([
      "execute",
      "conditional",
      "conditional",
      "reuse",
    ]);
    expect(prepared.preview.stages[1]?.details).toMatchObject({
      unresolvedStages: ["source"],
      potentialEligibility: true,
    });
    const result = await prepared.execute();
    expect(result.status).toBe("completed");
    expect(calls).toEqual(
      change === "equal"
        ? ["source"]
        : change === "intermediate"
          ? ["source", "middle"]
          : ["source", "middle", "leaf"],
    );
    expect(result.stages[0]?.actual).toMatchObject({
      reason: "influences_changed",
      details: { changedComponents: [{ name: "inputs" }] },
    });
    expect(result.stages[1]?.preview.decision).toBe("conditional");
    expect(result.stages[1]?.actual.reason).toBe(
      change === "equal" ? "reused" : "influences_changed",
    );
    if (change !== "equal")
      expect(result.stages[1]?.actual.details).toMatchObject({ changedBindings: ["source"] });
    expect((await openHistory(f.history).run(result.runId)).stages).toEqual(result.stages);
  },
);
it("diagnoses relative escapes and physical history aliases without invoking their callbacks", async () => {
  const f = await fixture();
  const external = await fixture();
  await writeFile(join(external.root, "source.txt"), "outside");
  const escapingWatch = `../${external.root.split(/[\\/]/).at(-1)}/source.txt`;
  await mkdir(f.history);
  await writeFile(join(f.history, "record.txt"), "history");
  await symlink(f.history, join(f.root, "history alias"), "junction");
  let calls = 0;
  const stages = [escapingWatch, "history alias/record.txt"].map((path, i) =>
    stage({
      id: `watch-${i}`,
      reuse: { files: [path] },
      run: () => {
        calls++;
        return null;
      },
    }),
  );
  const prepared = await prepare(createWorkflow({ id: "paths", root: f.root, stages }), {
    baseline: null,
    failureMode: "continue-independent",
  });
  expect(prepared.preview.stages.map((s) => s.details)).toEqual([
    expect.objectContaining({
      error: expect.objectContaining({ code: "unsafe_path", file: escapingWatch }),
    }),
    expect.objectContaining({ error: expect.objectContaining({ code: "unsafe_path" }) }),
  ]);
  const result = await prepared.execute();
  expect(calls).toBe(0);
  expect(result.stages.map((s) => s.status)).toEqual(["failed", "failed"]);
});
it.each([undefined, false] as const)(
  "keeps %s always-execute outputs inspectable and policy-ineligible while equal outputs allow downstream reuse",
  async (policy) => {
    const f = await fixture();
    const calls: string[] = [];
    function graph(reuse: false | ReuseOptions | undefined, value = "same") {
      const source = stage({
        id: "source",
        ...(reuse === undefined ? {} : { reuse }),
        run: () => {
          calls.push("source");
          return value;
        },
      });
      const consumer = stage({
        id: "consumer",
        dependencies: { source },
        reuse: { revision: "v1" },
        run: ({ dependencies }) => {
          calls.push("consumer");
          return dependencies.source;
        },
      });
      return createWorkflow({ id: "policy", root: f.root, stages: [source, consumer] });
    }
    const first = await (await prepare(graph(policy), { baseline: null })).execute();
    expect(first.stages[0]).toMatchObject({ fingerprint: null, components: null });
    expect(await openHistory(f.history).output(first.runId, "source")).toBe("same");
    calls.length = 0;
    const second = await (
      await prepare(graph(policy), { baseline: { runId: first.runId } })
    ).execute();
    expect(calls).toEqual(["source"]);
    expect(second.stages.map((s) => s.actual.reason)).toEqual(["reuse_not_enabled", "reused"]);
    calls.length = 0;
    const changedPolicy = await (
      await prepare(graph({ revision: "v1" }), { baseline: { runId: second.runId } })
    ).execute();
    expect(calls).toEqual(["source"]);
    expect(changedPolicy.stages[0]?.actual.reason).toBe("baseline_policy_ineligible");
    calls.length = 0;
    const nowReusable = await (
      await prepare(graph({ revision: "v1" }), { baseline: { runId: changedPolicy.runId } })
    ).execute();
    expect(calls).toEqual([]);
    expect(nowReusable.stages.map((s) => s.status)).toEqual(["reused", "reused"]);
    const changedOutput = await (
      await prepare(graph(false, "new"), { baseline: { runId: nowReusable.runId } })
    ).execute();
    expect(changedOutput.stages.map((s) => s.actual.reason)).toEqual([
      "reuse_not_enabled",
      "influences_changed",
    ]);
  },
);
it("retains a mutable-source observation but runs reached publication after reused generation", async () => {
  const f = await fixture();
  const sourceFile = join(f.root, "mutable.txt"),
    publication = join(f.root, "published.txt");
  await writeFile(sourceFile, "yesterday");
  let acquisitions = 0,
    publications = 0;
  const source = stage({
    id: "source",
    reuse: { revision: "v1" },
    run: async () => {
      acquisitions++;
      return readFile(sourceFile, "utf8");
    },
  });
  const publish = stage({
    id: "publish",
    dependencies: { source },
    run: async ({ dependencies }) => {
      publications++;
      await writeFile(publication, dependencies.source);
      return dependencies.source;
    },
  });
  const workflow = createWorkflow({ id: "effects", root: f.root, stages: [source, publish] });
  const first = await (await prepare(workflow, { baseline: null })).execute();
  await writeFile(sourceFile, "today");
  await rm(publication);
  const second = await (await prepare(workflow, { baseline: { runId: first.runId } })).execute();
  expect(acquisitions).toBe(1);
  expect(publications).toBe(2);
  expect(second.stages[0]?.output).toEqual(first.stages[0]?.output);
  expect(await readFile(publication, "utf8")).toBe("yesterday");
  const fresh = await (await prepare(workflow, { baseline: null })).execute();
  expect(acquisitions).toBe(2);
  expect(fresh.stages[0]?.output?.origin.attemptId).toBe(fresh.attemptId);
  expect(Date.parse(fresh.stages[0]?.output?.observedAt ?? "")).toBeGreaterThanOrEqual(
    Date.parse(fresh.startedAt),
  );
  expect(await openHistory(f.history).output(fresh.runId, "source")).toBe("today");
});
it("rejects absent, wrong-workflow, corrupt, known incompatible and unknown baselines before callbacks", async () => {
  const f = await fixture();
  let calls = 0;
  const source = stage({
    id: "source",
    reuse: { revision: "v1" },
    run: () => {
      calls++;
      return null;
    },
  });
  const workflow = createWorkflow({ id: "selection", root: f.root, stages: [source] });
  const missing = `run_${"0".repeat(64)}`;
  await expect(prepare(workflow, { baseline: { runId: missing } })).rejects.toMatchObject({
    code: "baseline_not_found",
  });
  const first = await (await prepare(workflow, { baseline: null })).execute();
  await expect(
    prepare(createWorkflow({ id: "other", root: f.root, stages: [source] }), {
      baseline: { runId: first.runId },
    }),
  ).rejects.toMatchObject({ code: "baseline_workflow_mismatch" });
  const path = join(f.history, "runs", `${missing}.json`);
  for (const [bytes, code] of [
    ["{", "corrupt_record"],
    [JSON.stringify({ schemaVersion: "phase0-run-v1" }), "baseline_incompatible"],
    [JSON.stringify({ schemaVersion: "future-format" }), "unsupported_history_format"],
  ]) {
    await writeFile(path, bytes ?? "");
    await expect(prepare(workflow, { baseline: { runId: missing } })).rejects.toMatchObject({
      code,
    });
  }
  expect(calls).toBe(1);
});
it("retains every applicable cause when influence and artifact changes both prevent reuse", async () => {
  const f = await fixture();
  function graph(prompt: string) {
    return createWorkflow({
      id: "reasons",
      root: f.root,
      stages: [
        stage({ id: "source", inputs: { prompt }, reuse: { revision: "v1" }, run: () => prompt }),
      ],
    });
  }
  const first = await (await prepare(graph("first"), { baseline: null })).execute();
  await rm(
    join(
      f.history,
      "objects",
      "abilitybench-artifact-v2",
      "sha256",
      first.stages[0]?.output?.hash.slice(7) ?? "missing",
    ),
  );
  const prepared = await prepare(graph("changed"), { baseline: { runId: first.runId } });
  expect(prepared.preview.stages[0]).toMatchObject({
    reason: "influences_changed",
    details: {
      causes: ["influences_changed", "reuse_unavailable"],
      artifact: { code: "artifact_not_found" },
    },
  });
  const result = await prepared.execute();
  expect(result.stages[0]?.actual).toEqual(
    prepared.preview.stages[0] && {
      decision: prepared.preview.stages[0].decision,
      reason: prepared.preview.stages[0].reason,
      details: prepared.preview.stages[0].details,
    },
  );
});
it("reuses through retained chains without consulting ancestors and isolates mutable reused dependencies", async () => {
  const f = await fixture();
  let sourceCalls = 0;
  const source = stage({
    id: "source",
    reuse: { revision: "v1" },
    run: () => {
      sourceCalls++;
      return { list: [2, 1], z: 1, a: 2 };
    },
  });
  const left = stage({
    id: "left",
    dependencies: { source },
    run: ({ dependencies }) => {
      dependencies.source.list.sort();
      return dependencies.source;
    },
  });
  const right = stage({
    id: "right",
    dependencies: { source },
    run: ({ dependencies }) => dependencies.source,
  });
  const workflow = createWorkflow({ id: "chain", root: f.root, stages: [source, left, right] });
  const first = await (await prepare(workflow, { baseline: null })).execute();
  const second = await (await prepare(workflow, { baseline: { runId: first.runId } })).execute();
  await rm(join(f.history, "runs", `${first.runId}.json`));
  const third = await (await prepare(workflow, { baseline: { runId: second.runId } })).execute();
  expect(sourceCalls).toBe(1);
  expect(third.stages[0]?.output).toEqual(first.stages[0]?.output);
  const history = openHistory(f.history);
  expect(await history.output(third.runId, "left")).toMatchObject({ list: [1, 2] });
  expect(await history.output(third.runId, "right")).toMatchObject({ list: [2, 1] });
  const value = (await history.output(third.runId, "source")) as { list: number[] };
  value.list.reverse();
  expect(await history.output(third.runId, "source")).toMatchObject({ list: [2, 1] });
});
it("uses only the selected run's eligible successful records rather than searching older outputs", async () => {
  const f = await fixture();
  const graph = (includeTarget: boolean, fail: boolean) => {
    const seed = stage({ id: "seed", reuse: { revision: "v1" }, run: () => "stable" });
    const target = stage({
      id: "target",
      dependencies: { seed },
      reuse: { revision: "v1" },
      run: () => {
        if (fail) throw new Error("offline failure");
        return "result";
      },
    });
    return createWorkflow({
      id: "selected",
      root: f.root,
      stages: includeTarget ? [seed, target] : [seed],
    });
  };
  const old = await (await prepare(graph(true, false), { baseline: null })).execute();
  const missing = await (await prepare(graph(false, false), { baseline: null })).execute();
  const added = await (
    await prepare(graph(true, true), { baseline: { runId: missing.runId } })
  ).execute();
  expect(added.stages[1]?.actual.reason).toBe("baseline_stage_missing");
  expect(added.status).toBe("failed");
  const recovered = await (
    await prepare(graph(true, false), { baseline: { runId: added.runId } })
  ).execute();
  expect(recovered.baseline).toMatchObject({ runId: added.runId, status: "failed" });
  expect(recovered.stages.map((s) => s.actual.reason)).toEqual([
    "reused",
    "baseline_output_absent",
  ]);
  expect(recovered.stages[1]?.output?.origin.attemptId).toBe(recovered.attemptId);
  expect(recovered.stages[1]?.output?.origin.attemptId).not.toBe(old.attemptId);
});
it("keeps watch diagnostics separate from unchanged-baseline predictions when execution cannot observe identity", async () => {
  const f = await fixture(),
    file = join(f.root, "source.ts");
  await writeFile(file, "v1");
  let calls = 0;
  const source = stage({
    id: "source",
    reuse: { files: [file] },
    run: () => {
      calls++;
      return null;
    },
  });
  const workflow = createWorkflow({ id: "diagnostics", root: f.root, stages: [source] });
  const first = await (await prepare(workflow, { baseline: null })).execute();
  await rm(file);
  const prepared = await prepare(workflow, { baseline: { runId: first.runId } });
  expect(prepared.preview.stages[0]).toMatchObject({
    decision: "execute",
    details: { error: { code: "influence_unavailable" } },
  });
  const failed = await prepared.execute();
  expect(failed.status).toBe("failed");
  expect(failed.stages[0]).toMatchObject({
    actual: { decision: "execute", details: { callbackInvoked: false } },
    error: { code: "influence_unavailable" },
  });
  expect(calls).toBe(1);
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench reuse "));
  roots.push(root);
  return { root, history: join(root, ".abilitybench") };
}
it("keeps blocked/stopped precedence without discarding applicable policy or influence causes", async () => {
  const f = await fixture();
  const graph = (fail: boolean, changed: boolean) => {
    const source = stage({
      id: "source",
      run: () => {
        if (fail) throw new Error("offline failure");
        return 1;
      },
    });
    const child = stage({
      id: "child",
      dependencies: { source },
      inputs: { prompt: changed ? "new" : "old" },
      reuse: { revision: "v1" },
      run: () => null,
    });
    const effect = stage({ id: "effect", run: () => null });
    return createWorkflow({ id: "skips", root: f.root, stages: [source, child, effect] });
  };
  const first = await (await prepare(graph(false, false), { baseline: null })).execute();
  const result = await (
    await prepare(graph(true, true), { baseline: { runId: first.runId } })
  ).execute();
  expect(result.stages[1]?.actual).toMatchObject({
    decision: "skip",
    reason: "dependency_blocked",
    details: {
      causes: ["dependency_blocked", "influences_changed"],
      changedComponents: expect.arrayContaining([expect.objectContaining({ name: "inputs" })]),
    },
  });
  expect(result.stages[2]?.actual).toMatchObject({
    decision: "skip",
    reason: "run_stopped",
    details: { causes: expect.arrayContaining(["run_stopped", "reuse_not_enabled"]) },
  });
});
it("selects exactly one retained baseline and reuses its original observation without callbacks", async () => {
  const f = await fixture();
  let calls = 0;
  const source = stage({
    id: "source",
    reuse: { revision: "v1" },
    run: () => {
      calls++;
      return { z: [2, 1], a: null };
    },
  });
  const workflow = createWorkflow({ id: "reuse", root: f.root, stages: [source] });
  const first = await (await prepare(workflow, { baseline: null })).execute();
  const selected = { runId: first.runId };
  const prepared = await prepare(workflow, { baseline: selected });
  expect(calls).toBe(1);
  expect(prepared.preview).toMatchObject({
    baseline: { runId: first.runId, status: "completed", schemaVersion: "abilitybench-run-v2" },
    stages: [{ decision: "reuse", reason: "reused" }],
  });
  selected.runId = `run_${"0".repeat(64)}`;
  const second = await prepared.execute();
  expect(calls).toBe(1);
  expect(second.baseline?.runId).toBe(first.runId);
  expect(second.stages[0]).toMatchObject({
    status: "reused",
    actual: { decision: "reuse", reason: "reused" },
    output: first.stages[0]?.output,
  });
  const history = openHistory(f.history);
  expect(Object.keys((await history.output(second.runId, "source")) as object)).toEqual(["z", "a"]);
  expect((await history.run(second.runId)).stages[0]?.preview).toEqual(second.stages[0]?.preview);
});
