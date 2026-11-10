import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  link,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWorkflow, openHistory, prepare, stage } from "../src/index.js";

const roots: string[] = [];
const workers: { stop: () => Promise<number | null> }[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map(({ stop }) => stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const value = { z: 3, a: ["selected"] };
const other = { z: 4, a: ["independent"] };
const header = "abilitybench-artifact-v2\nordered-json-v1\nsha256-domain-v2\n";
const bad = Buffer.from(`${header}{"incomplete":"${"x".repeat(70_000)}`);
const bytes = (output: typeof value) => Buffer.from(header + JSON.stringify(output));
const hash = (data: Buffer) =>
  createHash("sha256").update("abilitybench/artifact/v2\0").update(data).digest("hex");
const inode = async (file: string) => {
  const { dev, ino } = await lstat(file, { bigint: true });
  return { dev, ino };
};

type Event = {
  point: string;
  file?: string;
  code?: string;
  status?: string;
  reason?: string;
  runId?: string;
  result?: Awaited<ReturnType<Awaited<ReturnType<typeof prepare>>["execute"]>>;
  preview?: Awaited<ReturnType<typeof prepare>>["preview"];
};
function worker(root: string, output: typeof value, baseline = "", boundary = "") {
  const child = fork(
    "tests/fixtures/storage-schedule.mjs",
    [root, JSON.stringify(output), baseline, boundary],
    {
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      timeout: 18_000,
    },
  );
  const events: Event[] = [];
  child.on("message", (event: Event) => events.push(event));
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const stop = () => {
    child.kill();
    return done;
  };
  const control = {
    pid: child.pid,
    stop,
    resume: () => child.send("resume"),
    count: (point: string) => events.filter((event) => event.point === point).length,
    async at(point: string) {
      const signal = AbortSignal.timeout(4000);
      try {
        while (true) {
          const event = events.find((entry) => entry.point === point);
          if (event) return event;
          await once(child, "message", { signal });
        }
      } catch (cause) {
        throw new Error(
          `Worker did not reach ${point}. Observed ${events.map((event) => event.point)}. ${stderr}`,
          { cause },
        );
      }
    },
    async outcome() {
      expect(await done, stderr).toBe(0);
      expect(stderr).toBe("");
      const event = events.at(-1);
      expect(["result", "error"]).toContain(event?.point);
      return event;
    },
  };
  workers.push(control);
  return control;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench qualification "));
  roots.push(root);
  const directory = join(root, ".abilitybench");
  const history = openHistory(directory);
  const artifact = (output: typeof value) =>
    join(directory, "objects", "abilitybench-artifact-v2", "sha256", hash(bytes(output)));
  const runFile = (id: string) => join(directory, "runs", `${id}.json`);
  const lock = join(directory, "writer-lock");
  const owner = join(lock, "owner.json");
  const source = stage({ id: "source", reuse: { revision: "one" }, run: () => value });
  const workflow = createWorkflow({ id: "storage-schedule", root, stages: [source] });
  const seed = await (await prepare(workflow, { baseline: null })).execute();
  const original = await history.run(seed.runId);
  const originalBytes = await readFile(runFile(seed.runId));
  const otherSeed = await worker(root, other).outcome();
  const independent = otherSeed?.result?.runId;
  if (!independent) throw new Error("Missing independent seed");
  const independentBytes = await readFile(runFile(independent));
  return {
    root,
    directory,
    history,
    artifact,
    runFile,
    lock,
    owner,
    seed,
    independent,
    workflow,
    async unchanged() {
      expect(await readFile(runFile(seed.runId))).toEqual(originalBytes);
      expect(await history.run(seed.runId)).toEqual(original);
      expect(await readFile(runFile(independent))).toEqual(independentBytes);
      expect(await history.output(independent, "source")).toEqual(other);
      expect(await readFile(artifact(other))).toEqual(bytes(other));
    },
  };
}

const absent = async (path: string) => {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
};

async function checkQuarantine(directory: string, slot: string, expected: Buffer) {
  const quarantine = join(directory, "quarantine");
  const transactions = await readdir(quarantine);
  const descriptors = await Promise.all(
    transactions.map(async (name) => {
      const path = join(quarantine, name);
      const data = JSON.parse(await readFile(join(path, "transaction.json"), "utf8"));
      return { path, data };
    }),
  );
  const matching = descriptors.filter(({ data }) => data.slot === slot);
  expect(matching).toHaveLength(1);
  const match = matching[0];
  if (!match) throw new Error("Missing quarantine descriptor");
  const { path: transaction, data: descriptor } = match;
  const corrupt = join(transaction, "corrupt");
  expect(await readFile(corrupt)).toEqual(bad);
  expect(descriptor).toMatchObject({
    slot,
    corrupt: { sha256: createHash("sha256").update(bad).digest("hex"), byteLength: bad.length },
    expected: { hash: `sha256:${hash(expected)}` },
    incoming: { hash: `sha256:${hash(expected)}`, stagedFile: expect.any(String) },
  });
  const staged: string = descriptor.incoming.stagedFile;
  expect(dirname(staged)).toBe(join(directory, "staging"));
  return { corrupt, staged, complete: join(transaction, "complete") };
}

const third = { z: 5, a: ["new"] };
const fourth = { z: 6, a: ["another"] };

it.each([
  {
    name: "publication/publication, same new identity",
    boundary: "locked",
    first: third,
    second: third,
    repair: false,
    firstUsesBaseline: false,
  },
  {
    name: "publication/publication, different new identities",
    boundary: "beforeLink",
    first: third,
    second: fourth,
    repair: false,
    firstUsesBaseline: false,
  },
  {
    name: "publication/repair, different identities",
    boundary: "beforeLink",
    first: third,
    second: value,
    repair: true,
    firstUsesBaseline: false,
  },
  {
    name: "publication/regeneration, same missing identity",
    boundary: "beforeLink",
    first: value,
    second: value,
    repair: true,
    firstUsesBaseline: false,
  },
  {
    name: "repair/repair, different identities",
    boundary: "quarantineVerified",
    first: value,
    second: other,
    secondUsesIndependentBaseline: true,
    repair: true,
    firstUsesBaseline: true,
  },
  {
    name: "repair/repair, same identity",
    boundary: "occupiedRead",
    first: value,
    second: value,
    repair: true,
    firstUsesBaseline: true,
  },
])(
  "serializes $name",
  async ({ boundary, first, second, repair, firstUsesBaseline, secondUsesIndependentBaseline }) => {
    const f = await fixture();
    const slot = f.artifact(value);
    const missing = repair && boundary === "beforeLink" && first === second;
    if (missing) await unlink(slot);
    else if (repair) await writeFile(slot, bad);
    if (secondUsesIndependentBaseline) await writeFile(f.artifact(other), bad);
    const owner = worker(f.root, first, firstUsesBaseline ? f.seed.runId : "", boundary);
    await owner.at(boundary);
    const staging = join(f.directory, "staging");
    const ownerTemps = await readdir(staging);
    expect(ownerTemps).toHaveLength(1);
    const ownerInode = await inode(join(staging, ownerTemps[0] ?? ""));
    const token = await readFile(f.owner);
    expect(JSON.parse(token.toString()).pid).toBe(owner.pid);
    const baseline = secondUsesIndependentBaseline ? f.independent : f.seed.runId;
    const contender = worker(f.root, second, repair ? baseline : "");
    await contender.at("contended");
    expect(await readFile(f.owner)).toEqual(token);
    expect(await readdir(join(f.directory, "runs"))).toHaveLength(2);
    if (missing) await absent(slot);
    else if (repair) expect(await readFile(slot)).toEqual(bad);
    else await absent(f.artifact(third));
    if (boundary === "occupiedRead") await absent(join(f.directory, "quarantine"));
    if (boundary === "quarantineVerified") {
      const q = await checkQuarantine(f.directory, slot, bytes(value));
      expect(await inode(q.corrupt)).toEqual(await inode(slot));
      expect(await readFile(q.staged)).toEqual(bytes(value));
    }
    owner.resume();
    const firstOutcome = await owner.outcome();
    const secondOutcome = await contender.outcome();
    const ids = [firstOutcome?.result?.runId, secondOutcome?.result?.runId];
    expect(new Set(ids)).toHaveProperty("size", 2);
    for (const [index, attempt] of [firstOutcome, secondOutcome].entries()) {
      expect(attempt?.result).toMatchObject({
        status: "completed",
        stages: [{ status: "succeeded" }],
      });
      if (index === 1 && repair) {
        expect(attempt?.preview?.stages[0]).toMatchObject({ reason: "reuse_unavailable" });
        expect(attempt?.result?.stages[0]?.actual).toMatchObject({ reason: "reuse_unavailable" });
      }
      const id = attempt?.result?.runId ?? "";
      expect(await f.history.output(id, "source")).toEqual(index === 0 ? first : second);
      expect(await f.history.run(id)).toMatchObject({ id, attemptId: attempt?.result?.attemptId });
    }
    expect(await inode(f.artifact(first))).toEqual(ownerInode);
    expect(await readFile(f.artifact(first))).toEqual(bytes(first));
    expect(await readFile(f.artifact(second))).toEqual(bytes(second));
    expect([owner.count("callback"), contender.count("callback")]).toEqual([1, 1]);
    expect(await readdir(join(f.directory, "runs"))).toHaveLength(4);
    if (missing) await absent(join(f.directory, "quarantine"));
    if (repair && !missing) {
      expect(await readdir(join(f.directory, "quarantine"))).toHaveLength(
        secondUsesIndependentBaseline ? 2 : 1,
      );
      const q = await checkQuarantine(f.directory, slot, bytes(value));
      expect(await readFile(q.complete)).toHaveLength(0);
      if (secondUsesIndependentBaseline) {
        const independent = await checkQuarantine(f.directory, f.artifact(other), bytes(other));
        expect(await readFile(independent.complete)).toHaveLength(0);
      }
      expect(await f.history.output(f.seed.runId, "source")).toEqual(value);
    }
    await f.unchanged();
    await absent(f.lock);
    expect(await readdir(join(f.directory, "staging"))).toEqual([]);
  },
  15_000,
);

it.each([
  "beforeOwner",
  "staged",
  "quarantineVerified",
  "removed",
  "replacementLinked",
  "runLinked",
])(
  "preserves the exact durable state when killed at %s",
  async (boundary) => {
    const f = await fixture();
    const before = await prepare(f.workflow, { baseline: "latest" });
    const slot = f.artifact(value);
    const repairs = ["quarantineVerified", "removed", "replacementLinked"].includes(boundary);
    if (repairs) await writeFile(slot, bad);
    const badInode = await inode(slot);
    const writer = worker(f.root, repairs ? value : third, repairs ? f.seed.runId : "", boundary);
    const { file } = await writer.at(boundary);
    if (!file) throw new Error("Missing boundary path");
    const staging = join(f.directory, "staging");
    const staged = await readdir(staging);
    expect(staged).toHaveLength(1);
    const stagedPath = join(staging, staged[0] ?? "");
    const stagedBytes = await readFile(stagedPath);
    if (boundary === "staged") {
      expect(stagedPath).toBe(file);
      await absent(f.lock);
    } else if (boundary === "beforeOwner") {
      expect(await readdir(f.lock)).toEqual([]);
    }
    const token =
      boundary !== "staged" && boundary !== "beforeOwner" ? await readFile(f.owner) : undefined;
    if (token) expect(JSON.parse(token.toString()).pid).toBe(writer.pid);

    expect(await writer.stop()).not.toBe(0);
    expect(writer.count("callback")).toBe(1);
    expect(writer.count("result")).toBe(0);
    expect(writer.count("error")).toBe(0);
    expect(await readdir(staging)).toEqual(staged);
    expect(await readFile(stagedPath)).toEqual(stagedBytes);
    if (token) expect(await readFile(f.owner)).toEqual(token);
    else if (boundary === "staged") await absent(f.lock);
    else expect(await readdir(f.lock)).toEqual([]);

    const ids = (await f.history.runs()).map(({ id }) => id);
    if (boundary === "runLinked") {
      const id = basename(file, ".json");
      expect(ids).toHaveLength(3);
      const explicit = await prepare(f.workflow, { baseline: { runId: id } });
      expect(explicit.preview.baseline?.runId).toBe(id);
      expect(await f.history.run(id)).toMatchObject({ id, status: "completed" });
      expect(await readFile(file)).toEqual(stagedBytes);
      expect(await inode(file)).toEqual(await inode(stagedPath));
      expect(await f.history.output(id, "source")).toEqual(third);
    } else {
      expect(ids.sort()).toEqual([f.seed.runId, f.independent].sort());
      const latest = await prepare(f.workflow, { baseline: "latest" });
      expect(latest.preview.baseline).toEqual(before.preview.baseline);
      expect(stagedBytes).toEqual(bytes(repairs ? value : third));
      await absent(f.artifact(third));
    }
    if (repairs) {
      const q = await checkQuarantine(f.directory, slot, bytes(value));
      expect(q.staged).toBe(stagedPath);
      expect(await inode(q.corrupt)).toEqual(badInode);
      await absent(q.complete);
      if (boundary === "quarantineVerified") {
        expect(await inode(slot)).toEqual(badInode);
        expect(await readFile(slot)).toEqual(bad);
        await expect(f.history.output(f.seed.runId, "source")).rejects.toMatchObject({
          code: "corrupt_artifact",
        });
      } else if (boundary === "removed") {
        await absent(slot);
        await expect(f.history.output(f.seed.runId, "source")).rejects.toMatchObject({
          code: "artifact_not_found",
        });
      } else {
        expect(await inode(slot)).toEqual(await inode(stagedPath));
        expect(await readFile(slot)).toEqual(bytes(value));
        expect(await f.history.output(f.seed.runId, "source")).toEqual(value);
      }
    } else {
      expect(await f.history.output(f.seed.runId, "source")).toEqual(value);
    }
    await f.unchanged();
  },
  15_000,
);

it("refuses an abandoned old token, then recovers a missing slot while all workers are stopped", async () => {
  const f = await fixture();
  const slot = f.artifact(value);
  await writeFile(slot, bad);
  const writer = worker(f.root, value, f.seed.runId, "removed");
  await writer.at("removed");
  const live = JSON.parse(await readFile(f.owner, "utf8"));
  expect(live.pid).toBe(writer.pid);
  expect(await writer.stop()).not.toBe(0);

  // Give the dead owner's token an old date. Age and PID remain diagnostics.
  const stale = JSON.stringify({ ...live, createdAt: "2000-01-01T00:00:00.000Z" });
  await writeFile(f.owner, stale);
  const contender = worker(f.root, value, f.seed.runId);
  await contender.at("contended");
  expect(await contender.outcome()).toMatchObject({
    point: "error",
    code: "finalization_failed",
    reason: "storage_busy",
    status: "not_published",
    runId: expect.stringMatching(/^run_[a-f0-9]{64}$/),
  });
  expect(contender.count("callback")).toBe(1);
  expect(await readFile(f.owner, "utf8")).toBe(stale);
  await absent(slot);
  const q = await checkQuarantine(f.directory, slot, bytes(value));
  expect(await readdir(join(f.directory, "staging"))).toEqual([basename(q.staged)]);
  const before = await f.history.runs();

  // Both child close events have arrived. The parent is the exclusive administrator.
  // Verify the known fixture's exact staged bytes and domain hash before linking.
  const recovered = await readFile(q.staged);
  expect(recovered).toEqual(bytes(value));
  expect(basename(slot)).toBe(hash(recovered));
  await link(q.staged, slot);
  expect(await f.history.output(f.seed.runId, "source")).toEqual(value);
  expect(await inode(slot)).toEqual(await inode(q.staged));
  expect(await f.history.runs()).toEqual(before);
  await f.unchanged();
  expect(await readFile(q.corrupt)).toEqual(bad);
  expect(await readFile(q.staged)).toEqual(recovered);
  await absent(q.complete);
  await writeFile(join(f.root, "abandoned-owner.json"), stale, { flag: "wx" });
  await unlink(f.owner);
  await rmdir(f.lock);

  const successor = worker(f.root, value, f.seed.runId);
  expect(await successor.outcome()).toMatchObject({
    point: "result",
    result: { status: "completed", stages: [{ status: "reused" }] },
  });
  expect([
    writer.count("callback"),
    contender.count("callback"),
    successor.count("callback"),
  ]).toEqual([1, 1, 0]);
  expect(writer.count("result")).toBe(0);
  await f.unchanged();
}, 16_000);

it.each(["beforeOwner", "locked"])(
  "preserves a foreign owner on %s token failure",
  async (boundary) => {
    const f = await fixture();
    const writer = worker(f.root, third, "", boundary);
    await writer.at(boundary);
    const foreign =
      '{"uuid":"f6429b84-8b53-4a16-9a0b-89c57c8e78d7","pid":1,"createdAt":"2000-01-01T00:00:00.000Z"}';
    if (boundary === "locked") await unlink(f.owner);
    await writeFile(f.owner, foreign, { flag: "wx" });
    writer.resume();
    expect(await writer.outcome()).toMatchObject({
      point: "error",
      code: "finalization_failed",
      reason: "storage_busy",
      status: "not_published",
    });
    expect(writer.count("callback")).toBe(1);
    expect(await readFile(f.owner, "utf8")).toBe(foreign);
    await absent(f.artifact(third));
    expect(await f.history.runs()).toHaveLength(2);
    await f.unchanged();
  },
  12_000,
);

it("allows another publisher to finish while the first callback is paused", async () => {
  const f = await fixture();
  const paused = worker(f.root, third, "", "callback");
  await paused.at("callbackHeld");
  await absent(f.lock);
  const peer = worker(f.root, value);
  expect(await peer.outcome()).toMatchObject({ point: "result", result: { status: "completed" } });
  expect(peer.count("contended")).toBe(0);
  await absent(f.lock);
  paused.resume();
  expect(await paused.outcome()).toMatchObject({
    point: "result",
    result: { status: "completed" },
  });
  expect([paused.count("callback"), peer.count("callback")]).toEqual([1, 1]);
  await f.unchanged();
}, 15_000);

it("keeps an open old inode complete while new readers see unavailable then verified replacement", async () => {
  const f = await fixture();
  const slot = f.artifact(value);
  await writeFile(slot, bad);
  const originalInode = await inode(slot);
  const writer = worker(f.root, value, f.seed.runId, "quarantineVerified,removed");
  await writer.at("quarantineVerified");
  await expect(f.history.output(f.seed.runId, "source")).rejects.toMatchObject({
    code: "corrupt_artifact",
  });
  const opened = await open(slot, "r");
  try {
    const old = await opened.stat({ bigint: true });
    expect({ dev: old.dev, ino: old.ino }).toEqual(originalInode);
    const prefix = Buffer.alloc(64 * 1024);
    expect((await opened.read(prefix)).bytesRead).toBe(prefix.length);
    writer.resume();
    await writer.at("removed");
    const token = await readFile(f.owner);
    const q = await checkQuarantine(f.directory, slot, bytes(value));
    await expect(f.history.output(f.seed.runId, "source")).rejects.toMatchObject({
      code: "artifact_not_found",
    });
    await absent(slot);
    expect(await readFile(f.owner)).toEqual(token);
    expect(await readFile(q.staged)).toEqual(bytes(value));
    expect(Buffer.concat([prefix, await opened.readFile()])).toEqual(bad);
    expect(await inode(q.corrupt)).toEqual(originalInode);
    expect(await f.history.runs()).toHaveLength(2);
  } finally {
    await opened.close();
  }
  writer.resume();
  expect(await writer.outcome()).toMatchObject({
    point: "result",
    result: { status: "completed" },
  });
  expect(await readFile(slot)).toEqual(bytes(value));
  expect(await f.history.output(f.seed.runId, "source")).toEqual(value);
  expect(await inode(slot)).not.toEqual(originalInode);
  expect(writer.count("callback")).toBe(1);
  await f.unchanged();
}, 15_000);
