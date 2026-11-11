// biome-ignore-all lint/complexity/useLiteralKeys: TypeScript index signatures require bracket access.
import { spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { fixture } from "./fixtures/history-fixture.js";
import { copyPhase0History, phase0Artifact, phase0Id } from "./fixtures/phase0-fixture.js";

const root = await mkdtemp(join(tmpdir(), "abilitybench installed cli "));
afterAll(() => rm(root, { recursive: true, force: true }));
const manager = process.env["npm_execpath"] as string;
const jsManager = /\.[cm]?js$/i.test(manager);
const pack = spawnSync(
  jsManager ? process.execPath : manager,
  [...(jsManager ? [manager] : []), "pack", "--pack-destination", root],
  {
    encoding: "utf8",
  },
);
if (pack.status !== 0) throw new Error(pack.stdout + pack.stderr);
const consumer = join(root, "consumer");
await mkdir(consumer);
await writeFile(join(consumer, "package.json"), '{"private":true,"type":"module"}');
const install = spawnSync(
  jsManager ? process.execPath : manager,
  [
    ...(jsManager ? [manager] : []),
    "add",
    "--offline",
    "--ignore-scripts",
    join(root, "abilitybench-0.1.0.tgz"),
  ],
  { cwd: consumer, encoding: "utf8" },
);
if (install.status !== 0) throw new Error(install.stdout + install.stderr);
const cli = join(consumer, "node_modules", "abilitybench", "dist", "cli.js");
const run = (args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: consumer, encoding: "utf8" });

