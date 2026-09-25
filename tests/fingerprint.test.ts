import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { computeStageFingerprint, defineWorkflow, type StageDefinition } from "../src/index.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "abilitybench-fingerprint-"));
  temporaryRoots.push(root);
  await writeFile(join(root, "stage.ts"), "export const value = 1;\n", "utf8");
  return root;
}

function stage(
  root: string,
  overrides: { inputs?: string[]; env?: string[]; watch?: string[] } = {},
) {
  return defineWorkflow({ id: "fingerprint-example", root })
    .stage({
      id: "child",
      dependsOn: ["parent"],
      implementation: "child-v1",
      watch: overrides.watch ?? ["stage.ts"],
      inputs: overrides.inputs ?? ["/dataset", "/missing"],
      env: overrides.env ?? ["EMPTY", "RULESET", "UNSET"],
      cache: true,
      run: () => null,
    })
    .stage({
      id: "parent",
      dependsOn: [],
      implementation: "parent-v1",
      watch: ["stage.ts"],
      inputs: [],
      env: [],
      cache: true,
      run: () => null,
    })
    .build()
    .stages.find(({ id }) => id === "child") as StageDefinition;
}

async function fingerprint(root: string, definition = stage(root)) {
  return computeStageFingerprint({
    workflowId: "fingerprint-example",
    workflowRoot: root,
    stage: definition,
    runInputs: { ignored: true, dataset: { b: 2, a: 1 } },
    environment: { RULESET: "v1", EMPTY: "" },
    dependencyArtifacts: { parent: `sha256:${"a".repeat(64)}` },
  });
}

describe("stage fingerprints", () => {
  it("is stable across timestamps, declaration order, and input key order", async () => {
    const root = await fixtureRoot();
    const first = await fingerprint(root);
    await utimes(join(root, "stage.ts"), new Date(1_000), new Date(2_000));
    const reordered = stage(root, {
      inputs: ["/missing", "/dataset"],
      env: ["UNSET", "RULESET", "EMPTY"],
    });
    const second = await computeStageFingerprint({
      workflowId: "fingerprint-example",
      workflowRoot: root,
      stage: reordered,
      runInputs: { dataset: { a: 1, b: 2 }, ignored: true },
      environment: { EMPTY: "", RULESET: "v1" },
      dependencyArtifacts: { parent: `sha256:${"a".repeat(64)}` },
    });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.componentHashes).toEqual(first.componentHashes);
  });

  it("changes only the watched-file component when bytes change", async () => {
    const root = await fixtureRoot();
    const first = await fingerprint(root);
    await writeFile(join(root, "stage.ts"), "export const value = 2;\n", "utf8");
    const second = await fingerprint(root);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.componentHashes.watchedFiles).not.toBe(first.componentHashes.watchedFiles);
    expect(second.componentHashes.selectedInputs).toBe(first.componentHashes.selectedInputs);
  });

  it("distinguishes missing, empty, and populated environment values without persisting values", async () => {
    const root = await fixtureRoot();
    const definition = stage(root, { env: ["VALUE"] });
    const calculate = (environment: Record<string, string>) =>
      computeStageFingerprint({
        workflowId: "fingerprint-example",
        workflowRoot: root,
        stage: definition,
        runInputs: {},
        environment,
        dependencyArtifacts: { parent: "artifact" },
      });
    const missing = await calculate({});
    const empty = await calculate({ VALUE: "" });
    const populated = await calculate({ VALUE: "secret" });
    expect(new Set([missing.fingerprint, empty.fingerprint, populated.fingerprint]).size).toBe(3);
    expect(JSON.stringify(populated.manifest)).not.toContain("secret");
  });

  it("represents a missing watched file explicitly", async () => {
    const root = await fixtureRoot();
    const result = await fingerprint(root, stage(root, { watch: ["missing.ts"] }));
    expect(result.manifest.watchedFiles).toEqual([{ path: "missing.ts", state: "missing" }]);
  });

  it("rejects a watched directory as an invalid target", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "watched-directory"));
    await expect(
      fingerprint(root, stage(root, { watch: ["watched-directory"] })),
    ).rejects.toMatchObject({
      code: "invalid_watch_target",
    });
  });

  it("rejects a missing watched path beneath a regular file", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "not-a-directory"), "file\n", "utf8");
    await expect(
      fingerprint(root, stage(root, { watch: ["not-a-directory/child.ts"] })),
    ).rejects.toMatchObject({
      code: "invalid_watch_target",
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects an unreadable watched file on POSIX",
    async () => {
      const root = await fixtureRoot();
      const path = join(root, "unreadable.ts");
      await writeFile(path, "private\n", "utf8");
      await chmod(path, 0);
      try {
        await expect(
          fingerprint(root, stage(root, { watch: ["unreadable.ts"] })),
        ).rejects.toMatchObject({
          code: "watch_read_failed",
        });
      } finally {
        await chmod(path, 0o600);
      }
    },
  );

  it("fails when a dependency artifact identity is absent", async () => {
    const root = await fixtureRoot();
    await expect(
      computeStageFingerprint({
        workflowId: "fingerprint-example",
        workflowRoot: root,
        stage: stage(root),
        runInputs: {},
        environment: {},
        dependencyArtifacts: {},
      }),
    ).rejects.toMatchObject({ code: "dependency_artifact_missing" });
  });

  it("rejects an existing watched file through a parent junction outside the root", async () => {
    const root = await fixtureRoot();
    const outside = await fixtureRoot();
    await writeFile(join(outside, "secret.ts"), "outside\n", "utf8");
    await symlink(outside, join(root, "linked"), "junction");
    await expect(
      fingerprint(root, stage(root, { watch: ["linked/secret.ts"] })),
    ).rejects.toMatchObject({
      code: "watch_path_escaped",
    });
  });

  it("rejects a missing watched file through a parent junction outside the root", async () => {
    const root = await fixtureRoot();
    const outside = await fixtureRoot();
    await symlink(outside, join(root, "linked"), "junction");
    await expect(
      fingerprint(root, stage(root, { watch: ["linked/missing.ts"] })),
    ).rejects.toMatchObject({
      code: "watch_path_escaped",
    });
  });
});
