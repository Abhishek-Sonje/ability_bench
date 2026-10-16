import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface Attempt {
  kind: string;
  callId: string;
  requestId: string;
  reservationNanoUsd: number;
  chargedNanoUsd: number;
  usageKnown: boolean;
  httpStatus: number | null;
  modelVersion: string | null;
  elapsedMs: number;
  failure: string | null;
  structuredTextSyntax: string;
  usage: {
    input: number;
    output: number;
    thinking: number;
    cached: number;
    total: number;
    costNanoUsd: number;
  } | null;
}
interface Capture {
  directory: string;
  calls: number;
  requestUnchanged: boolean;
  rejectedConcurrent: boolean;
  resetRejected?: boolean;
  corruptionRejected?: boolean;
  lockRejected?: boolean;
  result: unknown;
  previous?: Capture["manifest"];
  manifest: {
    status: string;
    failure: string | null;
    exported: boolean;
    counts: Record<string, number>;
    attempts: Attempt[];
    exposureNanoUsd: number;
    priorExposureNanoUsd: number;
    cumulativeExposureNanoUsd: number;
    capNanoUsd: number;
  };
}
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function exercise(scenario: string): Promise<Capture> {
  const root = await mkdtemp(join(tmpdir(), "abilitybench capture "));
  roots.push(root);
  const run = spawnSync(
    process.execPath,
    [resolve("tests/fixtures/capture-exercise.mjs"), scenario, root],
    { encoding: "utf8", timeout: 15000 },
  );
  expect(run.error).toBeUndefined();
  expect(run.status, run.stderr + run.stdout).toBe(0);
  expect(run.stdout + run.stderr).not.toContain("sensitive-fixture-canary");
  return JSON.parse(run.stdout) as Capture;
}

