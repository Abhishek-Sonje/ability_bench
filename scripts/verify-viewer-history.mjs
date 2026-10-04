import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ViewerData } from "../dist/viewer-data.js";
import { layout } from "../viewer/model.js";

// Explicit retained store only. This verification tool never runs workflows or writes history.
const [storage, workflowId] = process.argv.slice(2);
if (!storage || !workflowId || process.argv.length !== 4)
  throw new Error("Usage: node scripts/verify-viewer-history.mjs <store> <workflow-id>");
const root = resolve(storage);
async function snapshot() {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Verification expects physical retained storage.");
    result.push([
      path,
      entry.isDirectory()
        ? "directory"
        : createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
    ]);
  }
  return JSON.stringify(result.sort(([left], [right]) => left.localeCompare(right)));
}
const before = await snapshot();
const data = new ViewerData(root, workflowId);
const history = await data.history();
const counts = {
  reused: 0,
  succeeded: 0,
  failed: 0,
  skipped_dependency_failed: 0,
  skipped_run_stopped: 0,
};
let previews = 0;
let oversized = 0;
const baselines = new Set();
for (const summary of history.runs) {
  const { candidate, baseline } = await data.run(summary.id);
  if (baseline) baselines.add(baseline.id);
  layout([...candidate.stages]);
  for (const stage of candidate.stages) {
    if (stage.executionStatus in counts) counts[stage.executionStatus]++;
    const output = await data.artifact(candidate.id, stage.stageId);
    if (output.verification === "verified") previews++;
    if (output.verification === "not_previewed") oversized++;
  }
}
let receipts = 0;
const evaluationResults = [];
let entries;
try {
  entries = await readdir(join(root, "evaluations"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  entries = [];
}
for (const name of entries.filter((name) => /^eval_[a-f0-9]{64}\.json$/.test(name))) {
  const metadata = JSON.parse(await readFile(join(root, "evaluations", name), "utf8"));
  if (metadata.workflowId !== workflowId) continue;
  const receipt = await data.receipt(metadata.candidate.runId, name.slice(0, -5));
  receipts++;
  evaluationResults.push({
    evaluation: receipt.evaluationStatus,
    regression: receipt.comparisonStatus,
  });
}
if ((await snapshot()) !== before) throw new Error("Retained store changed during verification.");
console.log(
  JSON.stringify(
    {
      workflowId,
      runs: history.runs.length,
      immutableBaselines: baselines.size,
      stageStatuses: counts,
      verifiedPreviews: previews,
      oversizedPreviewsNotRead: oversized,
      receipts,
      evaluationResults,
      storageUnchanged: true,
      browserVerified: false,
    },
    null,
    2,
  ),
);
