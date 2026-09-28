import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadWorkflowConfig } from "./config.js";
import type { WorkflowExecutionResult } from "./execution.js";
import { runWorkflow } from "./runner.js";
import type { JsonObject } from "./types.js";

const HELP = `AbilityBench

Usage:
  abilitybench run --inputs <file> [options]

Options:
  --config <file>       Config file (default: ./abilitybench.config.ts)
  --inputs <file>       Required strict-JSON input object
  --baseline <run-id>   Explicit immutable baseline; omit for a full run
  --invalidate <stage>  Force one stage to execute; repeat for multiple stages
  --json                Print a machine-readable result
  --help                Show this help
`;

export interface CliIo {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        baseline: { type: "string" },
        config: { type: "string" },
        help: { type: "boolean", short: "h" },
        inputs: { type: "string" },
        invalidate: { type: "string", multiple: true },
        json: { type: "boolean" },
      },
    });
    if (parsed.values.help === true) {
      io.stdout(HELP);
      return 0;
    }
    if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "run") {
      throw new CliUsageError('Expected the command "run".');
    }
    if (parsed.values.inputs === undefined) {
      throw new CliUsageError('The "run" command requires --inputs <file>.');
    }

    const configPath = resolve(io.cwd, parsed.values.config ?? "abilitybench.config.ts");
    const inputPath = resolve(io.cwd, parsed.values.inputs);
    const inputs = await readInputObject(inputPath);
    const loaded = await loadWorkflowConfig(configPath);
    const result = await runWorkflow(loaded.workflow, {
      inputs,
      baseline: parsed.values.baseline === undefined ? null : { runId: parsed.values.baseline },
      invalidate: parsed.values.invalidate ?? [],
      environment: io.environment,
      storageDir: loaded.storageDir,
    });

    io.stdout(
      parsed.values.json === true
        ? `${JSON.stringify(machineResult(result), null, 2)}\n`
        : humanResult(result.execution, result.manifest.id),
    );
    return result.execution.executionStatus === "completed" ? 0 : 1;
  } catch (error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    io.stderr(`${message}\n`);
    if (error instanceof CliUsageError) io.stderr("\nRun abilitybench --help for usage.\n");
    return 2;
  }
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

async function readInputObject(path: string): Promise<JsonObject> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
  } catch (error: unknown) {
    throw new Error(`Unable to read input file "${path}".`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error(`Input file "${path}" is not valid JSON.`, { cause: error });
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Input file "${path}" must contain a JSON object.`);
  }
  return value as JsonObject;
}

function machineResult(result: Awaited<ReturnType<typeof runWorkflow>>) {
  return {
    schemaVersion: "phase1-cli-result-v1",
    runId: result.manifest.id,
    baselineRunId: result.manifest.baselineRunId,
    executionStatus: result.execution.executionStatus,
    evaluationStatus: result.execution.evaluationStatus,
    storageDir: result.storageDir,
    stages: result.execution.stages.map((stage) => ({
      stageId: stage.stageId,
      plannedDecision: stage.plannedDecision,
      finalDecision: stage.finalDecision,
      reason: stage.decisionReason,
      details: stage.decisionDetails,
      executionStatus: stage.executionStatus,
      outputArtifactHash: stage.outputArtifactHash,
      error: stage.error,
    })),
  };
}

function humanResult(execution: WorkflowExecutionResult, runId: string): string {
  const lines = [
    `Run: ${runId}`,
    `Status: ${execution.executionStatus}`,
    `Baseline: ${execution.baselineRunId ?? "none"}`,
    "",
  ];
  for (const stage of execution.stages) {
    const action = stage.finalDecision === "reuse" ? "REUSE" : "EXECUTE";
    lines.push(
      `${action.padEnd(7)} ${stage.stageId} [${stage.executionStatus}] ${stage.decisionReason}`,
    );
    if (Object.keys(stage.decisionDetails).length > 0) {
      lines.push(`        ${JSON.stringify(stage.decisionDetails)}`);
    }
    if (stage.error !== null) lines.push(`        ${stage.error.name}: ${stage.error.message}`);
  }
  return `${lines.join("\n")}\n`;
}

export { HELP as CLI_HELP };
