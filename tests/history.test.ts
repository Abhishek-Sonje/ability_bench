// biome-ignore-all lint/complexity/useLiteralKeys: Malformed schema fixtures use index signatures.
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";

import { join } from "node:path";
import { expect, it } from "vitest";
import { openHistory } from "../src/index.js";

import { fixture } from "./fixtures/history-fixture.js";

const time = "2026-11-08T00:00:00.000Z";
const header = "abilitybench-artifact-v2\nordered-json-v1\nsha256-domain-v2\n";
const digest = (domain: string, bytes: string) =>
  `sha256:${createHash("sha256").update(`${domain}\0`).update(bytes).digest("hex")}`;
it("reads selected ordered output as fresh mutable JSON without declarations", async () => {
  const f = await fixture();
  const id = await f.save();
  const history = openHistory(f.root);
  const first = await history.output(id, "source");
  expect(Object.keys(first as object)).toEqual(["z", "a"]);
  (first as { z: number[] }).z.sort();
  expect(await history.output(id, "source")).toEqual({ z: [2, 1], a: null });
  expect((await history.run(id)).outputReferences).toBe("unchecked");
});

it("reads a successful output in a failed chained run without ancestors or irrelevant artifacts", async () => {
  const f = await fixture("null");
  f.body["status"] = "failed";
  f.body["baseline"] = {
    runId: `run_${"a".repeat(64)}`,
    recordHash: `sha256:${"a".repeat(64)}`,
    schemaVersion: "abilitybench-run-v2",
    status: "failed",
  };
  f.body.stages.push({
    ...f.body.stages[0],
    stageId: "broken",
    status: "failed",
    output: null,
    error: { code: "callback_failed", message: "offline failure", operation: "execute" },
    actual: {
      decision: "execute",
      reason: "reuse_not_enabled",
      details: { callbackInvoked: true },
    },
  });
  f.body.stages.push({
    ...f.stage,
    stageId: "blocked",
    dependencies: [{ name: "failed", stageId: "broken" }],
    status: "skipped",
    output: null,
    error: null,
    actual: { decision: "skip", reason: "dependency_blocked", details: {} },
  });
  const id = await f.save();
  expect(await openHistory(f.root).output(id, "source")).toBeNull();
  await expect(openHistory(f.root).output(id, "broken")).rejects.toMatchObject({
    code: "output_absent",
    operation: "output",
    runId: id,
    stageId: "broken",
    status: "failed",
    reason: "reuse_not_enabled",
  });
  await expect(openHistory(f.root).output(id, "blocked")).rejects.toMatchObject({
    code: "output_absent",
    status: "skipped",
    reason: "dependency_blocked",
  });
});

it.each([
  { codec: "canonical-json-v1" },
  { artifactSchema: "phase0-artifact-v1" },
  { hashScheme: "sha256-domain-v1" },
  { hash: `sha256:${"A".repeat(64)}` },
  { byteLength: "4" },
  { byteLength: -1 },
  { observedAt: "2026-11-08" },
  { origin: { attemptId: "invalid", stageId: "source" } },
])("rejects self-hashed invalid reference %j", async (change) => {
  const f = await fixture();
  f.stage["output"] = { ...(f.stage["output"] as Record<string, unknown>), ...change };
  const id = await f.save();
  await expect(openHistory(f.root).run(id)).rejects.toMatchObject({ code: "corrupt_record" });
});

it.each([
  [
    "wrong status",
    (b: Record<string, unknown>) => {
      b["status"] = "pending";
    },
  ],
  [
    "wrong timestamp",
    (b: Record<string, unknown>) => {
      b["startedAt"] = "2026-11-09T00:00:00.000Z";
    },
  ],
  [
    "wrong workflow",
    (b: Record<string, unknown>) => {
      b["workflowId"] = "../escape";
    },
  ],
  [
    "wrong UUID",
    (b: Record<string, unknown>) => {
      b["attemptId"] = "x";
    },
  ],
  [
    "non-string schema",
    (b: Record<string, unknown>) => {
      b["schemaVersion"] = null;
    },
  ],
  [
    "unsupported field",
    (b: Record<string, unknown>) => {
      b["extra"] = 1;
    },
  ],
] as const)("rejects self-hashed %s", async (_name, change) => {
  const f = await fixture();
  change(f.body);
  const id = await f.save();
  await expect(openHistory(f.root).run(id)).rejects.toMatchObject({ code: "corrupt_record" });
});

