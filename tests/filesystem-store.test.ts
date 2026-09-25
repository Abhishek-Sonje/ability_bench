import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createArtifact,
  defineWorkflow,
  executeWorkflow,
  FileArtifactStore,
  FileRunManifestStore,
  finalizeRunManifest,
  planWorkflow,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "abilitybench-storage-"));
  roots.push(root);
  return root;
}

async function manifestFixture(storageRoot: string) {
  const workflowRoot = join(storageRoot, "project");
  await mkdir(workflowRoot, { recursive: true });
  await writeFile(join(workflowRoot, "stage.ts"), "v1\n", "utf8");
  const workflow = defineWorkflow({ id: "filesystem-example", root: workflowRoot })
    .stage({
      id: "stage",
      dependsOn: [],
      implementation: "stage-v1",
      watch: ["stage.ts"],
      inputs: [],
      env: [],
      cache: true,
      run: () => ({ persisted: true }),
    })
    .build();
  const artifacts = new FileArtifactStore(storageRoot);
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
  return finalizeRunManifest({
    workflow,
    execution,
    createdAt: "2026-09-23T00:00:00.000Z",
    completedAt: "2026-09-23T00:00:01.000Z",
  });
}

describe("filesystem artifact storage", () => {
  it("writes once, deduplicates, and verifies artifacts when reading", async () => {
    const root = await temporaryRoot();
    const store = new FileArtifactStore(root);
    const artifact = createArtifact({ stable: true });
    await store.put(artifact);
    await store.put(artifact);

    const loaded = await store.get(artifact.contentHash);
    expect(loaded).toEqual(artifact);
    const objectDirectory = join(root, "objects", "sha256");
    expect(await readdir(objectDirectory)).toEqual([artifact.contentHash.slice("sha256:".length)]);
  });

  it("detects corrupted bytes at the content-addressed path", async () => {
    const root = await temporaryRoot();
    const store = new FileArtifactStore(root);
    const artifact = createArtifact({ stable: true });
    await store.put(artifact);
    const path = join(root, "objects", "sha256", artifact.contentHash.slice("sha256:".length));
    await writeFile(path, '{"stable":false}', "utf8");

    await expect(store.get(artifact.contentHash)).rejects.toMatchObject({
      code: "corrupt_artifact",
    });
  });

  it("rejects non-canonical identities before resolving paths", async () => {
    const store = new FileArtifactStore(await temporaryRoot());
    await expect(store.get("../../outside")).rejects.toMatchObject({
      code: "invalid_artifact_hash",
    });
  });

  it("cleans temporary content when immutable publication fails", async () => {
    const root = await temporaryRoot();
    const artifact = createArtifact({ stable: true });
    const objectDirectory = join(root, "objects", "sha256");
    const finalPath = join(objectDirectory, artifact.contentHash.slice("sha256:".length));
    await mkdir(finalPath, { recursive: true });

    await expect(new FileArtifactStore(root).put(artifact)).rejects.toMatchObject({
      code: "write_failed",
    });
    expect((await readdir(objectDirectory)).filter((entry) => entry.startsWith(".tmp-"))).toEqual(
      [],
    );
  });

  it("ignores stale temporary files left by an interrupted process", async () => {
    const root = await temporaryRoot();
    const objectDirectory = join(root, "objects", "sha256");
    await mkdir(objectDirectory, { recursive: true });
    await writeFile(join(objectDirectory, ".tmp-interrupted"), "partial", "utf8");
    const artifact = createArtifact({ committed: true });
    const store = new FileArtifactStore(root);

    expect(await store.get(artifact.contentHash)).toBeUndefined();
    await store.put(artifact);
    expect(await store.get(artifact.contentHash)).toEqual(artifact);
    expect(await readdir(objectDirectory)).toEqual([
      ".tmp-interrupted",
      artifact.contentHash.slice("sha256:".length),
    ]);
  });
});

describe("filesystem run-manifest storage", () => {
  it("atomically stores and verifies immutable manifests", async () => {
    const root = await temporaryRoot();
    const manifest = await manifestFixture(root);
    const store = new FileRunManifestStore(root);
    await store.put(manifest);
    await store.put(manifest);

    const loaded = await store.get(manifest.id);
    expect(loaded).toEqual(manifest);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded?.stages)).toBe(true);
    const entries = await readdir(join(root, "runs"));
    expect(entries).toEqual([`${manifest.id}.json`]);
    expect(entries.some((entry) => entry.startsWith(".tmp-"))).toBe(false);
  });

  it("detects manifest tampering and rejects path traversal", async () => {
    const root = await temporaryRoot();
    const manifest = await manifestFixture(root);
    const store = new FileRunManifestStore(root);
    await store.put(manifest);
    await writeFile(
      join(root, "runs", `${manifest.id}.json`),
      JSON.stringify({ ...manifest, completedAt: "2026-09-23T00:00:02.000Z" }),
      "utf8",
    );

    await expect(store.get(manifest.id)).rejects.toMatchObject({ code: "corrupt_manifest" });
    await expect(store.get("../outside")).rejects.toMatchObject({ code: "invalid_run_id" });
  });
});
