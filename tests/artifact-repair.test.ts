import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareExecution } from "../src/execution.js";
import type { PublicationSchedule } from "../src/filesystem-store.js";
import { createWorkflow, openHistory, prepare, stage } from "../src/index.js";
import { HEADER, OUTPUT_LIMIT } from "../src/recorded-data.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench repair "));
  roots.push(root);
  const directory = join(root, ".abilitybench");
  const history = openHistory(directory);
  const value = { z: 3, a: ["selected"] };
  let calls = 0;
  let fail = false;
  const source = stage({
    id: "source",
    reuse: { revision: "one" },
    run: () => {
      calls++;
      if (fail) throw new Error("original failure");
      return value;
    },
  });
  const workflow = createWorkflow({ id: "repair", root, stages: [source] });
  const fresh = async () => (await prepare(workflow, { baseline: null })).execute();
  const original = await fresh();
  const ref = original.stages[0]?.output;
  if (!ref) throw new Error("Missing fixture output.");
  const file = join(directory, "objects", "abilitybench-artifact-v2", "sha256", ref.hash.slice(7));
  return {
    root,
    directory,
    history,
    value,
    original,
    ref,
    file,
    fresh,
    calls: () => calls,
    fail: (next: boolean) => {
      fail = next;
    },
    recordBytes: (id: string) => readFile(join(directory, "runs", `${id}.json`)),
    regenerate: (schedule?: PublicationSchedule) => {
      const options = { baseline: { runId: original.runId } };
      return schedule ? prepareExecution(workflow, options, schedule) : prepare(workflow, options);
    },
  };
}

const malformed = Buffer.from("abilitybench-artifact-v2\nordered-json-v1\n");
const corrupt = Buffer.from(`${HEADER}{"invalid":`);
const inode = async (path: string) => (await lstat(path, { bigint: true })).ino;

async function quarantine(directory: string) {
  const path = join(directory, "quarantine");
  const entries = await readdir(path);
  expect(entries).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/)]);
  return join(path, entries[0] ?? "");
}