it.each([
  { status: "pending" },
  { policy: "volatile" },
  { output: null },
  { error: { code: "callback_failed", message: "x", operation: "execute" } },
  { fingerprint: `sha256:${"a".repeat(64)}` },
  { actual: { decision: "reuse", reason: "reused", details: {} } },
  { dependencies: [{ name: "missing", stageId: "absent" }] },
  { dependencies: [{ name: "self", stageId: "source" }] },
])("rejects self-hashed malformed stage %j", async (change) => {
  const f = await fixture();
  Object.assign(f.stage, change);
  const id = await f.save();
  await expect(openHistory(f.root).run(id)).rejects.toMatchObject({ code: "corrupt_record" });
});

it.each([
  '{"a":1,"a":2}',
  '{"x":-0}',
  '{"x":1e400}',
  '{ "x":1}',
  '{"2":2,"1":1}',
  '"\\u0061"',
  "null\n",
])("rejects self-hashed noncanonical artifact %s", async (payload) => {
  const f = await fixture(payload);
  const id = await f.save();
  await expect(openHistory(f.root).output(id, "source")).rejects.toMatchObject({
    code: "corrupt_artifact",
  });
});

it("distinguishes missing history, run, stage and artifact; inspection does not read artifacts", async () => {
  const f = await fixture();
  const id = await f.save();
  await expect(openHistory(join(f.root, "missing")).run(id)).rejects.toMatchObject({
    code: "history_not_found",
  });
  await expect(openHistory(f.root).run(`run_${"b".repeat(64)}`)).rejects.toMatchObject({
    code: "run_not_found",
  });
  await expect(openHistory(f.root).output(id, "absent")).rejects.toMatchObject({
    code: "stage_not_found",
  });
  await rm(f.artifact);
  expect((await openHistory(f.root).run(id)).outputReferences).toBe("unchecked");
  await expect(openHistory(f.root).output(id, "source")).rejects.toMatchObject({
    code: "artifact_not_found",
  });
  await expect(openHistory(f.root).run("../escape")).rejects.toMatchObject({
    code: "invalid_argument",
  });
});

it("accepts exactly 16 MiB payload, rejects one excess byte on actual read", async () => {
  const f = await fixture(JSON.stringify("x".repeat(16 * 1024 * 1024 - 2)));
  const id = await f.save();
  expect(((await openHistory(f.root).output(id, "source")) as string).length).toBe(
    16 * 1024 * 1024 - 2,
  );
  await writeFile(f.artifact, header + JSON.stringify("x".repeat(16 * 1024 * 1024 - 1)));
  await expect(openHistory(f.root).output(id, "source")).rejects.toMatchObject({
    code: "read_limit_exceeded",
    limit: 16 * 1024 * 1024 + Buffer.byteLength(header),
    actualBytes: 16 * 1024 * 1024 + Buffer.byteLength(header) + 1,
  });
});

it("accepts exact 2 MiB record and refuses one byte over", async () => {
  const f = await fixture();
  const stage = f.stage;
  stage["actual"] = { decision: "execute", reason: "reuse_not_enabled", details: { padding: "" } };
  const firstId = await f.save();
  const { size } = await (await import("node:fs/promises")).stat(
    join(f.root, "runs", `${firstId}.json`),
  );
  (stage["actual"] as { details: { padding: string } }).details.padding = "x".repeat(
    2 * 1024 * 1024 - size,
  );
  const id = await f.save();
  expect((await openHistory(f.root).run(id)).id).toBe(id);
  await (await import("node:fs/promises")).appendFile(join(f.root, "runs", `${id}.json`), " ");
  await expect(openHistory(f.root).run(id)).rejects.toMatchObject({
    code: "read_limit_exceeded",
    limit: 2 * 1024 * 1024,
  });
});

