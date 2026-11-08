// biome-ignore-all lint/complexity/useLiteralKeys: Declared environment and component dictionaries use index access.
import { spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createWorkflow,
  type JsonObject,
  openHistory,
  prepare,
  type ReuseOptions,
  stage,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench influences "));
  roots.push(root);
  return { root, history: join(root, ".abilitybench") };
}
it("rejects external hard-link aliases of history artifacts and records but allows unrelated hard-linked source files", async () => {
  const f = await fixture(),
    outside = await fixture();
  const seed = stage({ id: "seed", run: () => "retained" });
  const saved = await (
    await prepare(createWorkflow({ id: "seed", root: f.root, stages: [seed] }), { baseline: null })
  ).execute();
  const artifact = join(
    f.history,
    "objects",
    "abilitybench-artifact-v2",
    "sha256",
    saved.stages[0]?.output?.hash.slice(7) ?? "missing",
  );
  await link(artifact, join(outside.root, "artifact alias"));
  await link(join(f.history, "runs", `${saved.runId}.json`), join(outside.root, "record alias"));
  await writeFile(join(outside.root, "source"), "source bytes");
  await link(join(outside.root, "source"), join(f.root, "source alias"));
  let calls = 0;
  const stages = [
    join(outside.root, "artifact alias"),
    join(outside.root, "record alias"),
    "source alias",
  ].map((file, i) =>
    stage({
      id: `watch-${i}`,
      reuse: { files: [file] },
      run: () => {
        calls++;
        return null;
      },
    }),
  );
  const p = await prepare(createWorkflow({ id: "physical", root: f.root, stages }), {
    baseline: null,
    failureMode: "continue-independent",
  });
  expect(p.preview.stages.slice(0, 2).map((s) => s.details)).toEqual([
    expect.objectContaining({
      error: { code: "unsafe_path", file: join(outside.root, "artifact alias") },
    }),
    expect.objectContaining({
      error: { code: "unsafe_path", file: join(outside.root, "record alias") },
    }),
  ]);
  const result = await p.execute();
  expect(result.stages.map((s) => s.status)).toEqual(["failed", "failed", "succeeded"]);
  expect(calls).toBe(1);
});
it.each(["files", "revision", "both"])(
  "permits zero-call reuse with %s identity and diagnoses declared changes",
  async (kind) => {
    const f = await fixture();
    await writeFile(join(f.root, "source.ts"), "first");
    let calls = 0;
    function graph(revision = "v1") {
      const reuse = {
        ...(kind !== "revision" ? { files: ["source.ts"] } : {}),
        ...(kind !== "files" ? { revision } : {}),
      };
      const source = stage({
        id: "source",
        reuse,
        run: () => {
          calls++;
          return "same";
        },
      });
      return createWorkflow({ id: "identity", root: f.root, stages: [source] });
    }
    const first = await (await prepare(graph(), { baseline: null })).execute();
    const second = await (await prepare(graph(), { baseline: { runId: first.runId } })).execute();
    expect(calls).toBe(1);
    expect(second.stages[0]?.status).toBe("reused");
    if (kind !== "revision") await writeFile(join(f.root, "source.ts"), "second");
    const changed = await (
      await prepare(graph(kind === "files" ? "v1" : "v2"), { baseline: { runId: first.runId } })
    ).execute();
    expect(calls).toBe(2);
    expect(changed.stages[0]?.actual).toMatchObject({
      reason: "influences_changed",
      details: {
        changedComponents: expect.arrayContaining([
          expect.objectContaining({
            name: kind === "revision" ? "implementation" : "watchedFiles",
          }),
        ]),
      },
    });
    if (kind === "both")
      expect(changed.stages[0]?.actual.details).toMatchObject({
        changedComponents: expect.arrayContaining([
          expect.objectContaining({ name: "implementation" }),
        ]),
      });
  },
);
it.each(["prompt", "model", "settings", "nested", "order"])(
  "compares whole ordered stage inputs (%s) without invalidating unrelated stages",
  async (change) => {
    const f = await fixture();
    const graph = (changed: boolean) => {
      let inputs: JsonObject = {
        prompt: "old",
        model: "model-a",
        settings: { temperature: 1 },
        nested: [2, 1],
      };
      if (changed) {
        if (change === "order")
          inputs = {
            nested: [2, 1],
            settings: { temperature: 1 },
            model: "model-a",
            prompt: "old",
          };
        else if (change === "settings") inputs["settings"] = { temperature: 2 };
        else if (change === "nested") inputs["nested"] = [1, 2];
        else inputs[change] = "new";
      }
      return createWorkflow({
        id: "inputs",
        root: f.root,
        stages: [
          stage({ id: "target", inputs, reuse: { revision: "v1" }, run: () => "stable" }),
          stage({
            id: "unrelated",
            inputs: { prompt: "unrelated" },
            reuse: { revision: "v1" },
            run: () => null,
          }),
        ],
      });
    };
    const first = await (await prepare(graph(false), { baseline: null })).execute();
    const next = await (await prepare(graph(true), { baseline: { runId: first.runId } })).execute();
    expect(next.stages.map((s) => s.actual.reason)).toEqual(["influences_changed", "reused"]);
    expect(next.stages[0]?.components?.["inputs"]).not.toBe(
      first.stages[0]?.components?.["inputs"],
    );
  },
);
it("captures presence/value and mutable inputs before preparation yields; reuse uses the captured identity", async () => {
  const f = await fixture();
  const name = "ABILITYBENCH_REUSE_CAPTURE",
    previous = process.env[name];
  try {
    process.env[name] = "private-captured-value";
    const inputs = { prompt: "old", list: [2, 1] };
    let calls = 0;
    const options = {
      id: "source",
      inputs,
      environment: [name],
      reuse: { revision: "v1" },
      run: ({
        inputs,
        env,
      }: {
        inputs: { prompt: string; list: number[] };
        env: Record<string, string | undefined>;
      }) => {
        calls++;
        return { inputs, value: env[name] ?? "missing" };
      },
    };
    const workflow = createWorkflow({ id: "snapshot", root: f.root, stages: [stage(options)] });
    const first = await (await prepare(workflow, { baseline: null })).execute();
    const preparing = prepare(workflow, { baseline: { runId: first.runId } });
    inputs.prompt = "changed";
    inputs.list.reverse();
    process.env[name] = "after-prepare";
    options.reuse.revision = "v2";
    const prepared = await preparing;
    const second = await prepared.execute();
    expect(calls).toBe(1);
    expect(second.stages[0]?.fingerprint).toBe(first.stages[0]?.fingerprint);
    expect(await openHistory(f.history).output(second.runId, "source")).toEqual({
      inputs: { prompt: "old", list: [2, 1] },
      value: "private-captured-value",
    });
    expect(JSON.stringify(prepared.preview) + JSON.stringify(second)).not.toContain(
      "private-captured-value",
    );
    // Missing differs from present empty, which differs from another present value.
    const identities: (string | undefined)[] = [];
    for (const value of [undefined, "", "other"]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      const changed = await (
        await prepare(workflow, { baseline: { runId: first.runId } })
      ).execute();
      expect(changed.stages[0]?.actual.details).toMatchObject({
        changedComponents: expect.arrayContaining([
          expect.objectContaining({ name: "environment" }),
        ]),
      });
      identities.push(changed.stages[0]?.components?.["environment"]);
    }
    expect(new Set(identities).size).toBe(3);
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});
it.each(["rename", "retarget", "alias"])(
  "includes dependency binding names and targets even for identical outputs (%s)",
  async (change) => {
    const f = await fixture();
    const graph = (changed: boolean) => {
      const one = stage({ id: "one", reuse: { revision: "v1" }, run: () => "same" });
      const two = stage({ id: "two", reuse: { revision: "v1" }, run: () => "same" });
      const dependencies =
        changed && change === "rename"
          ? { renamed: one }
          : changed && change === "retarget"
            ? { source: two }
            : changed && change === "alias"
              ? { source: one, other: one }
              : { source: one };
      const target = stage({
        id: "target",
        dependencies,
        reuse: { revision: "v1" },
        run: () => "same",
      });
      return createWorkflow({ id: "bindings", root: f.root, stages: [one, two, target] });
    };
    const first = await (await prepare(graph(false), { baseline: null })).execute();
    const prepared = await prepare(graph(true), { baseline: { runId: first.runId } });
    expect(prepared.preview.stages[2]?.decision).toBe("execute");
    const next = await prepared.execute();
    expect(next.stages.map((s) => s.actual.reason)).toEqual([
      "reused",
      "reused",
      "influences_changed",
    ]);
    expect(next.stages[2]?.actual.details).toMatchObject({
      changedBindings:
        change === "rename"
          ? ["renamed", "source"]
          : change === "retarget"
            ? ["source"]
            : ["other"],
    });
  },
);
it("supports external history, absolute watches and symlinked external files with normalized physical identities", async () => {
  const f = await fixture(),
    external = await fixture(),
    storage = await fixture();
  await writeFile(join(external.root, "a file.txt"), "a");
  await writeFile(join(external.root, "z file.txt"), "z");
  await symlink(
    external.root,
    join(f.root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  let calls = 0;
  function graph(files: string[]) {
    const source = stage({
      id: "source",
      reuse: { files },
      run: () => {
        calls++;
        return { "10": "ten", "2": "two", z: 1, a: 2 };
      },
    });
    return createWorkflow({ id: "external", root: f.root, stages: [source] });
  }
  const first = await (
    await prepare(graph([join(external.root, "a file.txt"), "linked/z file.txt"]), {
      baseline: null,
      historyDirectory: storage.history,
    })
  ).execute();
  // Declared names reverse their lexical order, but resolved physical watches are the same.
  const second = await (
    await prepare(graph(["linked/a file.txt", join(external.root, "z file.txt")]), {
      baseline: { runId: first.runId },
      historyDirectory: storage.history,
    })
  ).execute();
  expect(calls).toBe(1);
  expect(second.stages[0]?.status).toBe("reused");
  expect(
    Object.keys((await openHistory(storage.history).output(second.runId, "source")) as object),
  ).toEqual(["2", "10", "z", "a"]);
  await expect(readFile(join(f.root, ".abilitybench"))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["missing", "directory", "duplicate-physical", "nul"])(
  "diagnoses an unavailable or unsafe %s watch and never executes under unknown identity",
  async (kind) => {
    const f = await fixture();
    await writeFile(join(f.root, "file.txt"), "bytes");
    await mkdir(join(f.root, "directory"));
    const files =
      kind === "duplicate-physical"
        ? ["file.txt", "./file.txt"]
        : [kind === "nul" ? "bad\0path" : kind];
    let calls = 0;
    const workflow = createWorkflow({
      id: "watch",
      root: f.root,
      stages: [
        stage({
          id: "source",
          reuse: { files },
          run: () => {
            calls++;
            return null;
          },
        }),
      ],
    });
    const prepared = await prepare(workflow, { baseline: null });
    expect(prepared.preview.stages[0]?.decision).toBe("execute");
    expect(prepared.preview.stages[0]?.details).toMatchObject({
      error: {
        code:
          kind === "duplicate-physical"
            ? "invalid_declaration"
            : kind === "nul"
              ? "unsafe_path"
              : "influence_unavailable",
      },
    });
    expect((await prepared.execute()).stages[0]).toMatchObject({
      status: "failed",
      actual: { details: { callbackInvoked: false } },
    });
    expect(calls).toBe(0);
  },
);
it.each([
  {},
  { files: [] },
  { revision: "" },
  { revision: " " },
  { files: [""] },
  { files: [" "] },
  { files: ["file", "file"] },
  { files: ["file"], revision: " " },
])("rejects empty or duplicate reuse opt-ins %j", (reuse: ReuseOptions) => {
  expect(() =>
    createWorkflow({
      id: "declarations",
      root: process.cwd(),
      stages: [stage({ id: "source", reuse, run: () => null })],
    }),
  ).toThrowError(expect.objectContaining({ code: "invalid_declaration" }));
});
it.runIf(process.platform === "win32")(
  "diagnoses unreadable required watches through the SDK using real Windows ACLs",
  async () => {
    const f = await fixture(),
      file = join(f.root, "source.txt");
    await writeFile(file, "bytes");
    const identity = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const sid = identity.stdout.match(/S-1-[\d-]+/)?.[0];
    if (!sid) throw new Error("Cannot determine Windows SID.");
    const acl = (...args: string[]) => {
      const result = spawnSync("icacls.exe", [file, ...args], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    };
    let calls = 0;
    try {
      acl("/deny", `*${sid}:(R)`);
      const p = await prepare(
        createWorkflow({
          id: "acl",
          root: f.root,
          stages: [
            stage({
              id: "source",
              reuse: { files: [file] },
              run: () => {
                calls++;
                return null;
              },
            }),
          ],
        }),
        { baseline: null },
      );
      expect(p.preview.stages[0]?.details).toMatchObject({
        error: { code: "influence_unavailable" },
      });
      expect((await p.execute()).stages[0]?.error).toMatchObject({
        code: "influence_unavailable",
        causeCode: expect.stringMatching(/EACCES|EPERM/),
      });
      expect(calls).toBe(0);
    } finally {
      acl("/remove:d", `*${sid}`);
    }
  },
);
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "diagnoses unreadable required watches through POSIX mode bits",
  async () => {
    const f = await fixture(),
      file = join(f.root, "source.txt");
    await writeFile(file, "bytes");
    let calls = 0;
    try {
      await chmod(file, 0);
      const p = await prepare(
        createWorkflow({
          id: "permissions",
          root: f.root,
          stages: [
            stage({
              id: "source",
              reuse: { files: [file] },
              run: () => {
                calls++;
                return null;
              },
            }),
          ],
        }),
        { baseline: null },
      );
      expect(p.preview.stages[0]?.details).toMatchObject({
        error: { code: "influence_unavailable" },
      });
      expect((await p.execute()).stages[0]?.error).toMatchObject({
        code: "influence_unavailable",
        causeCode: "EACCES",
      });
      expect(calls).toBe(0);
    } finally {
      await chmod(file, 0o600);
    }
  },
);
