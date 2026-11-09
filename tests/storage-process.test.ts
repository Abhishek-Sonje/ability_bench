import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWorkflow, openHistory, prepare, stage } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function root() {
  const p = await mkdtemp(join(tmpdir(), "abilitybench process storage "));
  roots.push(p);
  return p;
}
function writer(root: string, mode = "normal") {
  const child = spawn(
    process.execPath,
    ["tests/fixtures/storage-writer.mjs", root, '{"z":2,"a":1}', mode],
    { cwd: process.cwd(), timeout: 12000 },
  );
  let stdout = "",
    stderr = "";
  const locked = new Promise<void>((resolve) =>
    child.stdout.on("data", (data) => {
      stdout += data;
      if (stdout.includes("locked")) resolve();
    }),
  );
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
  return { child, locked, done };
}
it("serializes competing real publishers under the owner-token lock", async () => {
  const r = await root();
  const first = writer(r, "pause");
  await first.locked;
  const owner = await readFile(join(r, "writer-lock", "owner.json"), "utf8");
  expect(JSON.parse(owner).uuid).toMatch(/^[a-f0-9-]{36}$/);
  const second = writer(r);
  first.child.stdin.write("release");
  expect((await first.done).code).toBe(0);
  expect(await second.done).toEqual({ code: 0, stdout: "", stderr: "" });
  const files = await readdir(join(r, "objects", "abilitybench-artifact-v2", "sha256"));
  expect(files).toHaveLength(1);
  expect(
    (
      await stat(join(r, "objects", "abilitybench-artifact-v2", "sha256", files[0] ?? "missing"))
    ).isFile(),
  ).toBe(true);
  expect(await readdir(join(r, "staging"))).toEqual([]);
  await expect(stat(join(r, "writer-lock"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("preserves a crashed writer's lock and private staging without stealing or deleting", async () => {
  const r = await root();
  const first = writer(r, "pause");
  await first.locked;
  const owner = await readFile(join(r, "writer-lock", "owner.json"));
  first.child.kill();
  await first.done;
  const temps = await readdir(join(r, "staging"));
  expect(temps).toHaveLength(1);
  expect(await writer(r).done).toEqual({ code: 2, stdout: "", stderr: "storage_busy" });
  expect(await readFile(join(r, "writer-lock", "owner.json"))).toEqual(owner);
  expect(await readdir(join(r, "staging"))).toEqual(temps);
  expect(await readdir(join(r, "objects", "abilitybench-artifact-v2", "sha256"))).toEqual([]);
}, 9000);
it("rejects invalid identities in a child process before writing", async () => {
  const r = await root();
  expect(await writer(r, "invalid").done).toEqual({
    code: 2,
    stdout: "",
    stderr: "invalid_argument",
  });
  expect(await readdir(r)).toEqual([]);
});

it("terminates a hanging SDK callback without committing or reusing its attempt", async () => {
  const r = await root();
  const history = join(r, ".abilitybench");
  let seedCalls = 0;
  let hangingCalls = 0;
  const seed = stage({
    id: "seed",
    reuse: { revision: "one" },
    run: () => {
      seedCalls++;
      return "committed";
    },
  });
  const hanging = stage({
    id: "hanging",
    reuse: { revision: "one" },
    dependencies: { seed },
    run: () => ++hangingCalls,
  });
  const workflow = createWorkflow({ id: "interrupt", root: r, stages: [seed, hanging] });
  const committed = await (await prepare(workflow, { baseline: null })).execute();
  const runPath = join(history, "runs", `${committed.runId}.json`);
  const bytes = await readFile(runPath);
  const child = spawn(process.execPath, ["tests/fixtures/interrupted-execution.mjs", r], {
    timeout: 8000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.includes("hanging\n")) child.kill();
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  expect(exit).not.toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toBe("hanging\n");
  await expect(stat(join(r, "resumed"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(runPath)).toEqual(bytes);
  expect(await readdir(join(history, "staging"))).toEqual(["interrupted.tmp"]);
  expect(
    await readdir(join(history, "objects", "abilitybench-artifact-v2", "sha256")),
  ).toHaveLength(3);
  const reader = openHistory(history);
  expect((await reader.runs()).map(({ id }) => id)).toEqual([committed.runId]);
  expect(await reader.output(committed.runId, "seed")).toBe("committed");
  const recovery = await prepare(workflow, { baseline: "latest" });
  expect(recovery.preview.baseline?.runId).toBe(committed.runId);
  const result = await recovery.execute();
  expect(result.stages.map(({ status }) => status)).toEqual(["reused", "reused"]);
  expect([seedCalls, hangingCalls]).toEqual([1, 1]);
}, 12000);
