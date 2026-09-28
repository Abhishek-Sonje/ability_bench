import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defineWorkflow, diffRunManifests, runWorkflow } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function workflow(root: string, branchId: string, cacheable = false) {
  const cachePolicy = cacheable
    ? ({ cache: true, watch: ["source.ts"] } as const)
    : ({ cache: false, watch: [] } as const);
  return defineWorkflow({ id: "evolving-workflow", root })
    .stage({
      id: "source",
      dependsOn: [],
      implementation: "source-v1",
      inputs: [],
      env: [],
      ...cachePolicy,
      run: () => ({ value: 1 }),
    })
    .stage({
      id: branchId,
      dependsOn: ["source"],
      implementation: `${branchId}-v1`,
      inputs: [],
      env: [],
      ...cachePolicy,
      // biome-ignore lint/complexity/useLiteralKeys: strict index-signature access requires brackets.
      run: ({ dependencies }) => ({ source: dependencies["source"] ?? null }),
    })
    .build();
}

describe("immutable run diff", () => {
  it("reports unchanged, removed, and added stages in stable order", async () => {
    const root = await mkdtemp(join(tmpdir(), "abilitybench-diff-"));
    roots.push(root);
    const before = await runWorkflow(workflow(root, "old-branch"), {
      inputs: {},
      baseline: null,
      environment: {},
    });
    const after = await runWorkflow(workflow(root, "new-branch"), {
      inputs: {},
      baseline: null,
      environment: {},
    });

    const diff = diffRunManifests(before.manifest, after.manifest);
    expect(diff.summary).toEqual({ added: 1, removed: 1, changed: 0, unchanged: 1 });
    expect(diff.stages.map(({ stageId, kind }) => [stageId, kind])).toEqual([
      ["source", "unchanged"],
      ["old-branch", "removed"],
      ["new-branch", "added"],
    ]);
    expect(Object.isFrozen(diff)).toBe(true);
  });

  it("reports every changed persisted field deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "abilitybench-diff-"));
    roots.push(root);
    await writeFile(join(root, "source.ts"), "source-v1\n", "utf8");
    const built = workflow(root, "branch", true);
    const before = await runWorkflow(built, { inputs: {}, baseline: null, environment: {} });
    const after = await runWorkflow(built, {
      inputs: {},
      baseline: { runId: before.manifest.id },
      environment: {},
    });

    const diff = diffRunManifests(before.manifest, after.manifest);
    expect(diff.stages[0]).toMatchObject({
      stageId: "source",
      kind: "changed",
      changedFields: ["plannedDecision", "finalDecision", "decisionReason", "executionStatus"],
    });
    expect(diff.stages[0]?.before?.outputArtifactHash).toBe(
      diff.stages[0]?.after?.outputArtifactHash,
    );
  });
});
