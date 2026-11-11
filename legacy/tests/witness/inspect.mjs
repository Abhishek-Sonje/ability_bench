import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openHistory } from "abilitybench";
import { CHANGED_PROMPT, validateStageOutput } from "./grounding.mjs";

const [historyDirectory, a, b, unavailableApp] = process.argv.slice(2);
await assert.rejects(access(unavailableApp), { code: "ENOENT" });
const installed = join(import.meta.dirname, "node_modules", "abilitybench");
const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
const cli = join(installed, manifest.bin.abilitybench);
const commands = [];
function command(args, status) {
  const result = spawnSync(
    process.execPath,
    [cli, ...args, "--history", historyDirectory, "--json"],
    {
      encoding: "utf8",
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stderr, "");
  commands.push({ args, status });
  return { text: result.stdout, value: JSON.parse(result.stdout) };
}

const list = command(["runs", "--workflow", "gemini-iteration"], 0).value;
assert.deepEqual(new Set(list.map(({ id }) => id)), new Set([a, b]));
const original = command(["inspect", a], 0).value;
const changed = command(["inspect", b], 0).value;
assert.equal(changed.baseline.runId, a);
assert.equal(changed.outputReferences, "unchecked");
assert.equal(command(["compare", a, b, "catalog"], 0).value.equal, true);
const difference = command(["compare", a, b, "report"], 1).value;
assert.deepEqual(difference.difference, { path: "/requestHash", reason: "value" });
const left = command(["output", a, "report"], 0);
const right = command(["output", b, "report"], 0);
assert.equal(left.value.text, right.value.text);
assert.notEqual(left.value.requestHash, right.value.requestHash);
assert.deepEqual(Object.keys(left.value), ["text", "requestHash", "modelVersion"]);
assert.deepEqual({ ...left.value, requestHash: right.value.requestHash }, right.value);
await writeFile("first.json", left.text);
await writeFile("changed.json", right.text);
const diff = spawnSync(
  "git",
  ["diff", "--no-index", "--exit-code", "--", "first.json", "changed.json"],
  { encoding: "utf8" },
);
assert.ifError(diff.error);
assert.equal(diff.status, 1, diff.stderr);
assert.match(diff.stdout, /requestHash/);

const history = openHistory(historyDirectory);
const catalog = await history.output(b, "catalog");
const options = await history.output(b, "options");
const risks = await history.output(b, "risks");
const report = await history.output(b, "report");
assert.deepEqual(report, right.value);
const dependencies = { catalog, options, risks };
validateStageOutput("report", report.text, dependencies, CHANGED_PROMPT);
const invalid = "Recommend Option A for budget fit.";
assert.throws(
  () => validateStageOutput("report", invalid, dependencies, CHANGED_PROMPT),
  /requires a proposed human-review safeguard/,
);

const sizes = [];
for (const run of [original, changed]) {
  const record = (await stat(join(historyDirectory, "runs", `${run.id}.json`))).size;
  assert.ok(record <= 2 * 1024 ** 2);
  const payloads = Object.fromEntries(
    run.stages.map(({ stageId, output }) => {
      assert.ok(output.byteLength <= 16 * 1024 ** 2);
      return [stageId, output.byteLength];
    }),
  );
  sizes.push({ record, payloads });
}
assert.equal(sizes[1].payloads.report, Buffer.byteLength(JSON.stringify(report)));
console.log(
  JSON.stringify({
    commands,
    original,
    changed,
    difference,
    diffExit: diff.status,
    diff: diff.stdout,
    quality: { passed: true, rejected: invalid },
    sizes,
    left: left.value,
    right: right.value,
  }),
);
