import { createHash } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createWorkflow, openHistory, prepare, stage } from "../src/index.js";
import { fixture } from "./fixtures/history-fixture.js";
import { copyPhase0History, phase0Artifact, phase0Id } from "./fixtures/phase0-fixture.js";

it("reads original Phase 0 bytes and compares decoded values in mixed history", async () => {
  const sorted = await fixture('{"a":null,"b":[2,1]}');
  const equal = await sorted.save();
  const reversed = await fixture('{"b":[2,1],"a":null}');
  const different = await reversed.save();
  await cp(reversed.root, sorted.root, { recursive: true });
  await copyPhase0History(sorted.root);
  const history = openHistory(sorted.root);
  expect(await history.runs({ workflowId: "example" })).toEqual([
    ...[equal, different]
      .sort()
      .reverse()
      .map((id) => expect.objectContaining({ id, schemaVersion: "abilitybench-run-v2" })),
    expect.objectContaining({
      id: phase0Id,
      status: "failed",
      schemaVersion: "phase0-run-v1",
      codec: "canonical-json-v1",
      finalizedAt: "2026-09-24T00:00:00.000Z",
    }),
  ]);
  expect(await history.run(phase0Id)).toMatchObject({
    outputReferences: "unchecked",
    evaluationStatus: "not_run",
    baselineRunId: "run_7aa14bd238607e9e03591a627aee08cd75bb914a551a260e7ac7a37220715ec4",
    stages: [
      {
        stageId: "source",
        executionStatus: "reused",
        plannedDecision: "reuse",
        finalDecision: "reuse",
        decisionReason: "fingerprint_match",
        evaluationStatus: "not_run",
      },
      {
        stageId: "broken",
        dependencyIds: ["source"],
        decisionReason: "cache_disabled",
        error: { name: "Error", message: "Offline fixture failure" },
      },
      { stageId: "blocked", executionStatus: "skipped_dependency_failed" },
    ],
  });
  expect(JSON.stringify(await history.output(phase0Id, "source"))).toBe('{"a":null,"b":[2,1]}');
  await expect(history.output(phase0Id, "blocked")).rejects.toMatchObject({
    code: "output_absent",
    status: "skipped_dependency_failed",
    reason: "cache_disabled",
  });
  expect(await history.compare(phase0Id, equal, "source")).toMatchObject({
    equal: true,
    difference: null,
  });
  expect(await history.compare(different, phase0Id, "source")).toMatchObject({
    equal: false,
    difference: { path: "", reason: "object_order" },
  });
});

function hash(domain: string, bytes: string): string {
  return createHash("sha256").update(domain).update("\0").update(bytes).digest("hex");
}

async function writePhase0Variant(root: string, change: (body: string) => string) {
  const source = await readFile(join(root, "runs", `${phase0Id}.json`), "utf8");
  // Strip the two identity fields, retaining original byte order for every other field.
  const body = change(
    source.replace(/,"id":"run_[a-f0-9]{64}","manifestHash":"sha256:[a-f0-9]{64}"/, ""),
  );
  const identity = hash("abilitybench/run-manifest/v1", body);
  const id = `run_${identity}`;
  await writeFile(
    join(root, "runs", `${id}.json`),
    body.replace(
      ',"schemaVersion":',
      `,"id":"${id}","manifestHash":"sha256:${identity}","schemaVersion":`,
    ),
  );
  return id;
}

it.each([
  ['"executionStatus":"reused"', '"executionStatus":"pending"'],
  ['"dependencyIds":["source"]', '"dependencyIds":["broken"]'],
  ['"dependencyIds":["source"]', '"dependencyIds":["source","source"]'],
  ['"stageId":"broken"', '"stageId":"source"'],
  ['"decisionDetails":{}', '"decisionDetails":[]'],
  [
    '"decisionDetails":{},"decisionReason":"cache_disabled"',
    '"decisionDetails":{"changedComponents":17},"decisionReason":"fingerprint_changed"',
  ],
  [
    '"decisionDetails":{},"decisionReason":"cache_disabled"',
    '"decisionDetails":{"dependencies":[false]},"decisionReason":"dependency_executed"',
  ],
  [
    '"decisionDetails":{},"decisionReason":"cache_disabled"',
    '"decisionDetails":{"baselineExecutionStatus":"invented"},"decisionReason":"baseline_stage_not_reusable"',
  ],
  ['"decisionReason":"cache_disabled"', '"decisionReason":"invented"'],
  ['"evaluationStatus":"not_run"', '"evaluationStatus":"pending"'],
  ['"finalDecision":"reuse"', '"finalDecision":"execute"'],
  ['"fingerprint":null', '"fingerprint":"bad"'],
  ['"message":"Offline fixture failure"', '"message":42'],
  ['"completedAt":"2026-09-24T00:00:00.000Z"', '"completedAt":"2026-09-23T00:00:00.000Z"'],
])("rejects a self-hashed legacy record changed from %s to %s", async (from, to) => {
  const f = await fixture();
  await copyPhase0History(f.root);
  const id = await writePhase0Variant(f.root, (body) => body.replace(from, to));
  expect(id).not.toBe(phase0Id);
  const history = openHistory(f.root);
  await expect(history.run(id)).rejects.toMatchObject({ code: "corrupt_record", runId: id });
  await expect(history.runs({ workflowId: "unmatched", limit: 1 })).rejects.toMatchObject({
    code: "corrupt_record",
    runId: id,
  });
});

