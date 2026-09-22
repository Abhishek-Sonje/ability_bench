import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defineWorkflow, FileRunManifestStore, runWorkflow } from "../src/index.js";

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
});
