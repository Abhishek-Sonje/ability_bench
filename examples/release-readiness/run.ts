import { fileURLToPath } from "node:url";
import { loadWorkflowConfig, runWorkflow } from "abilitybench";

const { workflow, storageDir } = await loadWorkflowConfig(
  fileURLToPath(new URL("./abilitybench.config.ts", import.meta.url)),
);
const baselineRunId = process.argv[2];
const result = await runWorkflow(workflow, {
  inputs: {
    packages: ["core", "sdk", "docs"],
    signals: {
      criticalVulnerabilities: 0,
      docsCurrent: true,
      testsPassed: true,
    },
  },
  baseline: baselineRunId === undefined ? null : { runId: baselineRunId },
  storageDir,
});

console.log(
  JSON.stringify(
    {
      runId: result.manifest.id,
      baselineRunId: result.manifest.baselineRunId,
      executionStatus: result.manifest.executionStatus,
      stages: result.manifest.stages.map((stage) => ({
        id: stage.stageId,
        decision: stage.finalDecision,
        reason: stage.decisionReason,
      })),
    },
    null,
    2,
  ),
);