it("rejects self-hashed duplicate stages and duplicate bindings", async () => {
  const f = await fixture();
  f.body.stages.push({ ...f.stage });
  let id = await f.save();
  await expect(openHistory(f.root).run(id)).rejects.toMatchObject({ code: "corrupt_record" });
  f.body.stages[1] = {
    ...f.stage,
    stageId: "next",
    dependencies: [
      { name: "same", stageId: "source" },
      { name: "same", stageId: "source" },
    ],
  };
  id = await f.save();
  await expect(openHistory(f.root).run(id)).rejects.toMatchObject({ code: "corrupt_record" });
});

it("reads reusable chained output with original provenance and no ancestor reads", async () => {
  const f = await fixture('{"2":2,"9":9,"z":"\\ud800","a":[null,true]}');
  const hash = `sha256:${"a".repeat(64)}`;
  f.body["baseline"] = {
    runId: `run_${"a".repeat(64)}`,
    recordHash: hash,
    schemaVersion: "abilitybench-run-v2",
    status: "failed",
  };
  const components = {
    contract: hash,
    inputs: hash,
    dependencies: hash,
    environment: hash,
    implementation: hash,
    watchedFiles: hash,
  };
  Object.assign(f.stage, {
    policy: "reusable",
    status: "reused",
    fingerprint: digest(
      "abilitybench/fingerprint/declared-influences-v2",
      JSON.stringify({ workflowId: "example", stageId: "source", components }),
    ),
    components,
    actual: { decision: "reuse", reason: "reused", details: {} },
  });
  const id = await f.save();
  const result = await openHistory(f.root).output(id, "source");
  expect(Object.keys(result as object)).toEqual(["2", "9", "z", "a"]);
  expect(result).toEqual({ 2: 2, 9: 9, z: "\ud800", a: [null, true] });
  const collapsed = {
    "contract,inputs,dependencies,environment,implementation,watchedFiles": hash,
  };
  Object.assign(f.stage, {
    components: collapsed,
    fingerprint: digest(
      "abilitybench/fingerprint/declared-influences-v2",
      JSON.stringify({ workflowId: "example", stageId: "source", components: collapsed }),
    ),
  });
  const invalid = await f.save();
  await expect(openHistory(f.root).run(invalid)).rejects.toMatchObject({ code: "corrupt_record" });
});

it("rejects successful work consuming a failed dependency and invented error codes", async () => {
  const f = await fixture();
  f.body["status"] = "failed";
  f.body.stages.push({
    ...f.stage,
    stageId: "broken",
    status: "failed",
    output: null,
    error: { code: "invented", message: "x", operation: "execute" },
    actual: {
      decision: "execute",
      reason: "reuse_not_enabled",
      details: { callbackInvoked: true },
    },
  });
  let id = await f.save();
  await expect(openHistory(f.root).run(id)).rejects.toMatchObject({ code: "corrupt_record" });
  const broken = f.body.stages[1] as Record<string, unknown>;
  broken["error"] = { code: "callback_failed", message: "x", operation: "execute" };
  f.body.stages.push({
    ...f.stage,
    stageId: "consumer",
    dependencies: [{ name: "broken", stageId: "broken" }],
  });
  id = await f.save();
  await expect(openHistory(f.root).run(id)).rejects.toMatchObject({ code: "corrupt_record" });
});

it.each(["runId", "attemptId", "stageId"])("rejects malformed serialized error %s", async (key) => {
  const f = await fixture();
  f.body["status"] = "failed";
  Object.assign(f.stage, {
    status: "failed",
    output: null,
    error: { code: "callback_failed", message: "x", operation: "execute", [key]: "../invalid" },
    actual: {
      decision: "execute",
      reason: "reuse_not_enabled",
      details: { callbackInvoked: true },
    },
  });
  const id = await f.save();
  await expect(openHistory(f.root).run(id)).rejects.toMatchObject({ code: "corrupt_record" });
});

