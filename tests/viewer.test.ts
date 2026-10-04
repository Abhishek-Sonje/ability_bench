import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEvaluationSuite,
  defineCheck,
  defineWorkflow,
  evaluateRunPair,
  input,
  runWorkflow,
} from "../src/index.js";
import { VIEWER_LIMITS, ViewerData } from "../src/viewer-data.js";
import { createViewerServer } from "../src/viewer-server.js";
import { explanation, layout, status } from "../viewer/model.js";

const roots: string[] = [];
const servers: ReturnType<typeof createViewerServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench-viewer-"));
  roots.push(root);
  return root;
}

async function fixture() {
  const root = await temporary();
  await writeFile(join(root, "workflow.ts"), "original workflow");
  await writeFile(join(root, "evaluation.ts"), "original evaluator");
  const builder = defineWorkflow({ id: "independent", root });
  const callback = vi.fn();
  for (const [id, dependsOn, cache] of [
    ["load", [], true],
    ["analyze", ["load"], false],
    ["copy-dataset", ["load"], false],
    ["copy-analysis", ["analyze"], false],
    ["report", ["analyze"], true],
    ["verify", ["copy-dataset", "copy-analysis"], false],
  ] as const)
    builder.stage({
      id,
      dependsOn: [...dependsOn],
      implementation: "v1",
      watch: ["workflow.ts"],
      inputs: ["/count"],
      env: id === "copy-dataset" ? ["FAIL_COPY"] : [],
      ...(cache ? { cache: true as const } : { cache: false as const }),
      run: ({ inputs, env }) => {
        callback(id);
        if (id === "copy-dataset" && env["FAIL_COPY"] === "yes") throw new Error("Copy failed");
        return {
          count: inputs["/count"] ?? 0,
          label: "<script>alert('untrusted output')</script>",
        };
      },
    });
  const workflow = builder.build();
  const baseline = await runWorkflow(workflow, {
    baseline: null,
    inputs: { count: 2 },
    environment: { FAIL_COPY: "no" },
  });
  const candidate = await runWorkflow(workflow, {
    baseline: { runId: baseline.manifest.id },
    inputs: { count: 2 },
    environment: { FAIL_COPY: "no" },
  });
  const changed = await runWorkflow(workflow, {
    baseline: { runId: baseline.manifest.id },
    inputs: { count: 1 },
    environment: { FAIL_COPY: "no" },
  });
  const failed = await runWorkflow(workflow, {
    baseline: { runId: baseline.manifest.id },
    inputs: { count: 2 },
    environment: { FAIL_COPY: "yes" },
  });
  const evaluate = vi.fn(({ output }: { output: { count: number } }) => ({
    passed: output.count >= 2,
    details: { count: output.count },
  }));
  const suite = createEvaluationSuite({
    id: "count",
    workflowId: "independent",
    root,
    checks: [
      defineCheck({
        id: "minimum",
        targetStage: "report",
        outputInputs: { count: input.number("/count") },
        revision: "v1",
        files: ["evaluation.ts"],
        evaluate,
      }),
    ],
  });
  const receipt = await evaluateRunPair(suite, {
    baselineRunId: baseline.manifest.id,
    candidateRunId: changed.manifest.id,
    criteria: {},
  });
  callback.mockClear();
  evaluate.mockClear();
  const storage = join(root, ".abilitybench");
  return {
    root,
    storage,
    baseline: baseline.manifest,
    candidate: candidate.manifest,
    changed: changed.manifest,
    failed: failed.manifest,
    receipt,
    callback,
    evaluate,
    data: new ViewerData(storage, "independent"),
  };
}

async function snapshot(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))
      .map(async (entry) => ({
        path: join(entry.parentPath, entry.name),
        directory: entry.isDirectory(),
        hash: entry.isFile()
          ? createHash("sha256")
              .update(await readFile(join(entry.parentPath, entry.name)))
              .digest("hex")
          : null,
      })),
  );
}

