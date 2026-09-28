import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadWorkflowConfig } from "./config.js";
import type { WorkflowExecutionResult } from "./execution.js";
import { FileRunManifestStore } from "./filesystem-store.js";
import { diffRunManifests, type RunDiff } from "./run-diff.js";
import type { FinalizedRunManifest } from "./run-manifest.js";
import { runWorkflow } from "./runner.js";
import type { JsonObject } from "./types.js";

const HELP = `AbilityBench

Usage:
  abilitybench run --inputs <file> [options]
  abilitybench inspect <run-id> [options]
  abilitybench diff <run-a> <run-b> [options]
  abilitybench runs [options]

Options:
  --config <file>       Config file (default: ./abilitybench.config.ts)
  --inputs <file>       Required strict-JSON input object
  --baseline <run-id>   Explicit immutable baseline; omit for a full run
  --invalidate <stage>  Force one stage to execute; repeat for multiple stages
  --limit <count>       Maximum runs to list (default: 20, maximum: 1000)
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
    const parsed = parseCliArgs(argv);
    if (parsed.values.help === true) {
      io.stdout(HELP);
      return 0;
    }
    const command = parsed.positionals[0];
    if (command === "run") return await runCommand(parsed, io);
    if (command === "inspect") return await inspectCommand(parsed, io);
    if (command === "diff") return await diffCommand(parsed, io);
    if (command === "runs") return await runsCommand(parsed, io);
    throw new CliUsageError('Expected the command "run", "inspect", "diff", or "runs".');
  } catch (error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    io.stderr(`${message}\n`);
    if (error instanceof CliUsageError) io.stderr("\nRun abilitybench --help for usage.\n");
    return 2;
  }
}

type ParsedCli = ReturnType<typeof parseCliArgs>;

function parseCliArgs(argv: readonly string[]) {
  return parseArgs({
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
      limit: { type: "string" },
    },
  });
}

async function runCommand(parsed: ParsedCli, io: CliIo): Promise<number> {
  if (parsed.positionals.length !== 1) {
    throw new CliUsageError('The "run" command does not accept positional arguments.');
  }
  if (parsed.values.inputs === undefined) {
    throw new CliUsageError('The "run" command requires --inputs <file>.');
  }
  if (parsed.values.limit !== undefined) {
    throw new CliUsageError('The "run" command does not accept --limit.');
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
}

async function inspectCommand(parsed: ParsedCli, io: CliIo): Promise<number> {
  if (parsed.positionals.length !== 2) {
    throw new CliUsageError('The "inspect" command requires exactly one <run-id>.');
  }
  if (
    parsed.values.inputs !== undefined ||
    parsed.values.baseline !== undefined ||
    parsed.values.invalidate !== undefined ||
    parsed.values.limit !== undefined
  ) {
    throw new CliUsageError(
      'The "inspect" command accepts only --config, --json, and exactly one <run-id>.',
    );
  }

  const loaded = await loadWorkflowConfig(
    resolve(io.cwd, parsed.values.config ?? "abilitybench.config.ts"),
  );
  const runId = parsed.positionals[1] as string;
  const manifest = await loadProjectManifest(
    new FileRunManifestStore(loaded.storageDir),
    runId,
    loaded.workflow.id,
    loaded.storageDir,
  );
  io.stdout(
    parsed.values.json === true
      ? `${JSON.stringify(inspectMachineResult(manifest), null, 2)}\n`
      : inspectHumanResult(manifest),
  );
  return 0;
}

async function diffCommand(parsed: ParsedCli, io: CliIo): Promise<number> {
  if (parsed.positionals.length !== 3) {
    throw new CliUsageError('The "diff" command requires exactly two run IDs.');
  }
  if (
    parsed.values.inputs !== undefined ||
    parsed.values.baseline !== undefined ||
    parsed.values.invalidate !== undefined ||
    parsed.values.limit !== undefined
  ) {
    throw new CliUsageError(
      'The "diff" command accepts only --config, --json, and exactly two run IDs.',
    );
  }

  const loaded = await loadWorkflowConfig(
    resolve(io.cwd, parsed.values.config ?? "abilitybench.config.ts"),
  );
  const store = new FileRunManifestStore(loaded.storageDir);
  const [from, to] = await Promise.all([
    loadProjectManifest(
      store,
      parsed.positionals[1] as string,
      loaded.workflow.id,
      loaded.storageDir,
    ),
    loadProjectManifest(
      store,
      parsed.positionals[2] as string,
      loaded.workflow.id,
      loaded.storageDir,
    ),
  ]);
  const diff = diffRunManifests(from, to);
  io.stdout(
    parsed.values.json === true ? `${JSON.stringify(diff, null, 2)}\n` : diffHumanResult(diff),
  );
  return 0;
}

async function runsCommand(parsed: ParsedCli, io: CliIo): Promise<number> {
  if (parsed.positionals.length !== 1) {
    throw new CliUsageError('The "runs" command does not accept positional arguments.');
  }
  if (
    parsed.values.inputs !== undefined ||
    parsed.values.baseline !== undefined ||
    parsed.values.invalidate !== undefined
  ) {
    throw new CliUsageError('The "runs" command accepts only --config, --limit, and --json.');
  }

  const limit = parseRunLimit(parsed.values.limit);
  const loaded = await loadWorkflowConfig(
    resolve(io.cwd, parsed.values.config ?? "abilitybench.config.ts"),
  );
  const matching = (await new FileRunManifestStore(loaded.storageDir).list()).filter(
    ({ workflowId }) => workflowId === loaded.workflow.id,
  );
  const result = runsResult(loaded.workflow.id, matching, limit);
  io.stdout(
    parsed.values.json === true ? `${JSON.stringify(result, null, 2)}\n` : runsHumanResult(result),
  );
  return 0;
}

function parseRunLimit(value: string | undefined): number {
  if (value === undefined) return 20;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new CliUsageError('The "runs" --limit must be a positive integer no greater than 1000.');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 1000) {
    throw new CliUsageError('The "runs" --limit must be a positive integer no greater than 1000.');
  }
  return limit;
}

async function loadProjectManifest(
  store: FileRunManifestStore,
  runId: string,
  workflowId: string,
  storageDir: string,
): Promise<FinalizedRunManifest> {
  const manifest = await store.get(runId);
  if (manifest === undefined) {
    throw new Error(`Run "${runId}" was not found in "${storageDir}".`);
  }
  if (manifest.workflowId !== workflowId) {
    throw new Error(
      `Run "${runId}" belongs to workflow "${manifest.workflowId}", not "${workflowId}".`,
    );
  }
  return manifest;
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

function inspectMachineResult(manifest: FinalizedRunManifest) {
  return {
    schemaVersion: "phase1-cli-inspect-v1",
    manifest,
  };
}

function inspectHumanResult(manifest: FinalizedRunManifest): string {
  const lines = [
    `Run: ${manifest.id}`,
    `Workflow: ${manifest.workflowId}`,
    `Status: ${manifest.executionStatus}`,
    `Evaluation: ${manifest.evaluationStatus}`,
    `Baseline: ${manifest.baselineRunId ?? "none"}`,
    `Created: ${manifest.createdAt}`,
    `Completed: ${manifest.completedAt}`,
    "",
  ];
  for (const stage of manifest.stages) {
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

function diffHumanResult(diff: RunDiff): string {
  const lines = [
    `Diff: ${diff.from.runId} -> ${diff.to.runId}`,
    `Workflow: ${diff.workflowId}`,
    `Execution: ${diff.from.executionStatus} -> ${diff.to.executionStatus}`,
    `Evaluation: ${diff.from.evaluationStatus} -> ${diff.to.evaluationStatus}`,
    `Baseline: ${diff.from.baselineRunId ?? "none"} -> ${diff.to.baselineRunId ?? "none"}`,
    `Summary: ${diff.summary.added} added, ${diff.summary.removed} removed, ${diff.summary.changed} changed, ${diff.summary.unchanged} unchanged`,
    "",
  ];
  for (const stage of diff.stages) {
    const details = stage.changedFields.length === 0 ? "" : `: ${stage.changedFields.join(", ")}`;
    lines.push(`${stage.kind.toUpperCase().padEnd(9)} ${stage.stageId}${details}`);
  }
  return `${lines.join("\n")}\n`;
}

function runsResult(workflowId: string, manifests: readonly FinalizedRunManifest[], limit: number) {
  return {
    schemaVersion: "phase1-cli-runs-v1" as const,
    workflowId,
    order: "createdAt-desc-id-asc" as const,
    limit,
    totalMatched: manifests.length,
    truncated: manifests.length > limit,
    runs: manifests.slice(0, limit).map((manifest) => ({
      runId: manifest.id,
      manifestHash: manifest.manifestHash,
      baselineRunId: manifest.baselineRunId,
      createdAt: manifest.createdAt,
      completedAt: manifest.completedAt,
      executionStatus: manifest.executionStatus,
      evaluationStatus: manifest.evaluationStatus,
      stageCount: manifest.stages.length,
    })),
  };
}

function runsHumanResult(result: ReturnType<typeof runsResult>): string {
  const lines = [
    `Runs: ${result.workflowId}`,
    `Order: ${result.order}`,
    `Showing: ${result.runs.length} of ${result.totalMatched}`,
    "",
  ];
  for (const run of result.runs) {
    lines.push(
      `${run.createdAt} ${run.runId} [${run.executionStatus}/${run.evaluationStatus}] stages=${run.stageCount} baseline=${run.baselineRunId ?? "none"}`,
    );
  }
  if (result.runs.length === 0) lines.push("No runs found.");
  if (result.truncated) lines.push("", `Increase --limit to show more runs (maximum ${1000}).`);
  return `${lines.join("\n")}\n`;
}

export { HELP as CLI_HELP };
