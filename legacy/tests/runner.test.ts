import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defineWorkflow,
  FileRunManifestStore,
  planWorkflowRun,
  runWorkflow,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench-runner-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  for (const id of ["seed", "left", "right", "join", "report", "independent"]) {
    await writeFile(join(root, "src", `${id}.ts`), `${id}-v1\n`, "utf8");
  }
  const calls: string[] = [];
  const builder = defineWorkflow({ id: "runner-example", root });
  const add = (id: string, dependsOn: string[]) => {
    builder.stage({
      id,
      dependsOn,
      implementation: `${id}-v1`,
      watch: [`src/${id}.ts`],
      inputs: [],
      env: [],
      cache: true,
      run: ({ dependencies }) => {
        calls.push(id);
        return { id, dependencyIds: Object.keys(dependencies).sort() };
      },
    });
  };
  add("seed", []);
  add("left", ["seed"]);
  add("right", ["seed"]);
  add("join", ["left", "right"]);
  add("report", ["join"]);
  add("independent", []);
  return { root, workflow: builder.build(), calls };
}

describe("runWorkflow", () => {
  it("plans without executing stages or creating storage", async () => {
    const { root, workflow, calls } = await fixture();
    const result = await planWorkflowRun(workflow, {
      inputs: {},
      baseline: null,
      environment: {},
    });

    expect(calls).toEqual([]);
    expect(result.plan.decisions).toHaveLength(6);
    expect(
      result.plan.decisions.every(
        ({ decision, reason }) => decision === "execute" && reason === "no_baseline",
      ),
    ).toBe(true);
    await expect(stat(join(root, ".abilitybench"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("plans against a verified baseline without persisting a candidate", async () => {
    const { root, workflow, calls } = await fixture();
    const baseline = await runWorkflow(workflow, { inputs: {}, baseline: null, environment: {} });
    calls.length = 0;
    await writeFile(join(root, "src", "left.ts"), "left-v2\n", "utf8");
    const store = new FileRunManifestStore(join(root, ".abilitybench"));
    const beforeIds = (await store.list()).map(({ id }) => id);

    const result = await planWorkflowRun(workflow, {
      inputs: {},
      baseline: { runId: baseline.manifest.id },
      environment: {},
    });

    expect(calls).toEqual([]);
    expect((await store.list()).map(({ id }) => id)).toEqual(beforeIds);
    expect(
      Object.fromEntries(
        result.plan.decisions.map(({ stageId, decision, reason }) => [
          stageId,
          { decision, reason },
        ]),
      ),
    ).toMatchObject({
      seed: { decision: "reuse", reason: "fingerprint_match" },
      left: { decision: "execute", reason: "fingerprint_changed" },
      right: { decision: "reuse", reason: "fingerprint_match" },
      join: { decision: "execute", reason: "dependency_executed" },
      report: { decision: "execute", reason: "dependency_executed" },
      independent: { decision: "reuse", reason: "fingerprint_match" },
    });
  });

  it("persists a full run and reuses it from one explicit baseline", async () => {
    const { root, workflow, calls } = await fixture();
    const first = await runWorkflow(workflow, { inputs: {}, baseline: null, environment: {} });
    expect(first.execution.executionStatus).toBe("completed");
    expect(calls).toHaveLength(6);
    expect(
      await new FileRunManifestStore(join(root, ".abilitybench")).get(first.manifest.id),
    ).toEqual(first.manifest);

    calls.length = 0;
    const second = await runWorkflow(workflow, {
      inputs: {},
      baseline: { runId: first.manifest.id },
      environment: {},
    });
    expect(calls).toEqual([]);
    expect(second.manifest.baselineRunId).toBe(first.manifest.id);
    expect(
      second.execution.stages.every(({ executionStatus }) => executionStatus === "reused"),
    ).toBe(true);
  });

  it("reruns only the changed branch and descendants", async () => {
    const { root, workflow, calls } = await fixture();
    const baseline = await runWorkflow(workflow, { inputs: {}, baseline: null, environment: {} });
    calls.length = 0;
    await writeFile(join(root, "src", "left.ts"), "left-v2\n", "utf8");

    const candidate = await runWorkflow(workflow, {
      inputs: {},
      baseline: { runId: baseline.manifest.id },
      environment: {},
    });
    expect(calls).toEqual(["left", "join", "report"]);
    const joinStage = candidate.manifest.stages.find(({ stageId }) => stageId === "join");
    expect(Object.isFrozen(joinStage?.decisionDetails)).toBe(true);
    expect(Object.isFrozen(Object.values(joinStage?.decisionDetails ?? {})[0])).toBe(true);
    expect(
      Object.fromEntries(
        candidate.execution.stages.map(({ stageId, decisionReason }) => [stageId, decisionReason]),
      ),
    ).toMatchObject({
      independent: "fingerprint_match",
      seed: "fingerprint_match",
      left: "fingerprint_changed",
      right: "fingerprint_match",
      join: "dependency_executed",
      report: "dependency_executed",
    });
  });

  it("keeps sibling candidates anchored to the same immutable baseline", async () => {
    const { workflow, calls } = await fixture();
    const baseline = await runWorkflow(workflow, { inputs: {}, baseline: null, environment: {} });
    calls.length = 0;
    const leftCandidate = await runWorkflow(workflow, {
      inputs: {},
      baseline: { runId: baseline.manifest.id },
      invalidate: ["left"],
      environment: {},
    });
    expect(calls).toEqual(["left", "join", "report"]);
    calls.length = 0;
    const rightCandidate = await runWorkflow(workflow, {
      inputs: {},
      baseline: { runId: baseline.manifest.id },
      invalidate: ["right"],
      environment: {},
    });
    expect(calls).toEqual(["right", "join", "report"]);
    expect(leftCandidate.manifest.baselineRunId).toBe(baseline.manifest.id);
    expect(rightCandidate.manifest.baselineRunId).toBe(baseline.manifest.id);
    expect(leftCandidate.manifest.baselineManifestHash).toBe(baseline.manifest.manifestHash);
    expect(rightCandidate.manifest.baselineManifestHash).toBe(baseline.manifest.manifestHash);
    expect(rightCandidate.manifest.stages.find(({ stageId }) => stageId === "left")).toMatchObject({
      finalDecision: "reuse",
      decisionReason: "fingerprint_match",
    });
  });

  it("rejects a missing baseline before executing stages", async () => {
    const { workflow, calls } = await fixture();
    await expect(
      runWorkflow(workflow, {
        inputs: {},
        baseline: { runId: `run_${"0".repeat(64)}` },
        environment: {},
      }),
    ).rejects.toMatchObject({ code: "baseline_not_found" });
    expect(calls).toEqual([]);
  });

  it("rejects a storage path outside the workflow root before execution", async () => {
    const { workflow, calls } = await fixture();
    await expect(
      runWorkflow(workflow, { inputs: {}, baseline: null, storageDir: "../outside" }),
    ).rejects.toMatchObject({ code: "storage_path_escaped" });
    expect(calls).toEqual([]);
  });

  it("rejects a non-object run input before execution", async () => {
    const { workflow, calls } = await fixture();
    await expect(
      runWorkflow(workflow, {
        inputs: [] as unknown as Record<string, never>,
        baseline: null,
      }),
    ).rejects.toMatchObject({ code: "invalid_inputs" });
    expect(calls).toEqual([]);
  });

  it("rejects a watched path inside the default or configured storage directory", async () => {
    const { root, calls } = await fixture();
    for (const storageDir of [".abilitybench", "results"]) {
      const workflow = defineWorkflow({ id: "storage-watch", root })
        .stage({
          id: "watched",
          dependsOn: [],
          implementation: "v1",
          watch: [`${storageDir}/artifact.json`],
          inputs: [],
          env: [],
          cache: true,
          run: () => {
            calls.push("watched");
            return null;
          },
        })
        .build();
      await expect(
        runWorkflow(workflow, { inputs: {}, baseline: null, storageDir }),
      ).rejects.toMatchObject({ code: "storage_path_watched" });
    }
    expect(calls).toEqual([]);
  });
});