it.each([
  "abilitybench-artifact-v3\nordered-json-v1\nsha256-domain-v2\nnull",
  "abilitybench-artifact-v2\nordered-json-v2\nsha256-domain-v2\nnull",
  "abilitybench-artifact-v2\nfuture-codec\nsha256-domain-v2\nnull",
  "abilitybench-artifact-v2\nordered-json-v1\nfuture-hash\nnull",
  "abilitybench-artifact-v2\nordered-json-v3\n",
  "abilitybench-artifact-v2\nordered-json-v1\nsha256-domain-v3",
])("distinguishes recognizable unknown artifacts", async (bytes) => {
  const f = await fixture("null");
  const id = await f.save();
  await writeFile(f.artifact, bytes);
  await expect(openHistory(f.root).output(id, "source")).rejects.toMatchObject({
    code: "unsupported_history_format",
  });
});
it("rejects duplicate record keys, malformed UTF-8, hash mismatch and truncation without writes", async () => {
  const f = await fixture();
  const id = await f.save();
  const file = join(f.root, "runs", `${id}.json`);
  const fs = await import("node:fs/promises");
  const saved = await fs.readFile(file, "utf8");
  await writeFile(
    file,
    saved.replace('"workflowId":"example"', '"workflowId":"other","workflowId":"example"'),
  );
  await expect(openHistory(f.root).run(id)).rejects.toMatchObject({ code: "corrupt_record" });
  await writeFile(file, saved);
  for (const bytes of [
    Buffer.from([0xff]),
    Buffer.from(`${header}nul`),
    Buffer.from(`${header}"changed"`),
    Buffer.from(`${header}\ufeffnull`),
  ]) {
    await writeFile(f.artifact, bytes);
    await expect(openHistory(f.root).output(id, "source")).rejects.toMatchObject({
      code: "corrupt_artifact",
    });
    expect(await fs.readFile(f.artifact)).toEqual(bytes);
    expect(await fs.readFile(file, "utf8")).toBe(saved);
  }
});

it("lists verified summaries and distinguishes empty from missing history", async () => {
  const f = await fixture();
  expect(await openHistory(f.root).runs()).toEqual([]);
  const id = await f.save();
  expect(await openHistory(f.root).runs()).toEqual([
    expect.objectContaining({
      id,
      workflowId: "example",
      finalizedAt: time,
      status: "completed",
      baseline: null,
      schemaVersion: "abilitybench-run-v2",
    }),
  ]);
  expect(await openHistory(f.root).runs({ workflowId: "other" })).toEqual([]);
  await expect(openHistory(join(f.root, "missing")).runs()).rejects.toMatchObject({
    code: "history_not_found",
  });
});

it.each([
  ["null", "null", null],
  ["1", "2", { path: "", reason: "value" }],
  ["1", '"1"', { path: "", reason: "type" }],
  ['{"a":0,"b":1}', '{"b":2,"a":0}', { path: "", reason: "object_order" }],
  ['{"a":0}', '{"b":0}', { path: "", reason: "object_keys" }],
  ['{"a/b~":[1]}', '{"a/b~":[2]}', { path: "/a~1b~0/0", reason: "value" }],
  ["[0]", "[1,2]", { path: "", reason: "array_length" }],
])("compares complete ordered values %s and %s", async (left, right, difference) => {
  const f = await fixture(left);
  const a = await f.save();
  const g = await fixture(right);
  const b = await g.save();
  const fs = await import("node:fs/promises");
  await fs.cp(g.root, f.root, { recursive: true });
  expect(await openHistory(f.root).compare(a, b, "source")).toEqual({
    left: { runId: a, stageId: "source" },
    right: { runId: b, stageId: "source" },
    equal: difference === null,
    difference,
  });
});

