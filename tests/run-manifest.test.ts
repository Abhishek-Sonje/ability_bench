import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { digest, RECORD_LIMIT, type RecordedStage, validateRun } from "../src/recorded-data.js";
import { orderedJson } from "../src/recorded-values.js";
import { finalizeRecord } from "../src/run-manifest.js";

const time = "2026-11-08T00:00:00.000Z";
function failed(message: string): RecordedStage {
  return {
    stageId: "stage",
    dependencies: [],
    policy: "always-execute",
    preview: { decision: "execute", reason: "reuse_not_enabled", details: {} },
    actual: {
      decision: "execute",
      reason: "reuse_not_enabled",
      details: { callbackInvoked: true },
    },
    status: "failed",
    fingerprint: null,
    components: null,
    output: null,
    error: { code: "callback_failed", message, operation: "callback" },
  };
}
it("uses unique attempt provenance and independently reproducible domain-separated run identity", () => {
  const a = finalizeRecord(randomUUID(), "identity", time, "fail-fast", [failed("test")]);
  const b = finalizeRecord(randomUUID(), "identity", time, "fail-fast", [failed("test")]);
  expect(a.record.id).not.toBe(b.record.id);
  const { id, recordHash, ...body } = a.record;
  expect(digest("abilitybench/run/v2", orderedJson(body))).toBe(recordHash);
  expect(id).toBe(`run_${recordHash.slice(7)}`);
  expect(() => validateRun({ ...a.record, status: "completed" }, id)).toThrow();
});
it("accepts exactly 2 MiB final record and rejects one extra byte including metadata", () => {
  const attempt = randomUUID();
  const empty = finalizeRecord(attempt, "bounds", time, "fail-fast", [failed("")]);
  const exact = finalizeRecord(attempt, "bounds", time, "fail-fast", [
    failed("x".repeat(RECORD_LIMIT - empty.bytes.length)),
  ]);
  expect(exact.bytes.length).toBe(RECORD_LIMIT);
  expect(() =>
    finalizeRecord(attempt, "bounds", time, "fail-fast", [
      failed("x".repeat(RECORD_LIMIT - empty.bytes.length + 1)),
    ]),
  ).toThrowError(
    expect.objectContaining({
      code: "record_limit_exceeded",
      limit: RECORD_LIMIT,
      actualBytes: RECORD_LIMIT + 1,
      runId: expect.stringMatching(/^run_/),
    }),
  );
});
it("publishes immutable records, deduplicates inodes and refuses altered occupied records", async () => {
  const { mkdtemp, readFile, rm, stat, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { publish } = await import("../src/filesystem-store.js");
  const root = await mkdtemp(join(tmpdir(), "abilitybench immutable record "));
  try {
    const finalized = finalizeRecord(randomUUID(), "immutable", time, "fail-fast", [
      failed("fixture"),
    ]);
    const candidate = {
      kind: "record" as const,
      identity: finalized.record.id,
      bytes: finalized.bytes,
    };
    await publish(root, candidate);
    const file = join(root, "runs", `${candidate.identity}.json`),
      before = await stat(file);
    await publish(root, candidate);
    expect((await stat(file)).ino).toBe(before.ino);
    const altered = Buffer.from(finalized.bytes.toString().replace('"fixture"', '"changed"'));
    await writeFile(file, altered);
    await expect(publish(root, candidate)).rejects.toMatchObject({ code: "corrupt_record" });
    expect(await readFile(file)).toEqual(altered);
    expect((await stat(file)).ino).toBe(before.ino);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