describe("opt-in mocked research capture boundary", () => {
  it("records real request-boundary usage fields without modifying the request", async () => {
    const capture = await exercise("success");
    expect(capture).toMatchObject({
      calls: 1,
      requestUnchanged: true,
      manifest: {
        status: "completed",
        exported: true,
        exposureNanoUsd: 202300,
        priorExposureNanoUsd: 37312850,
      },
    });
    expect(capture.manifest.attempts[0]).toMatchObject({
      kind: "model",
      usageKnown: true,
      modelVersion: "mock-version",
      httpStatus: 200,
      usage: { input: 100, output: 50, thinking: 20, cached: 10, total: 170, costNanoUsd: 202300 },
    });
    expect(capture.manifest.attempts[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(capture.manifest.attempts[0]?.requestId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("releases unused reservations for every known successful attempt", async () => {
    const capture = await exercise("reconcile");
    expect(capture.calls).toBe(2);
    expect(capture.manifest.exposureNanoUsd).toBe(404600);
    expect(
      capture.manifest.attempts.every(
        (attempt) => attempt.chargedNanoUsd < attempt.reservationNanoUsd,
      ),
    ).toBe(true);
  });

  it("counts hidden SDK retries separately while preserving logical request identity", async () => {
    const capture = await exercise("hidden-retry");
    expect(capture.calls).toBe(2);
    expect(capture.manifest.exposureNanoUsd).toBe(3788800 + 202300);
    const [first, second] = capture.manifest.attempts;
    expect(first).toMatchObject({ httpStatus: 503, usageKnown: false, chargedNanoUsd: 3788800 });
    expect(second).toMatchObject({ httpStatus: 200, usageKnown: true, chargedNanoUsd: 202300 });
    expect(first?.callId).toBe(second?.callId);
    expect(first?.requestId).toBe(second?.requestId);
  });

  it.each(["failed-usage", "known-failed-usage"])(
    "accounts provider errors including %s without leaking raw messages",
    async (scenario) => {
      const capture = await exercise(scenario);
      expect(capture.manifest).toMatchObject({ status: "failed", failure: "http_503" });
      expect(capture.manifest.exposureNanoUsd).toBe(scenario === "failed-usage" ? 3788800 : 202300);
      expect(capture.manifest.exported).toBe(false);
    },
  );

  it("settles known usage before a malformed consumer output fails", async () => {
    const capture = await exercise("malformed");
    expect(capture.manifest).toMatchObject({
      status: "failed",
      failure: "malformed_json",
      exposureNanoUsd: 202300,
      exported: false,
    });
    expect(capture.manifest.attempts[0]?.structuredTextSyntax).toBe("malformed_json");
  });

  it("retains a full reservation when successful HTTP usage is missing", async () => {
    const capture = await exercise("unknown-usage");
    expect(capture.manifest).toMatchObject({ status: "completed", exposureNanoUsd: 3788800 });
    expect(capture.manifest.attempts[0]?.usageKnown).toBe(false);
  });

  it.each(["timeout", "late-timeout", "overall-timeout"])(
    "seals %s failures and never rewrites evidence after late completion",
    async (scenario) => {
      const capture = await exercise(scenario);
      expect(capture.manifest).toMatchObject({
        status: "failed",
        failure: "timeout",
        exported: false,
      });
      expect(capture.manifest.exposureNanoUsd).toBe(scenario === "overall-timeout" ? 0 : 3788800);
    },
  );

  it("refuses concurrent capture scopes without disturbing the active scope", async () => {
    const capture = await exercise("same-process-concurrency");
    expect(capture.rejectedConcurrent).toBe(true);
    expect(capture.manifest.status).toBe("completed");
  });
  it("closes the boundary before unawaited work can dispatch or change a sealed package", async () => {
    const capture = await exercise("unfinished-requests");
    expect(capture.manifest).toMatchObject({
      status: "failed",
      failure: "unfinished_requests",
      exported: false,
    });
    expect(capture.calls).toBe(0);
  });

  it("serializes concurrent request reservations before any dispatch", async () => {
    const capture = await exercise("concurrent-requests");
    expect(capture.calls).toBe(1);
    expect(capture.manifest).toMatchObject({ status: "failed", failure: "attempt_limit" });
    expect(capture.manifest.cumulativeExposureNanoUsd).toBeLessThanOrEqual(
      capture.manifest.capNanoUsd,
    );
  });

  it("fails closed on another worker's budget lock", async () => {
    const capture = await exercise("cross-process-lock");
    expect(capture).toMatchObject({ lockRejected: true, calls: 0 });
  });
  it("prevents two independent worker processes from sharing an active capture account", async () => {
    const root = await mkdtemp(join(tmpdir(), "abilitybench capture workers "));
    roots.push(root);
    const script = resolve("tests/fixtures/capture-exercise.mjs");
    const holder = spawn(process.execPath, [script, "worker-hold", root], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    let stdout = "";
    let stderr = "";
    holder.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    holder.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const completion = new Promise<number | null>((done, reject) => {
      holder.once("error", reject);
      holder.once("close", done);
    });
    try {
      const deadline = Date.now() + 8000;
      while (true) {
        try {
          await readFile(join(root, "ready"));
          break;
        } catch {
          if (Date.now() > deadline) throw new Error(`Capture worker did not start: ${stderr}`);
        }
        await new Promise((done) => setTimeout(done, 10));
      }
      const contender = spawnSync(process.execPath, [script, "worker-contend", root], {
        encoding: "utf8",
        timeout: 5000,
      });
      expect(contender.status, contender.stderr).toBe(0);
      expect(JSON.parse(contender.stdout)).toMatchObject({ lockRejected: true, calls: 0 });
      await readFile(join(root, "budget/budget.lock"));
      await writeFile(join(root, "release"), "release");
      expect(await completion, stderr).toBe(0);
      expect(JSON.parse(stdout).manifest.status).toBe("completed");
    } finally {
      holder.kill();
    }
  });

  it.each(["budget", "cumulative-budget", "crash-reservation"])(
    "enforces %s without releasing unknown exposure",
    async (scenario) => {
      const capture = await exercise(scenario);
      expect(capture.manifest).toMatchObject({ status: "failed", failure: "budget_exhausted" });
      expect(capture.calls).toBe(scenario === "crash-reservation" ? 0 : 1);
      expect(capture.manifest.cumulativeExposureNanoUsd).toBeLessThanOrEqual(
        capture.manifest.capNanoUsd,
      );
    },
  );

  it("prevents resetting retained policy/exposure", async () => {
    const capture = await exercise("policy-reset");
    expect(capture.resetRejected).toBe(true);
  });

  it("records search attempts and errors separately from model usage", async () => {
    const capture = await exercise("tool-error");
    expect(capture.manifest.counts).toMatchObject({ search: 1, model: 0 });
    expect(capture.manifest.attempts[0]).toMatchObject({
      kind: "search",
      failure: "tool_error",
      usageKnown: false,
      chargedNanoUsd: 100000,
    });
    expect(capture.manifest.exported).toBe(false);
  });

  it("counts repeated underlying tool requests separately", async () => {
    const capture = await exercise("tool-retries");
    expect(capture.manifest.counts).toMatchObject({ search: 2, model: 1 });
    expect(capture.manifest.attempts.filter((attempt) => attempt.kind === "search")).toHaveLength(
      2,
    );
  });

  it.each(["unsafe-tool", "request-limit"])("blocks %s before dispatch", async (scenario) => {
    const capture = await exercise(scenario);
    expect(capture.calls).toBe(0);
    expect(capture.manifest.status).toBe("failed");
  });

  it.each(["private-result", "private-url", "private-email"])(
    "refuses %s exports without sanitizing agent output into a pass",
    async (scenario) => {
      const capture = await exercise(scenario);
      expect(capture.manifest).toMatchObject({
        status: "failed",
        failure: "private_export",
        exported: false,
      });
      expect(await readdir(capture.directory)).not.toContain("result.json");
    },
  );

  it("defaults to metadata-only capture without public-result approval", async () => {
    const capture = await exercise("metadata-only");
    expect(capture.manifest).toMatchObject({ status: "completed", exported: false });
    expect(capture.result).toBeNull();
  });

  it.each(["invalid-usage", "overrun", "provider-exception"])(
    "preserves conservative evidence for %s",
    async (scenario) => {
      const capture = await exercise(scenario);
      expect(capture.manifest.status).toBe("failed");
      expect(capture.manifest.exported).toBe(false);
      expect(capture.manifest.exposureNanoUsd).toBeGreaterThan(0);
    },
  );

  it("leaves old captures immutable and rejects changed content", async () => {
    const capture = await exercise("immutability");
    expect(capture.corruptionRejected).toBe(true);
    expect(await readFile(join(capture.directory, "result.json"), "utf8")).toBe(
      '{"note":"approved public result"}',
    );
  });
});