it("reports the supported package version", () => {
  const result = run(["--version"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("0.1.0\n");
  expect(result.stderr).toBe("");
});

it("imports only the supported SDK surface without creating files", async () => {
  const before = (await readdir(consumer, { recursive: true })).sort();
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       import * as sdk from "abilitybench";
       assert.deepEqual(Object.keys(sdk), [
         "AbilityBenchError", "createWorkflow", "openHistory", "prepare", "stage",
       ]);
       for (const subpath of ["dist/execution.js", "legacy", "planning", "filesystem-store"]) {
         await assert.rejects(import("abilitybench/" + subpath), {
           code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
         });
       }`,
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("");
  expect(result.status).toBe(0);
  expect((await readdir(consumer, { recursive: true })).sort()).toEqual(before);
});

it("rejects deferred commands and invalid grammar with no partial stdout", () => {
  for (const args of [
    ["run"],
    ["plan"],
    ["evaluate"],
    ["export"],
    ["runs", "--limit", "1.2"],
    ["runs", "extra"],
    ["inspect"],
    ["runs", "--config", "x"],
    ["runs", "--history"],
    ["runs", "--json", "--json"],
  ]) {
    const result = run([...args, "--json"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "invalid_argument" } });
  }
});
it("reads all four commands installed without source/config/root/provider/evaluator code and without writes", async () => {
  const f = await fixture();
  const a = await f.save();
  const g = await fixture('{"z":[3],"a":null}');
  g.body["workflowId"] = "unrelated";
  const b = await g.save();
  const history = join(consumer, "history with spaces");
  await cp(f.root, history, { recursive: true });
  await cp(g.root, history, { recursive: true });
  await cp(history, join(consumer, ".abilitybench"), { recursive: true });
  const fs = await import("node:fs/promises");
  const snapshot = async () => {
    const files = await fs.readdir(history, { recursive: true });
    return Promise.all(
      files.sort().map(async (file) => {
        const path = join(history, file);
        return [
          file,
          (await fs.stat(path)).isFile() ? (await fs.readFile(path)).toString("base64") : null,
        ];
      }),
    );
  };
  const before = await snapshot();
  const exported = join(consumer, "exported.json");
  const fd = openSync(exported, "w");
  try {
    const redirected = spawnSync(
      process.execPath,
      [cli, "output", a, "source", "--history", history],
      { cwd: consumer, stdio: ["ignore", fd, "pipe"] },
    );
    expect(redirected.status).toBe(0);
  } finally {
    closeSync(fd);
  }
  expect(JSON.parse(await fs.readFile(exported, "utf8"))).toEqual({ z: [2, 1], a: null });
  for (const extra of [[], ["--history", history], ["--history", ".abilitybench"]]) {
    const list = run(["runs", ...extra, "--json"]);
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout)).toHaveLength(2);
    expect(list.stderr).toBe("");
    const inspected = run(["inspect", a, ...extra, "--json"]);
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout).outputReferences).toBe("unchecked");
    for (const json of [[], ["--json"]]) {
      const out = run(["output", a, "source", ...extra, ...json]);
      expect(out.status).toBe(0);
      expect(out.stdout).toBe('{\n  "z": [\n    2,\n    1\n  ],\n  "a": null\n}\n');
      expect(out.stderr).toBe("");
    }
    expect(run(["compare", a, a, "source", ...extra]).status).toBe(0);
    const different = run(["compare", a, b, "source", ...extra, "--json"]);
    expect(different.status).toBe(1);
    expect(JSON.parse(different.stdout).difference).toEqual({ path: "/z", reason: "array_length" });
  }
  expect(await snapshot()).toEqual(before);
  const broken = run([
    "compare",
    a,
    `run_${"b".repeat(64)}`,
    "source",
    "--history",
    history,
    "--json",
  ]);
  expect(broken.status).toBe(2);
  expect(broken.stdout).toBe("");
  expect(JSON.parse(broken.stderr)).toMatchObject({
    error: { side: "right", code: "run_not_found" },
  });
}, 30000);

it("buffers corrupt output errors, supports filtering, and inspects failed history successfully", async () => {
  const f = await fixture();
  const a = await f.save();
  const filtered = run([
    "runs",
    "--history",
    f.root,
    "--workflow",
    "example",
    "--limit",
    "1",
    "--json",
  ]);
  expect(filtered.status).toBe(0);
  expect(JSON.parse(filtered.stdout)).toHaveLength(1);
  f.body["status"] = "failed";
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
  const failed = await f.save();
  const inspection = run(["inspect", failed, "--history", f.root, "--json"]);
  expect(inspection.status).toBe(0);
  expect(JSON.parse(inspection.stdout).status).toBe("failed");
  await writeFile(f.artifact, "broken");
  const out = run(["output", a, "source", "--history", f.root, "--json"]);
  expect(out.status).toBe(2);
  expect(out.stdout).toBe("");
  expect(JSON.parse(out.stderr)).toMatchObject({ error: { code: "corrupt_artifact" } });
});

it("reads mixed Phase 0 and current history through the installed commands", async () => {
  const f = await fixture('{"a":null,"b":[2,1]}');
  const equal = await f.save();
  const g = await fixture('{"b":[2,1],"a":null}');
  const different = await g.save();
  const history = join(consumer, "mixed history with spaces");
  await cp(f.root, history, { recursive: true });
  await cp(g.root, history, { recursive: true });
  await copyPhase0History(history);
  const flags = ["--history", history, "--json"];
  const record = join(history, "runs", `${phase0Id}.json`);
  const artifact = join(history, "objects", "sha256", phase0Artifact);
  const before = await Promise.all([readFile(record), readFile(artifact)]);

  const listing = run(["runs", ...flags]);
  expect(listing.status).toBe(0);
  expect(
    JSON.parse(listing.stdout).map(({ schemaVersion }: { schemaVersion: string }) => schemaVersion),
  ).toEqual(["abilitybench-run-v2", "abilitybench-run-v2", "phase0-run-v1"]);
  const inspected = run(["inspect", phase0Id, ...flags]);
  expect(inspected.status).toBe(0);
  expect(JSON.parse(inspected.stdout)).toMatchObject({
    status: "failed",
    evaluationStatus: "not_run",
    outputReferences: "unchecked",
  });
  const exported = run(["output", phase0Id, "source", ...flags]);
  expect(exported.status).toBe(0);
  expect(exported.stdout).toBe('{\n  "a": null,\n  "b": [\n    2,\n    1\n  ]\n}\n');
  expect(exported.stderr).toBe("");
  const same = run(["compare", phase0Id, equal, "source", ...flags]);
  expect(same.status).toBe(0);
  expect(JSON.parse(same.stdout)).toMatchObject({ equal: true, difference: null });
  const reversed = run(["compare", phase0Id, different, "source", ...flags]);
  expect(reversed.status).toBe(1);
  expect(JSON.parse(reversed.stdout)).toMatchObject({
    equal: false,
    difference: { path: "", reason: "object_order" },
  });
  expect(await Promise.all([readFile(record), readFile(artifact)])).toEqual(before);

  await writeFile(artifact, "abilitybench-artifact-v8\nfuture-codec\nnull");
  const unknown = run(["compare", equal, phase0Id, "source", ...flags]);
  expect(unknown.status).toBe(2);
  expect(unknown.stdout).toBe("");
  expect(JSON.parse(unknown.stderr)).toMatchObject({
    error: { code: "unsupported_history_format", side: "right" },
  });
});
