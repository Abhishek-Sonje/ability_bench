import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateRunPair, runWorkflow } from "../../dist/index.js";

const [rootArg, baselineId = "none", publishFlag] = process.argv.slice(2);
assert(
  rootArg && (!publishFlag || publishFlag === "--publish"),
  "Usage: run.mjs <project> <baseline-id|none> [--publish]",
);
globalThis.fetch = async () => {
  throw new Error("Network disabled during snapshot execution.");
};
const root = resolve(rootArg);
const { build, evaluation } = await import(pathToFileURL(join(root, "workflow.mjs")).href);
const result = await runWorkflow(build(root), {
  baseline: baselineId === "none" ? null : { runId: baselineId },
  inputs: { snapshotReadRevision: "snapshot-v1", publish: publishFlag === "--publish" },
  environment: publishFlag ? { ARCHIE_EXAMPLE_OUTPUT: join(root, "published") } : {},
});
const receipt =
  baselineId !== "none" && result.manifest.executionStatus === "completed"
    ? await evaluateRunPair(evaluation(root), {
        baselineRunId: baselineId,
        candidateRunId: result.manifest.id,
        criteria: {},
      })
    : null;
process.stdout.write(
  `${JSON.stringify({
    runId: result.manifest.id,
    baselineRunId: result.manifest.baselineRunId,
    executionStatus: result.manifest.executionStatus,
    stages: result.manifest.stages.map(({ stageId, executionStatus, decisionReason }) => ({
      stageId,
      executionStatus,
      decisionReason,
    })),
    evaluationStatus: receipt?.evaluationStatus ?? "not_run",
    regressionStatus: receipt?.comparisonStatus ?? "not_run",
    providerCalls: 0,
  })}\n`,
);
process.exitCode =
  result.manifest.executionStatus !== "completed"
    ? 1
    : receipt && receipt.evaluationStatus !== "passed"
      ? 2
      : 0;