it.each([
  ["malformed known header", malformed],
  ["invalid payload", corrupt],
  ["missing", null],
] as const)(
  "restores %s at the original hash while preserving older successful and failed records",
  async (_fault, badBytes) => {
    const f = await fixture();
    const reused = await (await f.regenerate()).execute();
    expect(reused.stages[0]).toMatchObject({ status: "reused", output: f.ref });
    f.fail(true);
    const failed = await f.fresh();
    expect(failed.stages[0]).toMatchObject({ status: "failed", output: null });
    f.fail(false);
    const ids = [f.original.runId, reused.runId, failed.runId];
    const records = await Promise.all(ids.map((id) => f.history.run(id)));
    const bytes = await Promise.all(ids.map(f.recordBytes));
    const good = await readFile(f.file);
    const badInode = await inode(f.file);
    if (badBytes) await writeFile(f.file, badBytes);
    else await rm(f.file);
    await expect(f.history.output(reused.runId, "source")).rejects.toMatchObject({
      code: badBytes ? "corrupt_artifact" : "artifact_not_found",
    });
    await expect(readdir(join(f.directory, "quarantine"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(join(f.directory, "staging"))).toEqual([]);
    expect(await readdir(join(f.directory, "runs"))).toHaveLength(3);
    if (badBytes) expect(await readFile(f.file)).toEqual(badBytes);

    const prepared = await f.regenerate();
    expect(prepared.preview.stages[0]).toMatchObject({ reason: "reuse_unavailable" });
    expect(f.calls()).toBe(2);
    const restored = await prepared.execute();
    expect(restored.status).toBe("completed");
    expect(restored.stages[0]).toMatchObject({
      status: "succeeded",
      output: { hash: f.ref.hash },
      actual: { reason: "reuse_unavailable" },
    });
    expect(f.calls()).toBe(3);
    for (const id of [...ids.slice(0, 2), restored.runId]) {
      expect(await f.history.output(id, "source")).toEqual(f.value);
    }
    await expect(f.history.output(failed.runId, "source")).rejects.toMatchObject({
      code: "output_absent",
    });
    expect(await Promise.all(ids.map((id) => f.history.run(id)))).toEqual(records);
    expect(await Promise.all(ids.map(f.recordBytes))).toEqual(bytes);
    expect(await readFile(f.file)).toEqual(good);
    if (badBytes) {
      const tx = await quarantine(f.directory);
      expect((await readdir(tx)).sort()).toEqual(["complete", "corrupt", "transaction.json"]);
      expect(await inode(join(tx, "corrupt"))).toBe(badInode);
      expect(await inode(f.file)).not.toBe(badInode);
      expect(await readFile(join(tx, "corrupt"))).toEqual(badBytes);
      expect(JSON.parse(await readFile(join(tx, "transaction.json"), "utf8"))).toMatchObject({
        slot: f.file,
        expected: {
          artifactSchema: f.ref.artifactSchema,
          codec: f.ref.codec,
          hashScheme: f.ref.hashScheme,
          hash: f.ref.hash,
        },
        incoming: { hash: f.ref.hash, byteLength: f.ref.byteLength },
        corrupt: {
          sha256: createHash("sha256").update(badBytes).digest("hex"),
          byteLength: badBytes.length,
        },
      });
    }
    expect(await readdir(join(f.directory, "staging"))).toEqual([]);
  },
);

it.each(["injected error", "unexpected corrupt occupant"] as const)(
  "preserves recovery evidence after removal with %s",
  async (fault) => {
    const f = await fixture();
    const good = await readFile(f.file);
    const record = await f.recordBytes(f.original.runId);
    const badInode = await inode(f.file);
    const foreign = join(f.directory, "staging", "foreign.tmp");
    await writeFile(foreign, "other writer");
    await writeFile(f.file, corrupt);
    const result = await (
      await f.regenerate({
        removed: async (file) => {
          expect(file).toBe(f.file);
          await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
          if (fault === "injected error")
            throw Object.assign(new Error("injected EIO"), { code: "EIO" });
          await writeFile(file, malformed, { flag: "wx" });
        },
      })
    ).execute();
    expect(result.status).toBe("failed");
    expect(result.stages[0]).toMatchObject({
      status: "failed",
      output: null,
      actual: { reason: "reuse_unavailable", details: { callbackInvoked: true } },
      error: { code: fault === "injected error" ? "publication_failed" : "corrupt_artifact" },
    });
    expect(f.calls()).toBe(2);
    const tx = await quarantine(f.directory);
    expect((await readdir(tx)).sort()).toEqual(["corrupt", "transaction.json"]);
    expect(await inode(join(tx, "corrupt"))).toBe(badInode);
    expect(await readFile(join(tx, "corrupt"))).toEqual(corrupt);
    const descriptor = JSON.parse(await readFile(join(tx, "transaction.json"), "utf8"));
    expect(descriptor).toMatchObject({ slot: f.file, incoming: { hash: f.ref.hash } });
    expect(await readFile(descriptor.incoming.stagedFile)).toEqual(good);
    expect(await readFile(foreign, "utf8")).toBe("other writer");
    expect(await f.recordBytes(f.original.runId)).toEqual(record);
    await expect(f.history.output(f.original.runId, "source")).rejects.toMatchObject({
      code: fault === "injected error" ? "artifact_not_found" : "corrupt_artifact",
    });
    if (fault !== "injected error") expect(await readFile(f.file)).toEqual(malformed);
    expect(await readdir(join(f.directory, "runs"))).toHaveLength(2);
    expect((await f.history.runs()).map(({ id }) => id).sort()).toEqual(
      [f.original.runId, result.runId].sort(),
    );
  },
);

it.each([
  ["unknown", "unsupported_history_format"],
  ["unknown codec", "unsupported_history_format"],
  ["headerless", "repair_refused"],
  ["over-budget", "read_limit_exceeded"],
  ["unreadable", "artifact_unreadable"],
  ["directory", "unsafe_path"],
  ["alias", "unsafe_path"],
  ["changed inode", "repair_refused"],
  ["changed descriptor", "repair_refused"],
  ["changed staging", "corrupt_artifact"],
] as const)("refuses a %s slot after one callback", async (fault, code) => {
  const f = await fixture();
  const prepared = await f.regenerate({
    occupiedRead: async () => {
      if (fault === "unreadable") throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
    quarantined: async (bad) => {
      if (fault === "changed inode") {
        await rename(f.file, `${f.file}.original`);
        await writeFile(f.file, corrupt, { flag: "wx" });
      }
      if (fault === "changed staging") {
        const descriptor = JSON.parse(await readFile(join(bad, "..", "transaction.json"), "utf8"));
        await writeFile(descriptor.incoming.stagedFile, corrupt);
      }
      if (fault === "changed descriptor") {
        await writeFile(join(bad, "..", "transaction.json"), "{}");
      }
    },
  });
  let outside: string | undefined;
  if (fault === "directory" || fault === "alias") {
    await rm(f.file);
    if (fault === "directory") await mkdir(f.file);
    else {
      outside = join(f.root, "outside");
      await mkdir(outside);
      await symlink(outside, f.file, "junction");
    }
  } else if (fault === "unknown") {
    await writeFile(f.file, `${HEADER.replace("artifact-v2", "artifact-v99")}null`);
  } else if (fault === "unknown codec") {
    await writeFile(f.file, "abilitybench-artifact-v2\nfuture-codec\n");
  } else if (fault === "headerless") {
    await writeFile(f.file, "null");
  } else {
    await writeFile(f.file, corrupt);
    if (fault === "over-budget")
      await truncate(f.file, OUTPUT_LIMIT + Buffer.byteLength(HEADER) + 1);
  }
  const before = await lstat(f.file, { bigint: true });
  const result = await prepared.execute();
  expect(result.status).toBe("failed");
  expect(result.stages[0]).toMatchObject({
    status: "failed",
    output: null,
    actual: { reason: "reuse_unavailable", details: { callbackInvoked: true } },
    error: { code },
  });
  expect(f.calls()).toBe(2);
  const after = await lstat(f.file, { bigint: true });
  expect(after.size).toBe(before.size);
  if (fault === "changed inode") {
    expect(after.ino).not.toBe(before.ino);
    expect(await readFile(f.file)).toEqual(corrupt);
    expect(await inode(join(await quarantine(f.directory), "corrupt"))).toBe(before.ino);
  } else {
    expect(after.ino).toBe(before.ino);
  }
  if (outside) expect(await readdir(outside)).toEqual([]);
});

it("reverifies an unexpectedly occupied missing slot and preserves an identical inode", async () => {
  const f = await fixture();
  const source = `${f.file}.original`;
  const originalInode = await inode(f.file);
  await rename(f.file, source);
  const result = await (
    await f.regenerate({
      beforeLink: async (file) => {
        if (file === f.file) await link(source, file);
      },
    })
  ).execute();
  expect(result.status).toBe("completed");
  expect(f.calls()).toBe(2);
  expect(await inode(f.file)).toBe(originalInode);
  expect(await f.history.output(result.runId, "source")).toEqual(f.value);
});
