// Destructive negative cases belong only to disposable tests; this real-project check restores edits.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateRunPair, FileRunManifestStore, runWorkflow } from "../../dist/index.js";

const [rootArg, baselineId] = process.argv.slice(2);
assert(rootArg && baselineId, "Usage: verify.mjs <isolated-project> <baseline-id>");
const root = resolve(rootArg);
assert(
  JSON.parse(await readFile(join(root, "capture.json"), "utf8")).mode === "mocked-existing-agent",
);
globalThis.fetch = async () => {
  throw new Error("No network during independent-agent verification.");
};
const { build, evaluation } = await import(pathToFileURL(join(root, "workflow.mjs")).href);
const store = new FileRunManifestStore(join(root, ".abilitybench"));
const before = JSON.stringify(await store.get(baselineId));
assert(before !== undefined);
const options = {
  baseline: { runId: baselineId },
  inputs: { snapshotReadRevision: "snapshot-v1", publish: false },
};
const summarize = (name, run) => ({
  name,
  id: run.manifest.id,
  status: run.manifest.executionStatus,
  stages: run.manifest.stages.map(({ stageId, executionStatus, decisionReason }) => ({
    stageId,
    executionStatus,
    decisionReason,
  })),
});
const results = [];
const writer = join(root, "upstream/core/writer.js");
const originalWriter = await readFile(writer, "utf8");
const sources = join(root, "sourceFiles.json");
const originalSources = await readFile(sources, "utf8");
try {
  await writeFile(
    writer,
    `${originalWriter}\n// Isolated downstream storage implementation revision.\n`,
  );
  const changedWriter = await runWorkflow(build(root), options);
  assert(changedWriter.manifest.stages.filter((s) => s.executionStatus === "reused").length === 6);
  results.push(summarize("writer-only-revision", changedWriter));
  const quality = await evaluateRunPair(evaluation(root), {
    baselineRunId: baselineId,
    candidateRunId: changedWriter.manifest.id,
    criteria: {},
  });
  assert(quality.evaluationStatus === "passed" && quality.comparisonStatus === "no_regressions");
  const publish = await runWorkflow(build(root), {
    ...options,
    inputs: { ...options.inputs, publish: true },
    environment: { ARCHIE_EXAMPLE_OUTPUT: join(root, "published") },
  });
  assert(publish.manifest.executionStatus === "completed");
  assert.equal(
    await readFile(join(root, "published/ARCHITECTURE.md"), "utf8"),
    await readFile(join(root, "architecture.md"), "utf8"),
  );
  results.push(summarize("isolated-original-writer", publish));
  const changed = JSON.parse(originalSources);
  changed[0].content += "\n// Isolated invalidation probe.\n";
  await writeFile(sources, JSON.stringify(changed));
  const stale = await runWorkflow(build(root), options);
  assert(stale.manifest.executionStatus === "failed");
  assert(
    stale.manifest.stages.find((s) => s.stageId === "architecture").executionStatus === "failed",
  );
  results.push(summarize("changed-source-rejects-stale-acquisition", stale));
  await writeFile(sources, originalSources);
  const manual = await runWorkflow(build(root), { ...options, invalidate: ["architecture"] });
  assert(manual.manifest.executionStatus === "completed");
  results.push(summarize("manual-snapshot-revalidation", manual));
} finally {
  await writeFile(writer, originalWriter);
  await writeFile(sources, originalSources);
}
assert.equal(JSON.stringify(await store.get(baselineId)), before);
process.stdout.write(
  `${JSON.stringify({ results, baselineUnchanged: true, originalWriterBytesMatch: true, providerCalls: 0 })}\n`,
);
