import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect(missing.stderr.join("")).toContain("was not found");

    const invalidOptions = capture();
    expect(
      await runCli(
        ["inspect", `run_${"0".repeat(64)}`, "--config", configPath, "--baseline", "x"],
        invalidOptions.io,
      ),
    ).toBe(2);
    expect(invalidOptions.stderr.join("")).toContain("accepts only --config, --json");
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
    expect(output.stdout.join("")).toContain("abilitybench inspect <run-id>");
    expect(output.stderr).toEqual([]);
  });
});
