// biome-ignore-all lint/complexity/useLiteralKeys: TypeScript requires index access for dynamic error metadata.
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareExecution } from "../src/execution.js";
import {
  AbilityBenchError,
  createWorkflow,
  type JsonValue,
  openHistory,
  prepare,
  stage,
} from "../src/index.js";

const OUTPUT_LIMIT = 16 * 1024 * 1024;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function root() {
  const p = await mkdtemp(join(tmpdir(), "abilitybench write bounds "));
  roots.push(p);
  return p;
}
it.each([0, 1])(
  "enforces exact and one-byte-over 16 MiB serialized payload (%i)",
  async (extra) => {
    const r = await root();
    let calls = 0;
    const s = stage({
      id: "large",
      run: () => {
        calls++;
        return "x".repeat(OUTPUT_LIMIT - 2 + extra);
      },
    });
    let consumed = 0;
    const consumer = stage({
      id: "consumer",
      dependencies: { s },
      run: ({ dependencies }) => {
        consumed++;
        return dependencies.s.length;
      },
    });
    const result = await (
      await prepare(createWorkflow({ id: "bounds", root: r, stages: [s, consumer] }), {
        baseline: null,
      })
    ).execute();
    expect(calls).toBe(1);
    if (extra === 0) {
      expect(consumed).toBe(1);
      expect(result.status).toBe("completed");
      expect(result.stages[0]?.output?.byteLength).toBe(OUTPUT_LIMIT);
      expect(
        ((await openHistory(join(r, ".abilitybench")).output(result.runId, "large")) as string)
          .length,
      ).toBe(OUTPUT_LIMIT - 2);
    } else {
      expect(consumed).toBe(0);
      expect(result.stages[1]?.actual.reason).toBe("dependency_blocked");
      expect(result.status).toBe("failed");
      expect(result.stages[0]).toMatchObject({
        output: null,
        error: {
          code: "output_limit_exceeded",
          limit: OUTPUT_LIMIT,
          actualBytes: OUTPUT_LIMIT + 1,
        },
      });
      await expect(stat(join(r, ".abilitybench", "objects"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  },
  20000,
);
it("accepts an exact 2 MiB final record and rejects one extra metadata byte", async () => {
  const r = await root();
  const history = join(r, ".abilitybench");
  const limit = 2 * 1024 * 1024;
  async function prepared(bindingLength: number) {
    const seed = stage({ id: "seed", run: () => null });
    const wide = stage({
      id: "wide",
      dependencies: Object.fromEntries([["x".repeat(bindingLength), seed]]),
      run: () => null,
    });
    return prepare(createWorkflow({ id: "bounds", root: r, stages: [seed, wide] }), {
      baseline: null,
    });
  }
  async function recordSize(runId: string) {
    return (await stat(join(history, "runs", `${runId}.json`))).size;
  }

  // Vary only the binding metadata. The SDK-generated envelope is included in the measured size.
  const calibration = await (await prepared(1)).execute();
  const exactLength = limit - (await recordSize(calibration.runId)) + 1;
  const exact = await (await prepared(exactLength)).execute();
  expect(await recordSize(exact.runId)).toBe(limit);
  expect((await openHistory(history).run(exact.runId)).id).toBe(exact.runId);

  const overflow = await prepared(exactLength + 1);
  const rejected = overflow.execute();
  await expect(rejected).rejects.toMatchObject({
    code: "finalization_failed",
    causeCode: "record_limit_exceeded",
    attemptId: expect.any(String),
    runId: expect.stringMatching(/^run_/),
    limit,
    actualBytes: limit + 1,
    status: "not_published",
  });
  const error = await rejected.catch((reason: AbilityBenchError) => reason);
  if (!(error instanceof AbilityBenchError) || !error.runId) throw new Error("Missing run ID");
  await expect(openHistory(history).run(error.runId)).rejects.toMatchObject({
    code: "run_not_found",
  });
  expect(await openHistory(history).runs()).toHaveLength(2);
  await expect(overflow.execute()).rejects.toMatchObject({ code: "prepared_execution_used" });
});

it("reports staged final-record schema failure with known identity and sanitized context", async () => {
  const r = await root();
  const history = join(r, ".abilitybench");
  const prepared = await prepareExecution(
    createWorkflow({ id: "bad-record", root: r, stages: [] }),
    { baseline: null },
    { staged: async (file) => writeFile(file, '{"secret":"never report this"}') },
  );
  const rejected = prepared.execute();
  await expect(rejected).rejects.toMatchObject({
    code: "finalization_failed",
    operation: "finalize",
    reason: "corrupt_record",
    status: "not_published",
    attemptId: expect.any(String),
    runId: expect.stringMatching(/^run_/),
  });
  const error = await rejected.catch((reason: AbilityBenchError) => reason);
  if (!(error instanceof AbilityBenchError) || !error.runId) throw new Error("Missing run ID");
  expect(JSON.stringify(error)).not.toContain("never report this");
  await expect(openHistory(history).run(error.runId)).rejects.toMatchObject({
    code: "run_not_found",
  });
  expect(await openHistory(history).runs()).toEqual([]);
});
it("reports uncertain acknowledgment after actual record publication and permits direct reconciliation", async () => {
  const r = await root();
  const s = stage({ id: "source", run: () => null });
  const p = await prepareExecution(
    createWorkflow({ id: "uncertain", root: r, stages: [s] }),
    { baseline: null },
    {
      linked: async (file) => {
        if (basename(dirname(file)) === "runs")
          throw Object.assign(new Error("lost acknowledgment"), { code: "EIO" });
      },
    },
  );
  const rejected = p.execute();
  await expect(rejected).rejects.toMatchObject({
    code: "finalization_failed",
    operation: "finalize",
    causeCode: "EIO",
    reason: "publication_failed",
    status: "uncertain",
    attemptId: expect.any(String),
    runId: expect.stringMatching(/^run_/),
  });
  const error = await rejected.catch((reason: AbilityBenchError) => reason);
  if (!(error instanceof AbilityBenchError) || !error.runId) throw new Error("Missing run ID");
  expect(JSON.stringify(error)).not.toContain("lost acknowledgment");
  const history = openHistory(join(r, ".abilitybench"));
  expect(await history.run(error.runId)).toMatchObject({
    id: error.runId,
    attemptId: error.attemptId,
    status: "completed",
  });
  expect(await history.output(error.runId, "source")).toBeNull();
  await expect(p.execute()).rejects.toMatchObject({ code: "prepared_execution_used" });
});
it("fails output publication after callback without retry and retains prior outputs", async () => {
  const r = await root();
  let calls = 0;
  const a = stage({ id: "first", run: () => 1 });
  const b = stage({
    id: "second",
    run: () => {
      calls++;
      return 2;
    },
  });
  let published = 0;
  const p = await prepareExecution(
    createWorkflow({ id: "publish-failure", root: r, stages: [a, b] }),
    { baseline: null },
    {
      linked: async (file) => {
        if (!file.endsWith(".json") && ++published === 2)
          throw Object.assign(new Error("I/O"), { code: "EIO" });
      },
    },
  );
  const result = await p.execute();
  expect(result.status).toBe("failed");
  expect(calls).toBe(1);
  expect(result.stages[1]?.error?.["code"]).toBe("publication_failed");
  expect(await openHistory(join(r, ".abilitybench")).output(result.runId, "first")).toBe(1);
});
it("leaves a conservatively blocked lock when owner-token writing fails", async () => {
  const r = await root();
  const p = await prepareExecution(
    createWorkflow({ id: "owner", root: r, stages: [] }),
    { baseline: null },
    {
      beforeOwner: async (lock) => {
        await mkdir(join(lock, "owner.json"));
      },
    },
  );
  const rejected = p.execute();
  await expect(rejected).rejects.toMatchObject({
    code: "finalization_failed",
    operation: "finalize",
    causeCode: expect.stringMatching(/EEXIST|EISDIR/),
    reason: "publication_failed",
    status: "not_published",
    attemptId: expect.any(String),
    runId: expect.stringMatching(/^run_/),
  });
  const error = await rejected.catch((reason: AbilityBenchError) => reason);
  if (!(error instanceof AbilityBenchError) || !error.runId) throw new Error("Missing run ID");
  const history = openHistory(join(r, ".abilitybench"));
  await expect(history.run(error.runId)).rejects.toMatchObject({ code: "run_not_found" });
  expect(await history.runs()).toEqual([]);
  expect((await stat(join(r, ".abilitybench", "writer-lock"))).isDirectory()).toBe(true);
});
const unsupported: unknown[] = [
  undefined,
  () => null,
  Symbol(),
  1n,
  NaN,
  Infinity,
  -Infinity,
  -0,
  Array(1),
  new Date(),
  new Map(),
  Object.assign([1], { extra: 1 }),
  { [Symbol()]: 1 },
  Object.defineProperty({}, "hidden", { value: 1 }),
  Object.create({ inherited: 1 }),
];
it.each(unsupported)(
  "records strict output boundary failure with stage and escaped path (%s)",
  async (value) => {
    const r = await root();
    const s = stage({ id: "bad", run: () => ({ "a~/": value }) as JsonValue });
    const result = await (
      await prepare(createWorkflow({ id: "strict", root: r, stages: [s] }), { baseline: null })
    ).execute();
    expect(result.stages[0]?.error).toMatchObject({
      code: "invalid_json_value",
      stageId: "bad",
      path: expect.stringContaining("/a~0~1"),
    });
    expect(result.stages[0]?.output).toBeNull();
  },
);
it("rejects accessors without invocation, toJSON and cycles through execution", async () => {
  const r = await root();
  let calls = 0;
  const getter = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  const stages = [
    getter,
    {
      toJSON() {
        calls++;
        return {};
      },
    },
    cycle,
  ].map((value, i) => stage({ id: `invalid-${i}`, run: () => value as JsonValue }));
  const result = await (
    await prepare(createWorkflow({ id: "descriptors", root: r, stages }), {
      baseline: null,
      failureMode: "continue-independent",
    })
  ).execute();
  expect(calls).toBe(0);
  expect(result.stages.map((s) => s.status)).toEqual(["failed", "failed", "failed"]);
});
