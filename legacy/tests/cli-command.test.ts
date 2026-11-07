import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type CliIo, runCli } from "../src/index.js";

const fixtureRoot = resolve("tests/fixtures/loaded-workflow");
const configPath = join(fixtureRoot, "abilitybench.config.ts");
const storagePath = join(fixtureRoot, ".abilitybench");
const releaseExampleRoot = resolve("examples/release-readiness");
const releaseConfigPath = join(releaseExampleRoot, "abilitybench.config.ts");
const releaseStoragePath = join(releaseExampleRoot, ".abilitybench");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await rm(storagePath, { recursive: true, force: true });
  await rm(releaseStoragePath, { recursive: true, force: true });
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function inputFile(value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "abilitybench-cli-"));
  temporaryRoots.push(root);
  const path = join(root, "inputs.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    cwd: process.cwd(),
    environment: {},
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  return { io, stderr, stdout };
}

describe("run CLI", () => {
  it("runs once and reuses one explicitly selected baseline", async () => {
    const inputs = await inputFile({});
    const first = capture();
    expect(
      await runCli(["run", "--config", configPath, "--inputs", inputs, "--json"], first.io),
    ).toBe(0);
    expect(first.stderr).toEqual([]);
    const firstResult = JSON.parse(first.stdout.join("")) as {
      runId: string;
      baselineRunId: string | null;
      stages: Array<{ finalDecision: string; reason: string }>;
    };
    expect(firstResult.baselineRunId).toBeNull();
    expect(firstResult.stages).toEqual([
      expect.objectContaining({ finalDecision: "execute", reason: "no_baseline" }),
    ]);

    const second = capture();
    expect(
      await runCli(
        [
          "run",
          "--config",
          configPath,
          "--inputs",
          inputs,
          "--baseline",
          firstResult.runId,
          "--json",
        ],
        second.io,
      ),
    ).toBe(0);
    const secondResult = JSON.parse(second.stdout.join("")) as {
      baselineRunId: string | null;
      stages: Array<{ finalDecision: string; reason: string }>;
    };
    expect(secondResult.baselineRunId).toBe(firstResult.runId);
    expect(secondResult.stages).toEqual([
      expect.objectContaining({ finalDecision: "reuse", reason: "fingerprint_match" }),
    ]);

    const invalidated = capture();
    expect(
      await runCli(
        [
          "run",
          "--config",
          configPath,
          "--inputs",
          inputs,
          "--baseline",
          firstResult.runId,
          "--invalidate",
          "source",
          "--json",
        ],
        invalidated.io,
      ),
    ).toBe(0);
    const invalidatedResult = JSON.parse(invalidated.stdout.join("")) as {
      schemaVersion: string;
      stages: Array<{ finalDecision: string; reason: string }>;
    };
    expect(invalidatedResult.schemaVersion).toBe("phase1-cli-result-v1");
    expect(invalidatedResult.stages).toEqual([
      expect.objectContaining({ finalDecision: "execute", reason: "manual_invalidation" }),
    ]);
  });

  it("prints a human explanation for every stage decision", async () => {
    const inputs = await inputFile({});
    const output = capture();
    expect(await runCli(["run", "--config", configPath, "--inputs", inputs], output.io)).toBe(0);
    expect(output.stdout.join("")).toMatch(/EXECUTE source \[succeeded\] no_baseline/);
  });

  it("prints a predictive plan without creating or changing run storage", async () => {
    const inputs = await inputFile({});
    const initial = capture();
    expect(
      await runCli(["plan", "--config", configPath, "--inputs", inputs, "--json"], initial.io),
    ).toBe(0);
    expect(JSON.parse(initial.stdout.join(""))).toMatchObject({
      schemaVersion: "phase1-cli-plan-v1",
      workflowId: "loaded-fixture",
      baselineRunId: null,
      summary: { execute: 1, reuse: 0 },
      decisions: [{ stageId: "source", decision: "execute", reason: "no_baseline" }],
    });
    await expect(stat(storagePath)).rejects.toMatchObject({ code: "ENOENT" });

    const run = capture();
    expect(
      await runCli(["run", "--config", configPath, "--inputs", inputs, "--json"], run.io),
    ).toBe(0);
    const runId = (JSON.parse(run.stdout.join("")) as { runId: string }).runId;
    const beforeRuns = await readdir(join(storagePath, "runs"));
    const before = await stat(join(storagePath, "runs", `${runId}.json`));

    const planned = capture();
    expect(
      await runCli(
        ["plan", "--config", configPath, "--inputs", inputs, "--baseline", runId],
        planned.io,
      ),
    ).toBe(0);
    expect(planned.stdout.join("")).toContain("Summary: 0 execute, 1 reuse");
    expect(planned.stdout.join("")).toContain("REUSE   source fingerprint_match");
    expect(await readdir(join(storagePath, "runs"))).toEqual(beforeRuns);
    const after = await stat(join(storagePath, "runs", `${runId}.json`));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("inspects one exact, integrity-checked run", async () => {
    const inputs = await inputFile({});
    const run = capture();
    expect(
      await runCli(["run", "--config", configPath, "--inputs", inputs, "--json"], run.io),
    ).toBe(0);
    const { runId } = JSON.parse(run.stdout.join("")) as { runId: string };

    const machine = capture();
    expect(await runCli(["inspect", runId, "--config", configPath, "--json"], machine.io)).toBe(0);
    expect(JSON.parse(machine.stdout.join(""))).toMatchObject({
      schemaVersion: "phase1-cli-inspect-v1",
      manifest: {
        id: runId,
        workflowId: "loaded-fixture",
        executionStatus: "completed",
        evaluationStatus: "not_run",
      },
    });

    const human = capture();
    expect(await runCli(["inspect", runId, "--config", configPath], human.io)).toBe(0);
    expect(human.stdout.join("")).toContain(`Run: ${runId}`);
    expect(human.stdout.join("")).toContain("EXECUTE source [succeeded] no_baseline");
  });

  it("rejects missing inspect runs and run-only options", async () => {
    const missing = capture();
    expect(
      await runCli(
        ["inspect", `run_${"0".repeat(64)}`, "--config", configPath, "--json"],
        missing.io,
      ),
    ).toBe(2);
    expect(missing.stdout).toEqual([]);
    expect(JSON.parse(missing.stderr.join(""))).toMatchObject({
      schemaVersion: "phase1-cli-error-v1",
      error: { name: "CliLookupError", code: "run_not_found" },
    });

    const invalidOptions = capture();
    expect(
      await runCli(
        ["inspect", `run_${"0".repeat(64)}`, "--config", configPath, "--baseline", "x", "--json"],
        invalidOptions.io,
      ),
    ).toBe(2);
    expect(JSON.parse(invalidOptions.stderr.join(""))).toMatchObject({
      schemaVersion: "phase1-cli-error-v1",
      error: { code: "invalid_arguments" },
    });
  });

  it("diffs two exact runs in machine and human formats", async () => {
    const inputs = await inputFile({});
    const first = capture();
    expect(
      await runCli(["run", "--config", configPath, "--inputs", inputs, "--json"], first.io),
    ).toBe(0);
    const firstId = (JSON.parse(first.stdout.join("")) as { runId: string }).runId;
    const second = capture();
    expect(
      await runCli(
        ["run", "--config", configPath, "--inputs", inputs, "--baseline", firstId, "--json"],
        second.io,
      ),
    ).toBe(0);
    const secondId = (JSON.parse(second.stdout.join("")) as { runId: string }).runId;

    const machine = capture();
    expect(
      await runCli(["diff", firstId, secondId, "--config", configPath, "--json"], machine.io),
    ).toBe(0);
    expect(JSON.parse(machine.stdout.join(""))).toMatchObject({
      schemaVersion: "phase1-run-diff-v1",
      from: { runId: firstId },
      to: { runId: secondId },
      summary: { added: 0, removed: 0, changed: 1, unchanged: 0 },
      stages: [{ stageId: "source", kind: "changed" }],
    });

    const human = capture();
    expect(await runCli(["diff", firstId, secondId, "--config", configPath], human.io)).toBe(0);
    expect(human.stdout.join("")).toContain("Summary: 0 added, 0 removed, 1 changed");
    expect(human.stdout.join("")).toContain("CHANGED   source");
  });

  it("requires exactly two run IDs for diff", async () => {
    const output = capture();
    expect(await runCli(["diff", `run_${"0".repeat(64)}`, "--config", configPath], output.io)).toBe(
      2,
    );
    expect(output.stderr.join("")).toContain("requires exactly two run IDs");
  });

  it("lists verified project runs newest-first with an explicit bound", async () => {
    const empty = capture();
    expect(await runCli(["runs", "--config", configPath, "--json"], empty.io)).toBe(0);
    expect(JSON.parse(empty.stdout.join(""))).toMatchObject({
      schemaVersion: "phase1-cli-runs-v1",
      workflowId: "loaded-fixture",
      order: "createdAt-desc-id-asc",
      totalMatched: 0,
      truncated: false,
      runs: [],
    });

    const inputs = await inputFile({});
    const first = capture();
    expect(
      await runCli(["run", "--config", configPath, "--inputs", inputs, "--json"], first.io),
    ).toBe(0);
    const firstId = (JSON.parse(first.stdout.join("")) as { runId: string }).runId;
    const second = capture();
    expect(
      await runCli(
        ["run", "--config", configPath, "--inputs", inputs, "--baseline", firstId, "--json"],
        second.io,
      ),
    ).toBe(0);
    const secondId = (JSON.parse(second.stdout.join("")) as { runId: string }).runId;

    const limited = capture();
    expect(
      await runCli(["runs", "--config", configPath, "--limit", "1", "--json"], limited.io),
    ).toBe(0);
    expect(JSON.parse(limited.stdout.join(""))).toMatchObject({
      limit: 1,
      totalMatched: 2,
      truncated: true,
      runs: [{ runId: secondId, baselineRunId: firstId, stageCount: 1 }],
    });

    const human = capture();
    expect(await runCli(["runs", "--config", configPath, "--limit", "1"], human.io)).toBe(0);
    expect(human.stdout.join("")).toContain("Showing: 1 of 2");
    expect(human.stdout.join("")).toContain(secondId);
    expect(human.stdout.join("")).toContain("Increase --limit");
  });

  it("rejects invalid run-list limits and command-specific options", async () => {
    const invalidLimit = capture();
    expect(await runCli(["runs", "--config", configPath, "--limit", "0"], invalidLimit.io)).toBe(2);
    expect(invalidLimit.stderr.join("")).toContain("positive integer");

    const runOnlyOption = capture();
    expect(
      await runCli(["runs", "--config", configPath, "--baseline", "run_invalid"], runOnlyOption.io),
    ).toBe(2);
    expect(runOnlyOption.stderr.join("")).toContain("Unknown option '--baseline'");
  });

  it("rejects non-object inputs and usage errors without running", async () => {
    const inputs = await inputFile([]);
    const invalidInput = capture();
    expect(await runCli(["run", "--config", configPath, "--inputs", inputs], invalidInput.io)).toBe(
      2,
    );
    expect(invalidInput.stderr.join("")).toContain("must contain a JSON object");

    const invalidUsage = capture();
    expect(await runCli(["run"], invalidUsage.io)).toBe(2);
    expect(invalidUsage.stderr.join("")).toContain("requires --inputs");
  });

  it("emits versioned JSON errors for usage, input, and config failures", async () => {
    const missingInput = capture();
    expect(await runCli(["run", "--json"], missingInput.io)).toBe(2);
    expect(missingInput.stdout).toEqual([]);
    expect(JSON.parse(missingInput.stderr.join(""))).toMatchObject({
      schemaVersion: "phase1-cli-error-v1",
      error: { name: "CliUsageError", code: "invalid_usage" },
    });

    const inputs = await inputFile([]);
    const invalidInput = capture();
    expect(
      await runCli(["run", "--config", configPath, "--inputs", inputs, "--json"], invalidInput.io),
    ).toBe(2);
    expect(JSON.parse(invalidInput.stderr.join(""))).toMatchObject({
      schemaVersion: "phase1-cli-error-v1",
      error: { name: "CliInputError", code: "input_not_object" },
    });

    const missingConfig = capture();
    expect(
      await runCli(
        ["runs", "--config", join(fixtureRoot, "missing.config.ts"), "--json"],
        missingConfig.io,
      ),
    ).toBe(2);
    expect(JSON.parse(missingConfig.stderr.join(""))).toMatchObject({
      schemaVersion: "phase1-cli-error-v1",
      error: { name: "ConfigError", code: "config_not_found" },
    });
  });

  it("rejects duplicate scalar options instead of choosing one silently", async () => {
    const inputs = await inputFile({});
    const output = capture();
    expect(
      await runCli(
        ["run", "--config", configPath, "--inputs", inputs, "--inputs", inputs, "--json"],
        output.io,
      ),
    ).toBe(2);
    expect(JSON.parse(output.stderr.join(""))).toMatchObject({
      schemaVersion: "phase1-cli-error-v1",
      error: {
        name: "CliUsageError",
        code: "invalid_usage",
        message: expect.stringContaining("--inputs"),
      },
    });
  });

  it("returns exit one when the workflow runs but a stage fails", async () => {
    const inputs = await inputFile({
      packages: ["core"],
      signals: {
        criticalVulnerabilities: "invalid",
        docsCurrent: true,
        testsPassed: true,
      },
    });
    const output = capture();
    expect(
      await runCli(["run", "--config", releaseConfigPath, "--inputs", inputs, "--json"], output.io),
    ).toBe(1);
    const result = JSON.parse(output.stdout.join("")) as {
      executionStatus: string;
      stages: Array<{ stageId: string; executionStatus: string; error: { name: string } | null }>;
    };
    expect(result.executionStatus).toBe("failed");
    expect(result.stages.find(({ stageId }) => stageId === "security")).toMatchObject({
      executionStatus: "failed",
      error: { name: "InputValidationError" },
    });
    expect(output.stderr).toEqual([]);
  });

  it("prints help without requiring a config or input file", async () => {
    const output = capture();
    expect(await runCli(["--help"], output.io)).toBe(0);
    expect(output.stdout.join("")).toContain("abilitybench run --inputs <file>");
    expect(output.stdout.join("")).toContain("abilitybench plan --inputs <file>");
    expect(output.stdout.join("")).toContain("abilitybench inspect <run-id>");
    expect(output.stdout.join("")).toContain("abilitybench diff <run-a> <run-b>");
    expect(output.stdout.join("")).toContain("abilitybench runs");
    expect(output.stderr).toEqual([]);
  });
});
