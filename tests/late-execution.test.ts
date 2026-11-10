import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareExecution } from "../src/execution.js";
import {
  AbilityBenchError,
  createWorkflow,
  type JsonValue,
  openHistory,
  prepare,
  stage,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench late changes "));
  roots.push(root);
  const watch = join(root, "source.txt");
  await writeFile(watch, "original");
  return { root, watch, history: join(root, ".abilitybench") };
}

it.each(["rewrite", "remove", "directory"] as const)(
  "observes a %s during selected-artifact verification before reusing or invoking the callback",
  async (change) => {
    const { root, watch, history } = await fixture();
    let calls = 0;
    const source = stage({
      id: "source",
      reuse: { files: ["source.txt"] },
      run: () => ++calls,
    });
    const workflow = createWorkflow({ id: "late", root, stages: [source] });
    const baseline = await (await prepare(workflow, { baseline: null })).execute();
    const prepared = await prepareExecution(
      workflow,
      { baseline: { runId: baseline.runId } },
      {
        afterArtifactRead: async (operation) => {
          if (operation !== "execute") return;
          if (change === "rewrite") await writeFile(watch, "changed");
          else {
            await rm(watch);
            if (change === "directory") await mkdir(watch);
          }
        },
      },
    );
    expect(calls).toBe(1);
    expect(prepared.preview.stages[0]).toMatchObject({ decision: "reuse", reason: "reused" });

    const result = await prepared.execute();
    const recorded = await openHistory(history).run(result.runId);
    expect(recorded.stages[0]).toMatchObject({ preview: { decision: "reuse", reason: "reused" } });
    if (change === "rewrite") {
      expect(calls).toBe(2);
      expect(recorded.stages[0]).toMatchObject({
        status: "succeeded",
        actual: {
          reason: "influences_changed",
          details: { changedComponents: [{ name: "watchedFiles" }] },
        },
      });
      expect(await openHistory(history).output(result.runId, "source")).toBe(2);
    } else {
      expect(calls).toBe(1);
      expect(recorded.stages[0]).toMatchObject({
        status: "failed",
        output: null,
        actual: { reason: "influences_changed", details: { callbackInvoked: false } },
        error: { code: "influence_unavailable", file: "source.txt" },
      });
    }
  },
);

