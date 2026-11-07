import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "../src/artifact-store.js";
import { executeWorkflow } from "../src/execution.js";
import { type BaselineRun, planWorkflow } from "../src/planning.js";
import type { StageFunction } from "../src/types.js";
import { defineWorkflow } from "../src/workflow.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workflowFixture(functions: Partial<Record<string, StageFunction>> = {}) {
  const root = await mkdtemp(join(tmpdir(), "abilitybench-execute-"));
  roots.push(root);
  const graph = {
    seed: [],
    left: ["seed"],
    right: ["seed"],
    join: ["left", "right"],
    report: ["join"],
    z_independent: [],
  } as const;
  const builder = defineWorkflow({ id: "execution-example", root });
  for (const [id, dependsOn] of Object.entries(graph)) {
    await writeFile(join(root, `${id}.ts`), `${id}\n`, "utf8");
    builder.stage({
      id,
      dependsOn,
      implementation: `${id}-v1`,
      watch: [`${id}.ts`],
      inputs: id === "seed" ? ["/value"] : [],
      env: [],
      cache: true,
      run:
        functions[id] ??
        (({ dependencies, inputs }) => ({
          id,
          dependencyIds: Object.keys(dependencies).sort(),
          selected: inputs["/value"] ?? null,
        })),
    });
  }
  return builder.build();
}

function baselineFrom(result: Awaited<ReturnType<typeof executeWorkflow>>): BaselineRun {
  return {
    id: "run_baseline",
    manifestHash: `sha256:${"b".repeat(64)}`,
    workflowId: result.workflowId,
    executionStatus: "completed",
    stages: result.stages.map((stage) => ({
      stageId: stage.stageId,
      dependencyIds: [],
      fingerprint: stage.fingerprint as string,
      componentHashes: stage.componentHashes as NonNullable<typeof stage.componentHashes>,
      executionStatus: stage.executionStatus === "reused" ? "reused" : "succeeded",
      outputArtifactHash: stage.outputArtifactHash,
      artifactAvailable: true,
    })),
  };
}

describe("workflow execution", () => {
  it("executes in topological order with only direct dependency outputs", async () => {
    const calls: string[] = [];
    const workflow = await workflowFixture({
      join: ({ dependencies }) => {
        calls.push(...Object.keys(dependencies).sort());
        return { joined: Object.keys(dependencies).sort() };
      },
    });
    const plan = await planWorkflow({
      workflow,
      inputs: { value: 42 },
      environment: {},
      baseline: null,
      invalidate: [],
    });
    const result = await executeWorkflow({
      workflow,
      plan,
      inputs: { value: 42 },
      environment: {},
      artifacts: new InMemoryArtifactStore(),
    });

    expect(result.executionStatus).toBe("completed");
    expect(result.evaluationStatus).toBe("not_run");
    expect(result.stages.every(({ executionStatus }) => executionStatus === "succeeded")).toBe(
      true,
    );
    expect(calls).toEqual(["left", "right"]);
  });

  it("reuses a complete baseline without calling stage functions", async () => {
    const workflow = await workflowFixture();
    const store = new InMemoryArtifactStore();
    const firstPlan = await planWorkflow({
      workflow,
      inputs: {},
      environment: {},
      baseline: null,
      invalidate: [],
    });
    const first = await executeWorkflow({
      workflow,
      plan: firstPlan,
      inputs: {},
      environment: {},
      artifacts: store,
    });
    const baseline = baselineFrom(first);
    const secondPlan = await planWorkflow({
      workflow,
      inputs: {},
      environment: {},
      baseline,
      invalidate: [],
    });
    const second = await executeWorkflow({
      workflow,
      plan: secondPlan,
      inputs: {},
      environment: {},
      artifacts: store,
    });

    expect(second.stages.every(({ executionStatus }) => executionStatus === "reused")).toBe(true);
  });

  it("rechecks watched files before using a planned artifact", async () => {
    const workflow = await workflowFixture();
    const store = new InMemoryArtifactStore();
    const firstPlan = await planWorkflow({
      workflow,
      inputs: {},
      environment: {},
      baseline: null,
      invalidate: [],
    });
    const first = await executeWorkflow({
      workflow,
      plan: firstPlan,
      inputs: {},
      environment: {},
      artifacts: store,
    });
    const plan = await planWorkflow({
      workflow,
      inputs: {},
      environment: {},
      baseline: baselineFrom(first),
      invalidate: [],
    });
    await writeFile(join(workflow.root, "left.ts"), "changed after planning\n", "utf8");
    const result = await executeWorkflow({
      workflow,
      plan,
      inputs: {},
      environment: {},
      artifacts: store,
    });
    expect(result.stages.find(({ stageId }) => stageId === "left")).toMatchObject({
      plannedDecision: "reuse",
      finalDecision: "execute",
      decisionReason: "fingerprint_changed",
    });
    expect(result.stages.find(({ stageId }) => stageId === "join")?.decisionReason).toBe(
      "dependency_executed",
    );
  });

  it("records a late invalid watched path as execution failure", async () => {
    const workflow = await workflowFixture();
    const store = new InMemoryArtifactStore();
    const firstPlan = await planWorkflow({
      workflow,
      inputs: {},
      environment: {},
      baseline: null,
      invalidate: [],
    });
    const first = await executeWorkflow({
      workflow,
      plan: firstPlan,
      inputs: {},
      environment: {},
      artifacts: store,
    });
    const plan = await planWorkflow({
      workflow,
      inputs: {},
      environment: {},
      baseline: baselineFrom(first),
      invalidate: [],
    });
    await rm(join(workflow.root, "left.ts"));
    await mkdir(join(workflow.root, "left.ts"));
    const result = await executeWorkflow({
      workflow,
      plan,
      inputs: {},
      environment: {},
      artifacts: store,
    });
    expect(result.executionStatus).toBe("failed");
    expect(result.stages.find(({ stageId }) => stageId === "left")).toMatchObject({
      plannedDecision: "reuse",
      finalDecision: "execute",
      executionStatus: "failed",
      error: { name: "FingerprintInputError" },
    });
    expect(result.stages.find(({ stageId }) => stageId === "join")?.executionStatus).toBe(
      "skipped_dependency_failed",
    );
  });
});
