import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isPromise } from "node:util/types";
import { AbilityBenchError } from "./errors.js";
import { type PublicationSchedule, publish } from "./filesystem-store.js";
import { type CapturedStage, observe } from "./influences.js";
import {
  digest,
  HEADER,
  OUTPUT_LIMIT,
  type RecordedRun,
  type RecordedStage,
} from "./recorded-data.js";
import { copyValue, orderedJson } from "./recorded-values.js";
import { finalizeRecord } from "./run-manifest.js";
import { type Workflow, workflowDeclarations } from "./typed-workflow.js";
import type { JsonValue } from "./types.js";
export interface PrepareOptions {
  readonly baseline: null;
  readonly historyDirectory?: string;
  readonly failureMode?: "fail-fast" | "continue-independent";
}
export interface ExecutionResult extends RecordedRun {
  runId: string;
}
export interface ExecutionPreview {
  workflowId: string;
  baseline: null;
  stages: { stageId: string; decision: string; reason: string; details: JsonValue }[];
}
export interface PreparedExecution {
  readonly preview: ExecutionPreview;
  execute(): Promise<ExecutionResult>;
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}
function selection(stage: CapturedStage): RecordedStage["preview"] {
  return {
    decision: "execute",
    reason: stage.reuse === false ? "reuse_not_enabled" : "fresh",
    details: {},
  };
}
export async function prepare(
  workflow: Workflow,
  options: PrepareOptions,
): Promise<PreparedExecution> {
  return prepareExecution(workflow, options);
}
// Private coordinator entry for deterministic real-filesystem fault schedules, never root-exported.
export async function prepareExecution(
  workflow: Workflow,
  options: PrepareOptions,
  schedule: PublicationSchedule = {},
): Promise<PreparedExecution> {
  if (!options || !Object.hasOwn(options, "baseline") || options.baseline !== null)
    throw new AbilityBenchError(
      "invalid_argument",
      "This slice requires deliberate baseline:null.",
      "prepare",
    );
  if (
    options.historyDirectory !== undefined &&
    (typeof options.historyDirectory !== "string" || !options.historyDirectory.trim())
  )
    throw new AbilityBenchError("invalid_argument", "Invalid history directory.", "prepare");
  if (
    options.failureMode !== undefined &&
    !["fail-fast", "continue-independent"].includes(options.failureMode)
  )
    throw new AbilityBenchError("invalid_argument", "Invalid failure mode.", "prepare");
  const failureMode = options.failureMode ?? "fail-fast";
  const history = resolve(options.historyDirectory ?? resolve(workflow.root, ".abilitybench"));
  const workflowId = workflow.id,
    root = workflow.root;
  const graph = workflowDeclarations(workflow);
  const byId = new Map(graph.stages.map((stage) => [stage.id, stage]));
  const stages: CapturedStage[] = graph.order.map((id) => {
    const item = byId.get(id);
    if (!item) throw new Error("Normalized stage is missing.");
    const { dependencies, ...rest } = item;
    return {
      ...rest,
      bindings: Object.entries(dependencies)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, handle]) => ({ name, stageId: handle.id })),
      env: Object.fromEntries(item.environment.map((name) => [name, process.env[name]])),
    };
  });
  const diagnostics = new Map<string, AbilityBenchError>();
  for (const item of stages)
    if (item.reuse !== false)
      try {
        await observe(item, root, history, new Map());
      } catch (error) {
        if (!(error instanceof AbilityBenchError)) throw error;
        diagnostics.set(item.id, error);
      }
  const previews = stages.map((item) => ({
    stageId: item.id,
    ...selection(item),
    details: diagnostics.has(item.id)
      ? { error: { code: diagnostics.get(item.id)?.code ?? "influence_unavailable" } }
      : {},
  }));
  const preview = frozen(
    copyValue({ workflowId, baseline: null, stages: previews }) as unknown as ExecutionPreview,
  );
  let used = false;
  return Object.freeze({
    preview,
    async execute(): Promise<ExecutionResult> {
      if (used)
        throw new AbilityBenchError(
          "prepared_execution_used",
          "Prepared execution is single-use.",
          "execute",
        );
      used = true;
      const attemptId = randomUUID(),
        startedAt = new Date().toISOString();
      const values = new Map<string, JsonValue>(),
        hashes = new Map<string, string>();
      const records: RecordedStage[] = [];
      let failed = false;
      const failureDescendants = new Set<string>();
      for (const item of stages) {
        const prior = previews.find((p) => p.stageId === item.id);
        const prediction = prior
          ? { decision: prior.decision, reason: prior.reason, details: prior.details }
          : selection(item);
        const blocked = item.bindings.some((binding) => failureDescendants.has(binding.stageId));
        const reason = blocked
          ? "dependency_blocked"
          : failed && failureMode === "fail-fast"
            ? "run_stopped"
            : null;
        const record: RecordedStage = {
          stageId: item.id,
          dependencies: item.bindings,
          policy: item.reuse === false ? "always-execute" : "reusable",
          preview: prediction,
          actual: selection(item),
          status: "succeeded",
          fingerprint: null,
          components: null,
          output: null,
          error: null,
        };
        records.push(record);
        if (reason) {
          record.status = "skipped";
          if (blocked) failureDescendants.add(item.id);
          record.actual = { decision: "skip", reason, details: {} };
          continue;
        }
        let callbackInvoked = false;
        try {
          if (item.reuse !== false) {
            record.components = await observe(item, root, history, hashes);
            record.fingerprint = digest(
              "abilitybench/fingerprint/declared-influences-v2",
              orderedJson({ workflowId, stageId: item.id, components: record.components }),
            );
          }
          const dependencies = Object.fromEntries(
            item.bindings.map((binding) => [binding.name, copyValue(values.get(binding.stageId))]),
          );
          callbackInvoked = true;
          const returned = item.run({
            inputs: copyValue(item.inputs) as typeof item.inputs,
            dependencies,
            env: { ...item.env },
          });
          // Synchronous callbacks are copied before yielding; asynchronous results are copied immediately on settlement.
          const output = copyValue(isPromise(returned) ? await returned : returned);
          const observedAt = new Date().toISOString();
          const payload = orderedJson(output),
            byteLength = Buffer.byteLength(payload);
          if (byteLength > OUTPUT_LIMIT)
            throw new AbilityBenchError(
              "output_limit_exceeded",
              "Serialized output exceeds byte limit.",
              "output",
              { limit: OUTPUT_LIMIT, actualBytes: byteLength },
            );
          if (item.reuse !== false) {
            const after = await observe(item, root, history, hashes);
            if (orderedJson(after) !== orderedJson(record.components))
              throw new AbilityBenchError(
                "influence_changed_during_execution",
                "Declared influences changed during callback.",
                "execute",
              );
          }
          const bytes = Buffer.from(HEADER + payload),
            hash = digest("abilitybench/artifact/v2", bytes);
          const reference = {
            artifactSchema: "abilitybench-artifact-v2",
            codec: "ordered-json-v1",
            hashScheme: "sha256-domain-v2",
            hash,
            byteLength,
            observedAt,
            origin: { attemptId, stageId: item.id },
          };
          await publish(history, { kind: "artifact", identity: hash, bytes, reference }, schedule);
          record.output = reference;
          values.set(item.id, output);
          hashes.set(item.id, hash);
        } catch (error) {
          failed = true;
          failureDescendants.add(item.id);
          record.status = "failed";
          record.actual.details = { callbackInvoked };
          const coded =
            error instanceof AbilityBenchError
              ? error
              : new AbilityBenchError("callback_failed", "Stage callback failed.", "callback");
          const context = coded.context;
          record.error = {
            code: coded.code,
            message: coded.message,
            operation: coded.operation,
            attemptId,
            stageId: item.id,
            ...(context.file ? { file: context.file } : {}),
            ...(context.path !== undefined ? { path: context.path } : {}),
            ...(context.limit !== undefined ? { limit: context.limit } : {}),
            ...(context.actualBytes !== undefined ? { actualBytes: context.actualBytes } : {}),
            ...(context.causeCode ? { causeCode: context.causeCode } : {}),
          };
        }
      }
      let runId: string | undefined;
      try {
        const finalized = finalizeRecord(attemptId, workflowId, startedAt, failureMode, records);
        runId = finalized.record.id;
        await publish(
          history,
          { kind: "record", identity: runId, bytes: finalized.bytes },
          schedule,
        );
        return { ...(copyValue(finalized.record) as unknown as RecordedRun), runId };
      } catch (error) {
        const coded = error instanceof AbilityBenchError ? error : undefined;
        throw new AbilityBenchError(
          "finalization_failed",
          "Finalization did not establish acknowledged saved history. Publication may be uncertain; inspect the allocated identity when available.",
          "finalize",
          {
            attemptId,
            ...(runId || coded?.runId ? { runId: runId ?? (coded?.runId as string) } : {}),
            causeCode: coded?.causeCode ?? coded?.code ?? "UNKNOWN",
            reason: coded?.code ?? "UNKNOWN",
            status: runId ? "uncertain" : "not_published",
            ...(coded?.file ? { file: coded.file } : {}),
            ...(coded?.limit !== undefined ? { limit: coded.limit } : {}),
            ...(coded?.actualBytes !== undefined ? { actualBytes: coded.actualBytes } : {}),
          },
        );
      }
    },
  });
}
