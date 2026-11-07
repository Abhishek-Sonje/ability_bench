import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function exercise(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), "abilitybench archie "));
  roots.push(root);
  const result = spawnSync(
    process.execPath,
    [resolve("tests/fixtures/archie-exercise.mjs"), scenario, root],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
describe("second existing-agent snapshot adapter", () => {
  it.each(["unchanged", "writer-change"])(
    "reuses the acquisition and gathering branches for %s",
    async (scenario) => {
      const result = await exercise(scenario);
      expect(result.candidate.executionStatus).toBe("completed");
      expect(
        result.candidate.stages.filter(
          (s: { executionStatus: string }) => s.executionStatus === "reused",
        ),
      ).toHaveLength(6);
      expect(
        result.candidate.stages.find((s: { stageId: string }) => s.stageId === "publish"),
      ).toMatchObject({ executionStatus: "succeeded", decisionReason: "cache_disabled" });
      expect(result.receipt).toMatchObject({
        evaluationStatus: "passed",
        comparisonStatus: "no_regressions",
      });
      expect(result).toMatchObject({ baselineUnchanged: true, providerCalls: 0 });
    },
  );
  it.each(["source-change", "prompt-change", "corrupt-capture"])(
    "rejects stale/invalid evidence after %s",
    async (scenario) => {
      const result = await exercise(scenario);
      expect(result.candidate.executionStatus).toBe("failed");
      expect(
        result.candidate.stages.find((s: { stageId: string }) => s.stageId === "architecture")
          .executionStatus,
      ).toBe("failed");
      expect(
        result.candidate.stages.find((s: { stageId: string }) => s.stageId === "publish")
          .executionStatus,
      ).toBe("skipped_dependency_failed");
      expect(result.providerCalls).toBe(0);
    },
  );
  it("revalidates manually without claiming a fresh acquisition", async () => {
    const result = await exercise("manual");
    expect(
      result.candidate.stages.find((s: { stageId: string }) => s.stageId === "architecture"),
    ).toMatchObject({ executionStatus: "succeeded", decisionReason: "manual_invalidation" });
    expect(result.providerCalls).toBe(0);
  });
  it("distinguishes successful execution from a genuine document regression", async () => {
    const result = await exercise("quality-regression");
    expect(result.candidate.executionStatus).toBe("completed");
    expect(result.receipt).toMatchObject({
      evaluationStatus: "failed",
      comparisonStatus: "regressed",
    });
  });
  it("reevaluates both retained sides with a changed evaluation policy", async () => {
    const result = await exercise("evaluation-change");
    expect(
      result.candidate.stages.filter(
        (s: { executionStatus: string }) => s.executionStatus === "reused",
      ),
    ).toHaveLength(6);
    expect(result.receipt).toMatchObject({
      evaluationStatus: "failed",
      comparisonStatus: "no_regressions",
    });
  });
  it("rejects a corrupt cached artifact", async () => {
    const result = await exercise("corrupt-artifact");
    expect(result.candidate.executionStatus).toBe("failed");
    expect(
      result.candidate.stages.find((s: { stageId: string }) => s.stageId === "architecture"),
    ).toMatchObject({
      executionStatus: "failed",
      decisionReason: "baseline_artifact_unavailable",
    });
  });
  it("rejects incorrectly typed controls", async () => {
    const result = await exercise("typed-input");
    expect(result.candidate.executionStatus).toBe("failed");
    expect(
      result.candidate.stages.find((s: { stageId: string }) => s.stageId === "publish").error.name,
    ).toBe("InputValidationError");
  });
  it("preserves exact bytes through the original write contract", async () => {
    expect(await exercise("publish")).toMatchObject({
      outputMatches: true,
      baselineUnchanged: true,
    });
  });
  it("contains publication failure to its non-cacheable stage", async () => {
    const result = await exercise("publish-failure");
    expect(result.candidate.executionStatus).toBe("failed");
    expect(
      result.candidate.stages.find((s: { stageId: string }) => s.stageId === "publish")
        .executionStatus,
    ).toBe("failed");
  });
});
