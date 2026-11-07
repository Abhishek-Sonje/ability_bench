import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateRunPair,
  FileEvaluationReceiptStore,
  loadWorkflowConfig,
  runWorkflow,
} from "abilitybench";
import suite from "./evaluation.ts";

const { workflow, storageDir } = await loadWorkflowConfig(
  fileURLToPath(new URL("./abilitybench.config.ts", import.meta.url)),
);
const records = ["alpha", "beta", "gamma"];
const inputs = { records, trusted: [...records], eligible: [...records] };
const baseline = await runWorkflow(workflow, { inputs, baseline: null, storageDir });
const selection = { runId: baseline.manifest.id };
const unchanged = await runWorkflow(workflow, { inputs, baseline: selection, storageDir });
const regressed = await runWorkflow(workflow, {
  inputs: { ...inputs, eligible: ["alpha"] },
  baseline: selection,
  storageDir,
});
assert.equal(
  unchanged.manifest.stages.every(({ finalDecision }) => finalDecision === "reuse"),
  true,
);
assert.deepEqual(
  Object.fromEntries(
    regressed.manifest.stages.map(({ stageId, decisionReason }) => [stageId, decisionReason]),
  ),
  {
    inventory: "fingerprint_match",
    evidence: "fingerprint_match",
    feasibility: "fingerprint_changed",
    report: "dependency_executed",
  },
);
const paths = [baseline, unchanged, regressed].map(({ manifest }) =>
  join(storageDir, "runs", `${manifest.id}.json`),
);
const before = await Promise.all(paths.map((path) => readFile(path)));
const store = new FileEvaluationReceiptStore(storageDir);
const outcomes = [];
for (const [scenario, candidate, criteria, expectedEvaluation, expectedComparison] of [
  [
    "unchanged",
    unchanged,
    { minimumEvidence: 2, minimumCandidates: 2 },
    "passed",
    "no_regressions",
  ],
  [
    "intentional-regression",
    regressed,
    { minimumEvidence: 2, minimumCandidates: 2 },
    "failed",
    "regressed",
  ],
  [
    "both-fail-stricter-criterion",
    regressed,
    { minimumEvidence: 2, minimumCandidates: 4 },
    "failed",
    "no_regressions",
  ],
]) {
  const receipt = await evaluateRunPair(suite, {
    baselineRunId: baseline.manifest.id,
    candidateRunId: candidate.manifest.id,
    criteria,
    storageDir,
  });
  assert.equal(receipt.evaluationStatus, expectedEvaluation);
  assert.equal(receipt.comparisonStatus, expectedComparison);
  assert.equal(candidate.manifest.executionStatus, "completed");
  assert.deepEqual(await store.get(receipt.id), receipt);
  outcomes.push({ scenario, receipt });
  console.log(
    `${scenario}: execution=${candidate.manifest.executionStatus}; evaluation=${receipt.evaluationStatus}; comparison=${receipt.comparisonStatus}`,
  );
  for (const check of receipt.checks) {
    console.log(
      `  ${check.checkId}: ${check.baseline.verdict} -> ${check.candidate.verdict} (${check.comparison}); actual=${check.candidate.details.actual}, required=${check.candidate.details.required}`,
    );
  }
}
assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), before);
assert.equal(
  outcomes[0].receipt.checks.every(
    ({ baseline, candidate }) => baseline.fingerprint === candidate.fingerprint,
  ),
  true,
);
const reviewPath = join(storageDir, "demo-results.json");
await writeFile(
  reviewPath,
  `${JSON.stringify({ baseline: baseline.manifest, unchanged: unchanged.manifest, regressed: regressed.manifest, outcomes }, null, 2)}\n`,
);
console.log("All demo assertions passed. Execution manifests remain unchanged.");
console.log(`Verified receipts and source artifacts retained in: ${storageDir}`);
console.log(`Review: ${reviewPath}`);
