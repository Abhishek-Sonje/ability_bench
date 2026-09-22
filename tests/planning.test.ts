import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type BaselineRun,
  type BaselineStageRecord,
  type BuiltWorkflow,
  computeStageFingerprint,
  defineWorkflow,
  planWorkflow,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(cacheRight = true): Promise<BuiltWorkflow> {
  const root = await mkdtemp(join(tmpdir(), "abilitybench-plan-"));
  roots.push(root);
  for (const id of ["seed", "left", "right", "join", "report", "independent"]) {
    await writeFile(join(root, `${id}.ts`), `${id}-v1\n`, "utf8");
  }
  const builder = defineWorkflow({ id: "branching", root });
  const add = (id: string, dependsOn: string[], cache = true) =>
    builder.stage({
      id,
      dependsOn,
      implementation: `${id}-v1`,
      watch: [`${id}.ts`],
      inputs: [],
      env: [],
      ...(cache ? { cache: true as const } : { cache: false as const }),
      run: () => null,
    });
  add("seed", []);
  add("left", ["seed"]);
  add("right", ["seed"], cacheRight);
  add("join", ["left", "right"]);
  add("report", ["join"]);
  add("independent", []);
  return builder.build();
}

async function baselineFor(workflow: BuiltWorkflow): Promise<BaselineRun> {
  const artifactHashes = new Map<string, string>();
  const records: BaselineStageRecord[] = [];
  for (const stageId of workflow.topologicalOrder) {
    const stage = workflow.stages.find(({ id }) => id === stageId);
    if (stage === undefined) throw new Error("Missing stage fixture.");
    const dependencies = Object.fromEntries(
      stage.dependencyIds.map((id) => [id, artifactHashes.get(id) as string]),
    );
    const fingerprint = await computeStageFingerprint({
      workflowId: workflow.id,
      workflowRoot: workflow.root,
      stage,
      runInputs: {},
      environment: {},
      dependencyArtifacts: dependencies,
    });
    const outputArtifactHash = `sha256:${stageId.padEnd(64, "0").slice(0, 64)}`;
    artifactHashes.set(stageId, outputArtifactHash);
    records.push({
      stageId,
      dependencyIds: stage.dependencyIds,
      fingerprint: fingerprint.fingerprint,
      componentHashes: fingerprint.componentHashes,
      executionStatus: "succeeded",
      outputArtifactHash,
      artifactAvailable: true,
    });
  }
  return {
    id: "run_baseline",
    manifestHash: `sha256:${"b".repeat(64)}`,
    workflowId: workflow.id,
    executionStatus: "completed",
    stages: records,
  };
}

function summary(plan: Awaited<ReturnType<typeof planWorkflow>>) {
  return Object.fromEntries(
    plan.decisions.map(({ stageId, decision, reason }) => [stageId, [decision, reason]]),
  );
}

describe("conservative workflow planning", () => {
  it("executes every stage without a baseline", async () => {
    const workflow = await fixture();
    const plan = await planWorkflow({
      workflow,
      inputs: {},
      environment: {},
      baseline: null,
      invalidate: [],
    });
    expect(
      plan.decisions.every(
        ({ decision, reason }) => decision === "execute" && reason === "no_baseline",
      ),
    ).toBe(true);
  });

  it("reuses every cacheable stage when fingerprints match", async () => {
    const workflow = await fixture();
    const baseline = await baselineFor(workflow);
    const plan = await planWorkflow({
      workflow,
      inputs: {},
      environment: {},
      baseline,
      invalidate: [],
    });
    expect(
      plan.decisions.every(
        ({ decision, reason }) => decision === "reuse" && reason === "fingerprint_match",
      ),
    ).toBe(true);
    expect(plan.baselineRunId).toBe("run_baseline");
  });

  it("invalidates one branch and its join while preserving unrelated work", async () => {
    const workflow = await fixture();
    const baseline = await baselineFor(workflow);
    const plan = await planWorkflow({
      workflow,
      inputs: {},
      environment: {},
      baseline,
      invalidate: ["left"],
    });
    expect(summary(plan)).toMatchObject({
      seed: ["reuse", "fingerprint_match"],
      left: ["execute", "manual_invalidation"],
      right: ["reuse", "fingerprint_match"],
      join: ["execute", "dependency_executed"],
      report: ["execute", "dependency_executed"],
      independent: ["reuse", "fingerprint_match"],
    });
  });

  it("propagates cache-disabled execution only to descendants", async () => {
    const workflow = await fixture(false);
    const baseline = await baselineFor(workflow);
    const plan = await planWorkflow({
      workflow,
      inputs: {},
      environment: {},
      baseline,
      invalidate: [],
    });
    expect(summary(plan)).toMatchObject({
      left: ["reuse", "fingerprint_match"],
      right: ["execute", "cache_disabled"],
      join: ["execute", "dependency_executed"],
      independent: ["reuse", "fingerprint_match"],
    });
  });

  it("explains a watched-file fingerprint change", async () => {
    const workflow = await fixture();
    const baseline = await baselineFor(workflow);
    await writeFile(join(workflow.root, "left.ts"), "left-v2\n", "utf8");
    const plan = await planWorkflow({
      workflow,
      inputs: {},
      environment: {},
      baseline,
      invalidate: [],
    });
    const left = plan.decisions.find(({ stageId }) => stageId === "left");
    expect(left).toMatchObject({
      decision: "execute",
      reason: "fingerprint_changed",
      details: { changedComponents: ["watchedFiles"] },
    });
  });

  it("rejects invalid baselines and invalidation targets", async () => {
    const workflow = await fixture();
    const baseline = await baselineFor(workflow);
    await expect(
      planWorkflow({
        workflow,
        inputs: {},
        environment: {},
        baseline: { ...baseline, workflowId: "other" },
        invalidate: [],
      }),
    ).rejects.toMatchObject({ code: "baseline_workflow_mismatch" });
    await expect(
      planWorkflow({ workflow, inputs: {}, environment: {}, baseline, invalidate: ["unknown"] }),
    ).rejects.toMatchObject({ code: "unknown_invalidation_target" });
  });
});