it("distinguishes unknown run and artifact formats without a partial comparison", async () => {
  const f = await fixture();
  const current = await f.save();
  await copyPhase0History(f.root);
  const history = openHistory(f.root);
  const id = await writePhase0Variant(f.root, (body) =>
    body.replace("phase0-run-v1", "future-run-v8"),
  );
  await expect(history.runs()).rejects.toMatchObject({
    code: "unsupported_history_format",
    runId: id,
  });
  const file = join(f.root, "objects", "sha256", phase0Artifact);
  const future = "abilitybench-artifact-v8\nfuture-codec\nnull";
  await writeFile(file, future);
  await expect(history.compare(current, phase0Id, "source")).rejects.toMatchObject({
    code: "unsupported_history_format",
    side: "right",
    runId: phase0Id,
  });
  expect(await readFile(file, "utf8")).toBe(future);
});

it.each([
  ['{"b":2,"a":1}', "corrupt_artifact"],
  ['{"a":1,"a":2}', "corrupt_artifact"],
  ['"\\ud800"', "corrupt_artifact"],
  ['{"10":1,"2":2}', null],
])(
  "applies original canonical-byte rules to self-hashed legacy payload %s",
  async (payload, code) => {
    const f = await fixture();
    await copyPhase0History(f.root);
    const identity = hash("abilitybench/artifact/v1", payload);
    const id = await writePhase0Variant(f.root, (body) => body.replace(phase0Artifact, identity));
    await writeFile(join(f.root, "objects", "sha256", identity), payload);
    const output = openHistory(f.root).output(id, "source");
    if (code) await expect(output).rejects.toMatchObject({ code });
    else expect(await output).toEqual({ 10: 1, 2: 2 });
  },
);

it("applies the actual 16 MiB payload bound without a header allowance for Phase 0", async () => {
  const f = await fixture();
  await copyPhase0History(f.root);
  const limit = 16 * 1024 * 1024;
  const payload = `"${"x".repeat(limit - 2)}"`;
  const identity = hash("abilitybench/artifact/v1", payload);
  const id = await writePhase0Variant(f.root, (body) => body.replace(phase0Artifact, identity));
  const file = join(f.root, "objects", "sha256", identity);
  await writeFile(file, payload);
  const history = openHistory(f.root);
  expect(((await history.output(id, "source")) as string).length).toBe(limit - 2);
  await writeFile(file, `${payload}x`);
  await expect(history.output(id, "source")).rejects.toMatchObject({
    code: "read_limit_exceeded",
    limit,
    actualBytes: limit + 1,
  });
});

it.each([
  ["abilitybench-artifact-v8\nfuture-codec\nnull", "unsupported_history_format"],
  ['{"a":null,"b":[2,1]}', "corrupt_artifact"],
])("refuses to replace unprovable bytes in a current object slot", async (bytes, code) => {
  const f = await fixture('{"a":null,"b":[2,1]}');
  await copyPhase0History(f.root);
  await writeFile(f.artifact, bytes);
  let calls = 0;
  const source = stage({
    id: "source",
    run: () => {
      calls++;
      return { a: null, b: [2, 1] };
    },
  });
  const workflow = createWorkflow({ id: "example", root: f.root, stages: [source] });
  const prepared = await prepare(workflow, { baseline: null, historyDirectory: f.root });
  const result = await prepared.execute();
  expect(result.status).toBe("failed");
  expect(result.stages[0]?.error).toMatchObject({ code });
  expect(calls).toBe(1);
  expect(await readFile(f.artifact, "utf8")).toBe(bytes);
  expect(JSON.stringify(await openHistory(f.root).output(phase0Id, "source"))).toBe(
    '{"a":null,"b":[2,1]}',
  );
});

it("skips original Phase 0 staging filenames but rejects other uncommitted entries", async () => {
  const f = await fixture();
  await copyPhase0History(f.root);
  const dir = join(f.root, "runs");
  await writeFile(join(dir, ".tmp-12345678-1234-4234-8234-123456789abc"), "interrupted");
  const history = openHistory(f.root);
  expect(await history.runs()).toMatchObject([{ id: phase0Id }]);
  await writeFile(join(dir, ".tmp-unrecognized"), "interrupted");
  await expect(history.runs()).rejects.toMatchObject({ code: "corrupt_record" });
});
