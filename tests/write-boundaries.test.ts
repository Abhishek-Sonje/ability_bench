// biome-ignore-all lint/complexity/useLiteralKeys: TypeScript requires index access for dynamic error metadata.
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareExecution } from "../src/execution.js";
import { createWorkflow, type JsonValue, openHistory, prepare, stage } from "../src/index.js";
import { OUTPUT_LIMIT } from "../src/recorded-data.js";

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
    const result = await (
      await prepare(createWorkflow({ id: "bounds", root: r, stages: [s] }), { baseline: null })
    ).execute();
    expect(calls).toBe(1);
    if (extra === 0) {
      expect(result.status).toBe("completed");
      expect(result.stages[0]?.output?.byteLength).toBe(OUTPUT_LIMIT);
      expect(
        ((await openHistory(join(r, ".abilitybench")).output(result.runId, "large")) as string)
          .length,
      ).toBe(OUTPUT_LIMIT - 2);
    } else {
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
it("record overflow throws with identity and never returns saved-history success", async () => {
  const r = await root();
  const seed = stage({ id: "seed", run: () => null });
  const s = stage({
    id: "wide",
    dependencies: Object.fromEntries([["x".repeat(2 * 1024 * 1024), seed]]),
    run: () => null,
  });
  const p = await prepare(createWorkflow({ id: "bounds", root: r, stages: [seed, s] }), {
    baseline: null,
  });
  await expect(p.execute()).rejects.toMatchObject({
    code: "finalization_failed",
    causeCode: "record_limit_exceeded",
    attemptId: expect.any(String),
    runId: expect.stringMatching(/^run_/),
    limit: 2 * 1024 * 1024,
  });
  await expect(stat(join(r, ".abilitybench", "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(p.execute()).rejects.toMatchObject({ code: "prepared_execution_used" });
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
  let identity = "";
  try {
    await p.execute();
    throw new Error("Expected finalization rejection");
  } catch (error) {
    expect(error).toMatchObject({
      code: "finalization_failed",
      causeCode: "EIO",
      reason: "publication_failed",
      status: "uncertain",
    });
    identity = (error as { runId: string }).runId;
  }
  expect(await openHistory(join(r, ".abilitybench")).output(identity, "source")).toBeNull();
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
  await expect(p.execute()).rejects.toMatchObject({
    code: "finalization_failed",
    causeCode: expect.stringMatching(/EEXIST|EISDIR/),
    reason: "publication_failed",
  });
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
