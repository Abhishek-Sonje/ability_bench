import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defineWorkflow,
  executeWorkflow,
  finalizeRunManifest,
  InMemoryArtifactStore,
  manifestToBaseline,
  planWorkflow,
  verifyRunManifest,
  type WorkflowExecutionResult,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function completedRun() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench-manifest-"));
  roots.push(root);
  await writeFile(join(root, "source.ts"), "v1\n", "utf8");
  const workflow = defineWorkflow({ id: "manifest-example", root })
    .stage({
      id: "source",
      dependsOn: [],
      implementation: "source-v1",
      watch: ["source.ts"],
      inputs: [],
      env: [],
      cache: true,
      run: () => ({ value: 1 }),
    })
    .stage({
      id: "consumer",
      dependsOn: ["source"],
      implementation: "consumer-v1",
      watch: ["source.ts"],
      inputs: [],
      env: [],
      cache: true,
      run: ({ dependencies }) => ({ received: Object.values(dependencies)[0] ?? null }),
    })
    .build();
  const artifacts = new InMemoryArtifactStore();
  const plan = await planWorkflow({
    workflow,
    inputs: {},
    environment: {},
    baseline: null,
    invalidate: [],
  });
  const execution = await executeWorkflow({
    workflow,
    plan,
    inputs: {},
    environment: {},
    artifacts,
  });
  return { workflow, execution, artifacts };
}

describe("content-addressed run manifests", () => {
  it("creates a stable immutable ID from the finalized manifest body", async () => {
    const { workflow, execution } = await completedRun();
    const request = {
      workflow,
      execution,
      createdAt: "2026-09-23T00:00:00.000Z",
      completedAt: "2026-09-23T00:00:01.000Z",
    };
    const first = finalizeRunManifest(request);
    const second = finalizeRunManifest(request);

    expect(first.id).toMatch(/^run_[a-f0-9]{64}$/);
    expect(first.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.stages)).toBe(true);
    expect(() => verifyRunManifest(first)).not.toThrow();
  });

  it("detects manifest-body and run-ID replacement", async () => {
    const { workflow, execution } = await completedRun();
    const manifest = finalizeRunManifest({
      workflow,
      execution,
      createdAt: "2026-09-23T00:00:00.000Z",
      completedAt: "2026-09-23T00:00:01.000Z",
    });

    expect(() =>
      verifyRunManifest({ ...manifest, completedAt: "2026-09-23T00:00:02.000Z" }),
    ).toThrowError(expect.objectContaining({ code: "invalid_manifest_hash" }));
    expect(() => verifyRunManifest({ ...manifest, id: "run_replaced" })).toThrowError(
      expect.objectContaining({ code: "invalid_run_id" }),
    );
    expect(() =>
      verifyRunManifest({ ...manifest, unverified: true } as typeof manifest),
    ).toThrowError(expect.objectContaining({ code: "invalid_manifest_hash" }));
  });

  it("re-verifies referenced artifacts when creating a baseline", async () => {
    const { workflow, execution, artifacts } = await completedRun();
    const manifest = finalizeRunManifest({
      workflow,
      execution,
      createdAt: "2026-09-23T00:00:00.000Z",
      completedAt: "2026-09-23T00:00:01.000Z",
    });
    const sourceHash = manifest.stages.find(
      ({ stageId }) => stageId === "source",
    )?.outputArtifactHash;
    if (sourceHash === null || sourceHash === undefined) throw new Error("Missing source hash.");
    artifacts.delete(sourceHash);

    const baseline = await manifestToBaseline(manifest, artifacts);
    expect(baseline.id).toBe(manifest.id);
    expect(baseline.manifestHash).toBe(manifest.manifestHash);
    expect(baseline.stages.find(({ stageId }) => stageId === "source")?.artifactAvailable).toBe(
      false,
    );
    expect(baseline.stages.find(({ stageId }) => stageId === "consumer")?.artifactAvailable).toBe(
      true,
    );
  });

  it("does not allow failed executions to become baselines", async () => {
    const { workflow, execution, artifacts } = await completedRun();
    const failed = {
      ...execution,
      executionStatus: "failed",
    } as WorkflowExecutionResult;
    const manifest = finalizeRunManifest({
      workflow,
      execution: failed,
      createdAt: "2026-09-23T00:00:00.000Z",
      completedAt: "2026-09-23T00:00:01.000Z",
    });

    await expect(manifestToBaseline(manifest, artifacts)).rejects.toMatchObject({
      code: "manifest_not_completed",
    });
  });
});