it.each(["rewrite", "remove"] as const)(
  "rejects a %s during a reusable callback before publication or consumption",
  async (change) => {
    const { root, watch, history } = await fixture();
    let calls = 0;
    let consumed = 0;
    const source = stage({
      id: "source",
      reuse: { files: ["source.txt"] },
      run: async () => {
        calls++;
        if (change === "rewrite") await writeFile(watch, "changed");
        else await rm(watch);
        return "unpublished";
      },
    });
    const sink = stage({
      id: "sink",
      dependencies: { source },
      run: () => ++consumed,
    });
    const workflow = createWorkflow({ id: "mid-callback", root, stages: [source, sink] });
    const prepared = await prepare(workflow, { baseline: null });
    const result = await prepared.execute();
    expect(result.status).toBe("failed");
    expect(result.stages[0]).toMatchObject({
      status: "failed",
      output: null,
      actual: { reason: "fresh", details: { callbackInvoked: true } },
      error: { code: "influence_changed_during_execution" },
    });
    expect(result.stages[1]?.actual.reason).toBe("dependency_blocked");
    expect(calls).toBe(1);
    expect(consumed).toBe(0);
    await expect(stat(join(history, "objects"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each([
  ["before", "missing", true],
  ["after", "missing", false],
  ["before", "corrupt", false],
  ["after", "corrupt", true],
  ["before", "unreadable", false],
  ["after", "unreadable", false],
] as const)(
  "regenerates once for %s-preview %s selected artifacts (equal output: %s)",
  async (timing, fault, equal) => {
    const { root, history } = await fixture();
    const cause = {
      missing: "artifact_not_found",
      corrupt: "corrupt_artifact",
      unreadable: "artifact_unreadable",
    }[fault];
    let value = "older";
    let calls = 0;
    let consumed = 0;
    const source = stage({
      id: "source",
      reuse: { revision: "one" },
      run: () => {
        calls++;
        return value;
      },
    });
    const sink = stage({
      id: "sink",
      reuse: { revision: "one" },
      dependencies: { value: source },
      run: ({ dependencies }) => {
        consumed++;
        return `sink:${dependencies.value}`;
      },
    });
    const workflow = createWorkflow({ id: "regenerate", root, stages: [source, sink] });
    await (await prepare(workflow, { baseline: null })).execute();
    value = "selected";
    const selected = await (await prepare(workflow, { baseline: null })).execute();
    const objectDir = join(history, "objects", "abilitybench-artifact-v2", "sha256");
    const selectedHash = selected.stages[0]?.output?.hash.slice(7);
    const selectedFile = join(objectDir, selectedHash ?? "missing");
    let unreadable = false;
    async function damage() {
      if (fault === "missing") await rm(selectedFile);
      else if (fault === "corrupt") await appendFile(selectedFile, "!");
      else unreadable = true;
    }
    if (timing === "before") await damage();
    const prepared =
      fault === "unreadable"
        ? await prepareExecution(
            workflow,
            { baseline: "latest" },
            {
              afterArtifactRead: async (_operation, stageId) => {
                if (unreadable && stageId === "source")
                  throw Object.assign(new Error("read denied"), { code: "EACCES" });
              },
            },
          )
        : await prepare(workflow, { baseline: "latest" });
    expect(prepared.preview.baseline?.runId).toBe(selected.runId);
    expect(prepared.preview.stages[0]).toMatchObject(
      timing === "before"
        ? {
            decision: "execute",
            reason: "reuse_unavailable",
            details: { artifact: { code: cause } },
          }
        : { decision: "reuse", reason: "reused" },
    );
    expect(prepared.preview.stages[1]?.decision).toBe(
      timing === "before" ? "conditional" : "reuse",
    );
    expect([calls, consumed]).toEqual([2, 2]);

    if (timing === "after") await damage();
    value = equal ? "selected" : "regenerated";
    const result = await prepared.execute();
    expect(result.baseline).toEqual(prepared.preview.baseline);
    expect(result.status).toBe("completed");
    expect(result.stages[0]).toMatchObject({
      status: "succeeded",
      actual: { reason: "reuse_unavailable", details: { artifact: { code: cause } } },
    });
    expect(result.stages[1]).toMatchObject({
      status: equal ? "reused" : "succeeded",
      actual: equal
        ? { reason: "reused" }
        : { reason: "influences_changed", details: { changedBindings: ["value"] } },
    });
    expect([calls, consumed]).toEqual([3, equal ? 2 : 3]);
    expect(await openHistory(history).output(result.runId, "sink")).toBe(`sink:${value}`);
  },
);

describe.each(["fail-fast", "continue-independent"] as const)(
  "%s failure scheduling",
  (failureMode) => {
    it.each([
      ["throw", "callback_failed"],
      ["invalid", "invalid_json_value"],
      ["oversize", "output_limit_exceeded"],
      ["watch", "influence_unavailable"],
      ["mid-watch", "influence_changed_during_execution"],
      ["publish", "publication_failed"],
    ] as const)(
      "retains committed work after %s and never repeats a reached callback",
      async (fault, code) => {
        const { root, watch, history } = await fixture();
        const effect = join(root, "effect.log");
        let calls = 0;
        let sinkCalls = 0;
        let independentCalls = 0;
        let fail = true;
        const seed = stage({ id: "seed", reuse: { revision: "one" }, run: () => "retained" });
        const source = stage({
          id: "source",
          dependencies: { seed },
          reuse: { files: ["source.txt"] },
          run: async () => {
            calls++;
            if (fail) {
              if (fault === "throw") {
                await appendFile(effect, "effect\n");
                throw new AbilityBenchError("invalid_argument", "provider-secret", "provider");
              }
              if (fault === "mid-watch") await writeFile(watch, "changed in callback");
              if (fault === "invalid") return { bad: undefined } as unknown as JsonValue;
              if (fault === "oversize") return "x".repeat(16 * 1024 * 1024 - 1);
            }
            return "accepted";
          },
        });
        const sink = stage({ id: "sink", dependencies: { source }, run: () => ++sinkCalls });
        const independent = stage({ id: "independent", run: () => ++independentCalls });
        const workflow = createWorkflow({
          id: "failure-matrix",
          root,
          stages: [seed, source, sink, independent],
        });
        const options = { baseline: null, failureMode };
        let publications = 0;
        const prepared =
          fault === "publish"
            ? await prepareExecution(workflow, options, {
                staged: async () => {
                  if (++publications === 2)
                    throw Object.assign(new Error("filesystem-secret"), { code: "EIO" });
                },
              })
            : await prepare(workflow, options);
        expect(calls).toBe(0);
        if (fault === "watch") await rm(watch);

        const result = await prepared.execute();
        const reader = openHistory(history);
        expect(result.status).toBe("failed");
        expect(await reader.run(result.runId)).toMatchObject({ status: "failed" });
        expect(await reader.output(result.runId, "seed")).toBe("retained");
        expect(result.stages[1]).toMatchObject({
          status: "failed",
          output: null,
          actual: { reason: "fresh", details: { callbackInvoked: fault !== "watch" } },
          error: { code, ...(fault === "publish" ? { causeCode: "EIO" } : {}) },
        });
        expect(JSON.stringify(result)).not.toMatch(/provider-secret|filesystem-secret/);
        expect(result.stages[2]?.actual.reason).toBe("dependency_blocked");
        expect(result.stages[3]?.actual.reason).toBe(
          failureMode === "fail-fast" ? "run_stopped" : "reuse_not_enabled",
        );
        expect([calls, sinkCalls, independentCalls]).toEqual([
          fault === "watch" ? 0 : 1,
          0,
          failureMode === "fail-fast" ? 0 : 1,
        ]);
        if (fault === "throw") {
          expect(await readFile(effect, "utf8")).toBe("effect\n");
          fail = false;
          const recovery = await (
            await prepare(workflow, { baseline: "latest", failureMode })
          ).execute();
          expect(recovery.stages[0]?.status).toBe("reused");
          expect(recovery.status).toBe("completed");
          expect(calls).toBe(2);
          expect(sinkCalls).toBe(1);
          expect(await readFile(effect, "utf8")).toBe("effect\n");
        }
      },
    );
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "fails before invoking a reusable callback when a watch becomes unreadable after preview",
  async () => {
    const { root, watch } = await fixture();
    let calls = 0;
    const source = stage({ id: "source", reuse: { files: ["source.txt"] }, run: () => ++calls });
    const workflow = createWorkflow({ id: "late-permission", root, stages: [source] });
    const baseline = await (await prepare(workflow, { baseline: null })).execute();
    const prepared = await prepare(workflow, { baseline: { runId: baseline.runId } });
    expect(prepared.preview.stages[0]?.decision).toBe("reuse");
    try {
      await chmod(watch, 0);
      const result = await prepared.execute();
      expect(result.stages[0]).toMatchObject({
        actual: { reason: "influences_changed", details: { callbackInvoked: false } },
        error: { code: "influence_unavailable", file: "source.txt", causeCode: "EACCES" },
      });
      expect(calls).toBe(1);
    } finally {
      await chmod(watch, 0o600);
    }
  },
);

it("preserves known component, refresh and artifact details when late watch observation fails", async () => {
  const { root, watch, history } = await fixture();
  let calls = 0;
  const source = (prompt: string) =>
    stage({
      id: "source",
      reuse: { files: ["source.txt"] },
      inputs: { prompt },
      run: () => ++calls,
    });
  const workflow = (item: ReturnType<typeof source>) =>
    createWorkflow({ id: "reason-precedence", root, stages: [item] });
  const baseline = await (await prepare(workflow(source("before")), { baseline: null })).execute();
  const updated = source("after");
  const prepared = await prepare(workflow(updated), {
    baseline: { runId: baseline.runId },
    refresh: { stages: [updated] },
  });
  expect(prepared.preview.stages[0]).toMatchObject({
    reason: "refresh",
    details: { causes: ["refresh", "influences_changed"], changedComponents: [{ name: "inputs" }] },
  });

  const hash = baseline.stages[0]?.output?.hash.slice(7);
  await rm(join(history, "objects", "abilitybench-artifact-v2", "sha256", hash ?? "missing"));
  await rm(watch);
  const result = await prepared.execute();
  expect(calls).toBe(1);
  expect(result.stages[0]).toMatchObject({
    preview: {
      reason: "refresh",
      details: { causes: ["refresh", "influences_changed"] },
    },
    actual: {
      decision: "execute",
      reason: "refresh",
      details: {
        callbackInvoked: false,
        causes: ["refresh", "influences_changed", "reuse_unavailable"],
        refreshScope: "selected",
        changedComponents: [{ name: "inputs" }],
        artifact: { code: "artifact_not_found" },
        error: { code: "influence_unavailable", file: "source.txt" },
      },
    },
    components: null,
    fingerprint: null,
    error: { code: "influence_unavailable" },
  });
});