describe("read-only viewer evidence", () => {
  it("reads a branched/joined history and exact receipts without current modules, callbacks, or writes", async () => {
    const f = await fixture();
    await rm(join(f.root, "workflow.ts"));
    await rm(join(f.root, "evaluation.ts"));
    const before = await snapshot(f.storage);
    expect((await f.data.history()).runs).toHaveLength(4);
    const pair = await f.data.run(f.candidate.id);
    expect(pair.baseline).toEqual(f.baseline);
    expect(pair.candidate.stages.find((stage) => stage.stageId === "load")?.executionStatus).toBe(
      "reused",
    );
    expect(await f.data.artifact(f.candidate.id, "report")).toMatchObject({
      verification: "verified",
      value: { count: 2 },
    });
    expect(await f.data.receipt(f.changed.id, f.receipt.id)).toEqual(f.receipt);
    expect(f.receipt.evaluationStatus).toBe("failed");
    expect(f.receipt.comparisonStatus).toBe("regressed");
    expect(f.candidate.evaluationStatus).toBe("not_run");
    expect(await snapshot(f.storage)).toEqual(before);
    expect(f.callback).not.toHaveBeenCalled();
    expect(f.evaluate).not.toHaveBeenCalled();
  });

  it("explains conservative propagation and distinguishes dependency skipping from fail-fast", async () => {
    const f = await fixture();
    const report = f.candidate.stages.find((stage) => stage.stageId === "report");
    expect(report?.decisionReason).toBe("dependency_executed");
    expect(report && explanation(report)).toContain("identical bytes");
    const blocked = f.failed.stages.find((stage) => stage.stageId === "verify");
    const stopped = f.failed.stages.find((stage) => stage.stageId === "report");
    expect(blocked && explanation(blocked)).toContain("declared dependency failed");
    expect(stopped && explanation(stopped)).toContain("fail-fast");
    expect(stopped && status(stopped)).toBe("Skipped · run stopped");
    const graph = layout([...f.candidate.stages]);
    const verify = graph.nodes.find((node) => node.stage.stageId === "verify");
    expect(verify?.stage.dependencyIds).toHaveLength(2);
    expect(new Set(graph.nodes.map((node) => node.x)).size).toBeGreaterThan(1);
    const first = f.candidate.stages[0];
    if (!first) throw new Error("Missing fixture stage");
    expect(() => layout([{ ...first, dependencyIds: ["missing"] }])).toThrow("missing or cyclic");
  });

  it("does not create missing stores and rejects arbitrary IDs, wrong workflows, stages, and receipts", async () => {
    const root = await temporary();
    const missing = join(root, "absent");
    expect(await new ViewerData(missing, "none").history()).toMatchObject({
      runs: [],
      storeStatus: "missing",
    });
    expect(await readdir(root)).toEqual([]);
    const f = await fixture();
    await expect(f.data.run("../outside")).rejects.toMatchObject({ code: "invalid_run_id" });
    await expect(new ViewerData(f.storage, "wrong").run(f.candidate.id)).rejects.toMatchObject({
      code: "workflow_mismatch",
    });
    await expect(f.data.artifact(f.candidate.id, "missing")).rejects.toMatchObject({
      code: "stage_not_found",
    });
    await expect(f.data.receipt(f.candidate.id, f.receipt.id)).rejects.toMatchObject({
      code: "receipt_pair_mismatch",
    });
    await expect(f.data.receipt(f.changed.id, "../outside")).rejects.toMatchObject({
      code: "invalid_receipt_id",
    });
  });

  it("reports corrupt manifests/artifacts rather than treating them as empty history", async () => {
    const f = await fixture();
    const stage = f.candidate.stages[0];
    if (!stage?.outputArtifactHash) throw new Error("Missing fixture artifact");
    await writeFile(
      join(f.storage, "objects", "sha256", stage.outputArtifactHash.slice(7)),
      "corrupt",
    );
    await expect(f.data.artifact(f.candidate.id, stage.stageId)).rejects.toMatchObject({
      code: "corrupt_artifact",
    });
    await expect(f.data.receipt(f.changed.id, f.receipt.id)).rejects.toMatchObject({
      code: "corrupt_artifact",
    });
    await writeFile(join(f.storage, "runs", `${f.candidate.id}.json`), "{}");
    await expect(f.data.history()).rejects.toMatchObject({ code: "corrupt_manifest" });
  });

  it("rejects missing baselines and corrupt receipts", async () => {
    const f = await fixture();
    await writeFile(join(f.storage, "evaluations", `${f.receipt.id}.json`), "{}");
    await expect(f.data.receipt(f.changed.id, f.receipt.id)).rejects.toMatchObject({
      code: "invalid_receipt",
    });
    await rm(join(f.storage, "runs", `${f.baseline.id}.json`));
    await expect(f.data.run(f.candidate.id)).rejects.toMatchObject({ code: "run_missing" });
  });

  it("bounds record reads and refuses oversized previews without claiming verified bytes", async () => {
    const f = await fixture();
    const stage = f.candidate.stages[0];
    if (!stage?.outputArtifactHash) throw new Error("Missing fixture artifact");
    await writeFile(
      join(f.storage, "objects", "sha256", stage.outputArtifactHash.slice(7)),
      "x".repeat(VIEWER_LIMITS.previewBytes + 1),
    );
    expect(await f.data.artifact(f.candidate.id, stage.stageId)).toMatchObject({
      verification: "not_previewed",
      value: null,
    });
    await writeFile(
      join(f.storage, "runs", `${f.candidate.id}.json`),
      "x".repeat(VIEWER_LIMITS.recordBytes + 1),
    );
    await expect(f.data.run(f.candidate.id)).rejects.toMatchObject({ code: "record_limit" });
  });

  it("refuses symlinked storage directories before a referenced artifact is read", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await rm(join(f.storage, "objects", "sha256"), { recursive: true });
    await symlink(
      outside,
      join(f.storage, "objects", "sha256"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(f.data.artifact(f.candidate.id, "load")).rejects.toMatchObject({
      code: "unsafe_store",
    });
    await expect(f.data.receipt(f.changed.id, f.receipt.id)).rejects.toMatchObject({
      code: "unsafe_store",
    });
  });

  it("serves only fixed assets and same-origin GET reads, without changing storage", async () => {
    const f = await fixture();
    const before = await snapshot(f.storage);
    const server = createViewerServer(f.data);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback address");
    expect(address.address).toBe("127.0.0.1");
    const origin = `http://127.0.0.1:${address.port}`;
    const page = await fetch(origin);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain("57cdaeb7");
    for (const asset of ["/app.js", "/model.js", "/styles.css"])
      expect((await fetch(origin + asset)).status).toBe(200);
    expect((await fetch(`${origin}/api/run?run=${f.candidate.id}`)).status).toBe(200);
    expect(
      (await fetch(`${origin}/api/receipt?run=${f.changed.id}&receipt=${f.receipt.id}`)).status,
    ).toBe(200);
    for (const headers of [
      { Origin: "https://attacker.test" },
      { Host: "attacker.test" },
      { "Sec-Fetch-Site": "cross-site" },
    ]) {
      // Native fetch can rewrite forbidden headers; send these probes over raw HTTP.
      const statusCode = await new Promise<number | undefined>((resolve, reject) => {
        const probe = request(`${origin}/api/history`, { headers }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        });
        probe.on("error", reject);
        probe.end();
      });
      expect(statusCode, JSON.stringify(headers)).toBe(403);
    }
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"])
      expect((await fetch(`${origin}/api/history`, { method })).status).toBe(405);
    expect(
      (await fetch(`${origin}/api/run?run=${f.candidate.id}&run=${f.baseline.id}`)).status,
    ).toBe(400);
    expect((await fetch(`${origin}/api/history?path=outside`)).status).toBe(400);
    expect((await fetch(`${origin}/objects/sha256/arbitrary`)).status).toBe(404);
    expect(
      (await fetch(`${origin}/api/artifact?run=${f.candidate.id}&stage=load&hash=arbitrary`))
        .status,
    ).toBe(400);
    await writeFile(join(f.storage, "runs", `${f.candidate.id}.json`), "{}");
    const error = await fetch(`${origin}/api/run?run=${f.candidate.id}`);
    expect(error.status).toBe(409);
    expect(await error.text()).not.toContain(f.storage);
    // Restore the test corruption, then verify every retained entry and byte.
    const { canonicalizeJson } = await import("../src/serialization.js");
    await writeFile(
      join(f.storage, "runs", `${f.candidate.id}.json`),
      canonicalizeJson(f.candidate),
    );
    expect(await snapshot(f.storage)).toEqual(before);
  });
});