it("validates both identical selections and reports the unavailable side", async () => {
  const f = await fixture();
  const id = await f.save();
  expect((await openHistory(f.root).compare(id, id, "source")).equal).toBe(true);
  await rm(f.artifact);
  await expect(openHistory(f.root).compare(id, id, "source")).rejects.toMatchObject({
    code: "artifact_not_found",
    side: "left",
    operation: "compare",
  });
});
it("sorts recorded timestamps and IDs, validates limits and scans before filtering", async () => {
  const f = await fixture();
  const a = await f.save();
  f.body["workflowId"] = "other";
  const b = await f.save();
  expect((await openHistory(f.root).runs()).map((r) => r.id)).toEqual([a, b].sort().reverse());
  f.body["finalizedAt"] = "2026-11-09T00:00:00.000Z";
  const c = await f.save();
  expect((await openHistory(f.root).runs({ limit: 1 })).map((r) => r.id)).toEqual([c]);
  for (const limit of [0, -1, 1.2, 1001, NaN])
    await expect(openHistory(f.root).runs({ limit })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  await writeFile(join(f.root, "runs", `${b}.json`), "{}");
  await expect(openHistory(f.root).runs({ workflowId: "example", limit: 1 })).rejects.toMatchObject(
    { code: "corrupt_record" },
  );
});
it("accepts 1000 records, refuses 1001 and retains direct access", async () => {
  const f = await fixture();
  const ids: string[] = [];
  for (let i = 0; i < 1000; i++) {
    f.body["workflowId"] = `workflow-${i}`;
    ids.push(await f.save());
  }
  expect(await openHistory(f.root).runs()).toHaveLength(20);
  expect(await openHistory(f.root).runs({ limit: 1000 })).toHaveLength(1000);
  f.body["workflowId"] = "workflow-extra";
  const id = await f.save();
  await expect(openHistory(f.root).runs({ workflowId: "absent", limit: 1 })).rejects.toMatchObject({
    code: "read_limit_exceeded",
    limit: 1000,
  });
  expect((await openHistory(f.root).run(id)).id).toBe(id);
  expect(await openHistory(f.root).output(id, "source")).toEqual({ z: [2, 1], a: null });
}, 30000);

it("rejects null limits and malformed runtime options with coded errors", async () => {
  const f = await fixture();
  // @ts-expect-error JavaScript callers can pass null.
  await expect(openHistory(f.root).runs({ limit: null })).rejects.toMatchObject({
    code: "invalid_argument",
  });
  // @ts-expect-error JavaScript callers can pass null.
  await expect(openHistory(f.root).runs(null)).rejects.toMatchObject({ code: "invalid_argument" });
});

it("identifies a corrupt right artifact and never equates absent outputs", async () => {
  const f = await fixture("null");
  const a = await f.save();
  const g = await fixture("true");
  const b = await g.save();
  const fs = await import("node:fs/promises");
  await fs.cp(g.root, f.root, { recursive: true });
  await writeFile(
    join(
      f.root,
      "objects",
      "abilitybench-artifact-v2",
      "sha256",
      (g.stage["output"] as { hash: string }).hash.slice(7),
    ),
    "broken",
  );
  await expect(openHistory(f.root).compare(a, b, "source")).rejects.toMatchObject({
    code: "corrupt_artifact",
    side: "right",
  });
  f.body["status"] = "failed";
  Object.assign(f.stage, {
    status: "failed",
    output: null,
    error: { code: "callback_failed", message: "fixture", operation: "execute" },
    actual: {
      decision: "execute",
      reason: "reuse_not_enabled",
      details: { callbackInvoked: true },
    },
  });
  const failed = await f.save();
  await expect(openHistory(f.root).compare(failed, failed, "source")).rejects.toMatchObject({
    code: "output_absent",
    side: "left",
    status: "failed",
  });
});
it("compares successful output from a failed chain without ancestor reads", async () => {
  const f = await fixture();
  const a = await f.save();
  f.body["status"] = "failed";
  f.body["baseline"] = {
    runId: `run_${"a".repeat(64)}`,
    recordHash: `sha256:${"a".repeat(64)}`,
    schemaVersion: "abilitybench-run-v2",
    status: "failed",
  };
  f.body.stages.push({
    ...f.stage,
    stageId: "broken",
    status: "failed",
    output: null,
    error: { code: "callback_failed", message: "fixture", operation: "execute" },
    actual: {
      decision: "execute",
      reason: "reuse_not_enabled",
      details: { callbackInvoked: true },
    },
  });
  const b = await f.save();
  expect((await openHistory(f.root).compare(a, b, "source")).equal).toBe(true);
});
it("refuses invalid run filenames and unknown scanned formats", async () => {
  const f = await fixture();
  const id = await f.save();
  await writeFile(join(f.root, "runs", "run_invalid.json"), "{}");
  await expect(openHistory(f.root).runs()).rejects.toMatchObject({ code: "corrupt_record" });
  await rm(join(f.root, "runs", "run_invalid.json"));
  await writeFile(join(f.root, "runs", `${id}.json`), '{"schemaVersion":"abilitybench-run-v9"}');
  await expect(openHistory(f.root).runs()).rejects.toMatchObject({
    code: "unsupported_history_format",
  });
});
