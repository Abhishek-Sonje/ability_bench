import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function exercise(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), "abilitybench safety "));
  roots.push(root);
  const run = spawnSync(
    process.execPath,
    [resolve("tests/fixtures/experiment-safety.mjs"), scenario, root],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  expect(run.status, run.stderr + run.stdout).toBe(0);
  return JSON.parse(run.stdout);
}

describe("isolated token-limited experiment preparation", () => {
  it("reserves the entire bounded protocol and leaves real readiness blocked", async () => {
    const result = await exercise("success");
    expect(result.preflight).toMatchObject({
      reservationNanoUsd: 66620800,
      availableNanoUsd: 72687150,
      remainingAfterReservationNanoUsd: 6066350,
      arithmeticFits: true,
      readyForLive: false,
    });
    expect(result).toMatchObject({ calls: 1, disabledSdkRetries: true, manualRedirect: true });
    expect(result.manifest).toMatchObject({ status: "completed", exposureNanoUsd: 155000 });
  });
  it.each([
    "input-overrun",
    "invalid-counter",
    "missing-counter",
    "counter-timeout",
    "wrong-model",
    "destination",
    "query-key",
    "credentials",
    "unsafe-config",
    "multimodal",
    "request-size",
    "request-object",
    "aborted",
  ])("blocks %s without transport dispatch", async (scenario) => {
    const result = await exercise(scenario);
    expect(result.calls).toBe(0);
    expect(result.manifest.status).toBe("failed");
  });
  it.each(["retained-preflight", "policy-expansion"])(
    "rejects %s before dispatch",
    async (scenario) => {
      expect(await exercise(scenario)).toMatchObject({
        preflightRejected: true,
        calls: 0,
      });
    },
  );
  it.each(["model-cap", "concurrency"])(
    "bounds every underlying request in %s",
    async (scenario) => {
      const result = await exercise(scenario);
      expect(result.calls).toBeLessThanOrEqual(8);
      expect(result.manifest).toMatchObject({ status: "failed", failure: "attempt_limit" });
      expect(result.manifest.cumulativeExposureNanoUsd).toBeLessThanOrEqual(110000000);
    },
  );
  it("accounts the maximum unknown exposure without assuming successful retries", async () => {
    const result = await exercise("all-unknown");
    expect(result.calls).toBe(23);
    expect(result.manifest).toMatchObject({
      status: "completed",
      exposureNanoUsd: 66620800,
      cumulativeExposureNanoUsd: 103933650,
      counts: { model: 8, search: 12, fetch: 0, setup: 3 },
    });
  });
  it.each(["tool-cap", "setup-cap"])("enforces %s", async (scenario) => {
    const result = await exercise(scenario);
    expect(result.manifest).toMatchObject({ status: "failed", failure: "attempt_limit" });
    expect(result.calls).toBe(scenario === "tool-cap" ? 13 : 3);
  });
  it.each(["unsafe-tool", "session-binding", "private-url"])(
    "rejects %s after setup only",
    async (scenario) => {
      const result = await exercise(scenario);
      expect(result.calls).toBe(1);
      expect(result.manifest).toMatchObject({ status: "failed", failure: "unsafe_request" });
    },
  );
  it("rejects expanded session permissions before setup", async () => {
    expect(await exercise("unsafe-setup")).toMatchObject({
      calls: 0,
      manifest: { status: "failed" },
    });
  });
  it("blocks unexpected hidden Gemini retries and retains unknown failed exposure", async () => {
    const result = await exercise("hidden-retry");
    expect(result.calls).toBe(1);
    expect(result.manifest).toMatchObject({ status: "failed", exposureNanoUsd: 7577600 });
  });
  it.each([
    "redirect",
    "stream-size",
    "stream-timeout",
    "overall-timeout",
    "malformed",
    "thinking-overrun",
  ])("preserves failed evidence for %s", async (scenario) => {
    const result = await exercise(scenario);
    expect(result.calls).toBe(1);
    expect(result.manifest).toMatchObject({ status: "failed", exported: false });
    if (scenario.startsWith("stream")) expect(result.cancelled).toBe(true);
    if (scenario === "stream-size") expect(result.responseBytes).toBe(33);
    expect(result.manifest.exposureNanoUsd).toBeGreaterThan(0);
  });
  it.each([{ args: [] }, { args: ["--authorize-live-salesforce-bounded-v1"] }])(
    "never dispatches via the live entry point ($args)",
    ({ args }) => {
      const run = spawnSync(
        process.execPath,
        [resolve("examples/composio-capture/live.mjs"), ...args],
        { encoding: "utf8" },
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("No requests sent");
    },
  );
  it
    .skipIf(!existsSync(resolve("../composio-agent/node_modules/@google/genai/package.json")))
    .each([
      { scenario: "success", model: 6, tools: 4 },
      { scenario: "provider-retry", model: 7, tools: 4 },
      { scenario: "tool-retry", model: 6, tools: 5 },
    ])(
    "runs the unmodified installed SDKs against offline $scenario responses",
    async ({ scenario, model, tools }) => {
      const root = await mkdtemp(join(tmpdir(), "abilitybench SDK safety "));
      roots.push(root);
      const run = spawnSync(
        process.execPath,
        [
          resolve("examples/composio-capture/worker.mjs"),
          "experiment-mock",
          resolve("../composio-agent"),
          root,
          scenario,
        ],
        {
          encoding: "utf8",
          timeout: 20000,
        },
      );
      expect(run.status, run.stderr + run.stdout).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result).toMatchObject({
        status: "completed",
        counts: { model, setup: 1 },
        actualNetworkRequests: 0,
      });
      expect(result.counts.search + result.counts.fetch).toBe(tools);
    },
    25000,
  );
});
