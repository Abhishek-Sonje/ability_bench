import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createWorkflow, openHistory, prepare, stage } from "abilitybench";
import { renderReport } from "./composio/analysis.js";

const [historyDirectory] = process.argv.slice(2);
// The original offline 100-app saved analysis, including its native insertion order.
const saved = JSON.parse(
  await readFile(new URL("./composio/analysis.json", import.meta.url), "utf8"),
);
assert.equal(saved.source.appCount, 100);
const original = renderReport(saved);
const tied = ["Other", "Bot token"];
const buckets = Object.keys(saved.opportunityBuckets);
assert.notDeepEqual(buckets, buckets.toSorted());
assert.ok(original.includes("| Other | 2 |\n| Bot token | 2 |"));
const bucketHeading = original.indexOf("## Opportunity buckets");
assert.ok(bucketHeading >= 0);
let previous = bucketHeading;
for (const name of buckets) {
  const position = original.indexOf(`| ${name} |`, previous + 1);
  assert.ok(position > previous, name);
  previous = position;
}

let analysisCalls = 0;
const renders = [];
const analysis = stage({
  id: "analysis",
  inputs: { saved },
  reuse: { revision: "saved-analysis-v1" },
  run: ({ inputs }) => {
    analysisCalls++;
    return inputs.saved;
  },
});
const report = stage({
  id: "report",
  dependencies: { analysis },
  run: ({ dependencies }) => {
    assert.equal(JSON.stringify(dependencies.analysis), JSON.stringify(saved));
    const markdown = renderReport(dependencies.analysis);
    renders.push(markdown);
    return markdown;
  },
});
const workflow = createWorkflow({
  id: "composio-rendering",
  root: import.meta.dirname,
  stages: [analysis, report],
});
const fresh = await (await prepare(workflow, { historyDirectory, baseline: null })).execute();
const reused = await (
  await prepare(workflow, { historyDirectory, baseline: { runId: fresh.runId } })
).execute();
assert.equal(fresh.status, "completed", JSON.stringify(fresh.stages));
assert.equal(reused.status, "completed", JSON.stringify(reused.stages));
assert.equal(reused.stages[0].actual.decision, "reuse");
assert.deepEqual(reused.stages[0].output, fresh.stages[0].output);
assert.equal(analysisCalls, 1);
assert.deepEqual(renders, [original, original]);
const history = openHistory(historyDirectory);
const historical = await history.output(reused.runId, "analysis");
assert.equal(JSON.stringify(historical), JSON.stringify(saved));
assert.equal(renderReport(historical), original);
const sizes = [];
for (const run of [fresh, reused]) {
  const record = (await stat(join(historyDirectory, "runs", `${run.runId}.json`))).size;
  assert.ok(record <= 2 * 1024 ** 2);
  const payloads = run.stages.map(({ stageId, output }) => ({ stageId, bytes: output.byteLength }));
  assert.ok(payloads.every(({ bytes }) => bytes <= 16 * 1024 ** 2));
  assert.equal(payloads[0].bytes, Buffer.byteLength(JSON.stringify(saved)));
  assert.equal(payloads[1].bytes, Buffer.byteLength(JSON.stringify(original)));
  sizes.push({ record, payloads });
}
console.log(JSON.stringify({ fresh, reused, tied, buckets, sizes }));
