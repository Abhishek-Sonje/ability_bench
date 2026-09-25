import { describe, expect, it } from "vitest";

import workflow from "../examples/release-readiness/workflow.js";
import {
  type BaselineRun,
  executeWorkflow,
  InMemoryArtifactStore,
  planWorkflow,
} from "../src/index.js";

const readyInputs = {
  packages: ["core", "sdk", "docs"],
  signals: {
    criticalVulnerabilities: 0,
    docsCurrent: true,
    testsPassed: true,
  },
};

function baselineFrom(result: Awaited<ReturnType<typeof executeWorkflow>>): BaselineRun {
  return {
    id: "run_release_readiness",
    manifestHash: `sha256:${"b".repeat(64)}`,
    workflowId: result.workflowId,
    executionStatus: "completed",
    stages: result.stages.map((stage) => ({
      stageId: stage.stageId,
      dependencyIds: workflow.stages.find(({ id }) => id === stage.stageId)?.dependencyIds ?? [],
      fingerprint: stage.fingerprint as string,
      componentHashes: stage.componentHashes as NonNullable<typeof stage.componentHashes>,
      executionStatus: stage.executionStatus === "reused" ? "reused" : "succeeded",
      outputArtifactHash: stage.outputArtifactHash,
      artifactAvailable: true,
    })),
  };
}

describe("release-readiness example", () => {
  it("reruns only the changed security branch and its descendants", async () => {
    const artifacts = new InMemoryArtifactStore();
    const firstPlan = await planWorkflow({
      workflow,
      inputs: readyInputs,
      environment: {},
      baseline: null,
      invalidate: [],
    });
    const first = await executeWorkflow({
      workflow,
      plan: firstPlan,
      inputs: readyInputs,
      environment: {},
      artifacts,
    });
    expect(first.executionStatus).toBe("completed");

    const changedInputs = {
      ...readyInputs,
      signals: { ...readyInputs.signals, criticalVulnerabilities: 2 },
    };
    const candidatePlan = await planWorkflow({
      workflow,
      inputs: changedInputs,
      environment: {},
      baseline: baselineFrom(first),
      invalidate: [],
    });
    const candidate = await executeWorkflow({
      workflow,
      plan: candidatePlan,
      inputs: changedInputs,
      environment: {},
      artifacts,
    });

    expect(
      Object.fromEntries(
        candidate.stages.map(({ stageId, finalDecision, decisionReason }) => [
          stageId,
          [finalDecision, decisionReason],
        ]),
      ),
    ).toEqual({
      documentation: ["reuse", "fingerprint_match"],
      inventory: ["reuse", "fingerprint_match"],
      security: ["execute", "fingerprint_changed"],
      "unit-tests": ["reuse", "fingerprint_match"],
      summary: ["execute", "dependency_executed"],
      report: ["execute", "dependency_executed"],
    });
  });
});
