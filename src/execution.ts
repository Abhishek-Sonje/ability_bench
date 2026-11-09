import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isPromise } from "node:util/types";
import { AbilityBenchError } from "./errors.js";
import { type PublicationSchedule, publish } from "./filesystem-store.js";
import { newestFirst, scanRuns } from "./history-list.js";
import {
  type CapturedStage,
  eligibility,
  observeFixedComponents,
  observeWatchComponent,
} from "./influences.js";
import {
  digest,
  HEADER,
  OUTPUT_LIMIT,
  type RecordedRun,
  type RecordedStage,
  RUN_ID,
  readHistoryRun,
  readOutput,
} from "./recorded-data.js";
import { copyValue, orderedJson } from "./recorded-values.js";
import { finalizeRecord } from "./run-manifest.js";
import {
  normalizeRefresh,
  type RefreshOptions,
  type Workflow,
  workflowDeclarations,
} from "./typed-workflow.js";
import type { JsonValue } from "./types.js";
export interface PrepareOptions {
  readonly baseline: null | "latest" | { readonly runId: string };
  readonly refresh?: RefreshOptions;
  readonly historyDirectory?: string;
  readonly failureMode?: "fail-fast" | "continue-independent";
}
export interface ExecutionResult extends RecordedRun {
  runId: string;
}
export interface ExecutionPreview {
  workflowId: string;
  baseline: RecordedRun["baseline"];
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
function captureBaselineSelection(options: PrepareOptions): PrepareOptions["baseline"] {
  const selection: unknown = options
    ? Object.getOwnPropertyDescriptor(options, "baseline")?.value
    : undefined;
  if (selection === null) return null;
  if (selection === "latest") return selection;
  if (selection && typeof selection === "object" && Reflect.ownKeys(selection).length === 1) {
    const runId: unknown = Object.getOwnPropertyDescriptor(selection, "runId")?.value;
    if (typeof runId === "string" && RUN_ID.test(runId)) return { runId };
  }
  throw new AbilityBenchError(
    "invalid_argument",
    'Choose baseline: null, an exact retained {runId}, or "latest".',
    "prepare",
  );
}
async function selectBaseline(
  history: string,
  workflowId: string,
  selection: PrepareOptions["baseline"],
): Promise<RecordedRun | null> {
  if (selection === null) return null;
  const operation = "prepare";
  const context = selection === "latest" ? {} : { runId: selection.runId };
  try {
    if (selection === "latest") {
      let latest: RecordedRun | undefined;
      for await (const record of scanRuns(history, operation)) {
        if (
          record.schemaVersion === "abilitybench-run-v2" &&
          record.workflowId === workflowId &&
          (!latest || newestFirst(record, latest) < 0)
        )
          latest = record;
      }
      if (latest) return latest;
    } else {
      const record = await readHistoryRun(history, selection.runId, operation, context);
      if (record.schemaVersion === "phase0-run-v1")
        throw new AbilityBenchError(
          "baseline_incompatible",
          "Legacy history cannot supply an ordered baseline. Use baseline: null for a deliberate fresh run.",
          operation,
          context,
        );
      if (record.workflowId !== workflowId)
        throw new AbilityBenchError(
          "baseline_workflow_mismatch",
          "Selected baseline belongs to another workflow.",
          operation,
          context,
        );
      return record;
    }
  } catch (error) {
    if (
      !(error instanceof AbilityBenchError) ||
      (selection === "latest"
        ? error.code !== "history_not_found" || error.runId !== undefined
        : error.code !== "history_not_found" && error.code !== "run_not_found")
    )
      throw error;
  }
  throw new AbilityBenchError(
    "baseline_not_found",
    "No selected baseline is available. Use baseline: null for a deliberate fresh run.",
    operation,
    context,
  );
}
export async function prepare(
  workflow: Workflow,
  options: PrepareOptions,
): Promise<PreparedExecution> {
  return prepareExecution(workflow, options);
}
// Private coordinator entry for deterministic real-filesystem fault schedules, never root-exported.
interface ExecutionSchedule extends PublicationSchedule {
  afterArtifactRead?: (operation: "prepare" | "execute", stageId: string) => Promise<void>;
}
export async function prepareExecution(
  workflow: Workflow,
  options: PrepareOptions,
  schedule: ExecutionSchedule = {},
): Promise<PreparedExecution> {
  const selection = captureBaselineSelection(options);
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
  const refresh = normalizeRefresh(options.refresh, graph.handles);
  const forced = new Set(refresh.stageIds);
  const byId = new Map(graph.stages.map((stage) => [stage.id, stage]));
  const stages: CapturedStage[] = graph.order.map((id) => {
    const item = byId.get(id);
    if (!item) throw new Error("Normalized stage is missing.");
    const { dependencies, ...rest } = item;
    const bindings = Object.entries(dependencies)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, handle]) => ({ name, stageId: handle.id }));
    if (refresh.scope === "descendants" && bindings.some(({ stageId }) => forced.has(stageId)))
      forced.add(id);
    return {
      ...rest,
      bindings,
      refreshScope: refresh.scope === "all" || forced.has(id) ? refresh.scope : null,
      env: Object.fromEntries(item.environment.map((name) => [name, process.env[name]])),
    };
  });
  const baseline = await selectBaseline(history, workflowId, selection);

  const baselineSelection: RecordedRun["baseline"] = baseline
    ? {
        runId: baseline.id,
        recordHash: baseline.recordHash,
        schemaVersion: baseline.schemaVersion,
        status: baseline.status,
      }
    : null;
  const { afterArtifactRead } = schedule;
  async function verifySelectedArtifact(item: CapturedStage, operation: "prepare" | "execute") {
    if (!baseline || item.reuse === false) return {};
    const previous = baseline.stages.find((stage) => stage.stageId === item.id);
    if (previous?.policy !== "reusable" || !previous.output) return {};
    const reference = previous.output;
    try {
      const value = await readOutput(
        history,
        reference,
        operation,
        { stageId: item.id, runId: baseline.id },
        afterArtifactRead && (() => afterArtifactRead(operation, item.id)),
      );
      return { reference, value };
    } catch (error) {
      if (!(error instanceof AbilityBenchError)) throw error;
      return { error };
    }
  }
  const predictions = new Map<string, RecordedStage["preview"]>();
  const predictedHashes = new Map<string, string>();
  for (const item of stages) {
    let components: Record<string, string> | null = null;
    const unresolved = item.bindings
      .filter((binding) => predictions.get(binding.stageId)?.decision !== "reuse")
      .map((binding) => binding.stageId);
    let diagnostic: AbilityBenchError | undefined;
    const oldOutput = baseline?.stages.find((stage) => stage.stageId === item.id)?.output;
    const artifact = await verifySelectedArtifact(item, "prepare");
    if (item.reuse !== false)
      try {
        components = observeFixedComponents(item, predictedHashes);
        components = {
          ...components,
          watchedFiles: await observeWatchComponent(item, root, history),
        };
      } catch (error) {
        if (!(error instanceof AbilityBenchError)) throw error;
        diagnostic = error;
      }
    const prediction = eligibility(item, baseline, components, predictedHashes, {
      unresolved: [...new Set(unresolved)],
      artifactError: artifact.error,
      influenceError: diagnostic,
    });
    predictions.set(item.id, prediction);
    // A baseline output is only a hypothetical identity for unresolved upstream work.
    if (oldOutput) predictedHashes.set(item.id, oldOutput.hash);
  }
  const previews = stages.map((item) => ({
    stageId: item.id,
    ...(predictions.get(item.id) as RecordedStage["preview"]),
  }));
  const preview = frozen(
    copyValue({
      workflowId,
      baseline: baselineSelection,
      stages: previews,
    }) as unknown as ExecutionPreview,
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
          : eligibility(item, baseline, null, hashes);
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
          actual: eligibility(item, baseline, null, hashes),
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
          record.actual = eligibility(item, baseline, null, hashes, {
            skipped: { reason, prediction },
          });
          continue;
        }
        let callbackInvoked = false;
        let artifactError: AbilityBenchError | undefined;
        let fixedComponents: Record<string, string> | null = null;
        try {
          const artifact = await verifySelectedArtifact(item, "execute");
          artifactError = artifact.error;
          // Artifact verification can do substantial I/O. Observe after it.
          if (item.reuse !== false) fixedComponents = observeFixedComponents(item, hashes);
          const components = fixedComponents
            ? { ...fixedComponents, watchedFiles: await observeWatchComponent(item, root, history) }
            : null;
          let actual = eligibility(item, baseline, components, hashes, { artifactError });
          let context: Parameters<typeof item.run>[0] | undefined;
          if (actual.decision !== "reuse") {
            context = {
              inputs: copyValue(item.inputs) as typeof item.inputs,
              dependencies: Object.fromEntries(
                item.bindings.map((binding) => [
                  binding.name,
                  copyValue(values.get(binding.stageId)),
                ]),
              ),
              env: { ...item.env },
            };
            // Copying accepted inputs can take time. Refresh the only mutable part of
            // the identity before invoking the callback.
            if (components && item.reuse !== false && item.reuse.files?.length) {
              components.watchedFiles = await observeWatchComponent(item, root, history);
              actual = eligibility(item, baseline, components, hashes, { artifactError });
            }
          }
          record.components = components;
          if (components)
            record.fingerprint = digest(
              "abilitybench/fingerprint/declared-influences-v2",
              orderedJson({ workflowId, stageId: item.id, components }),
            );
          record.actual = actual;
          if (actual.decision === "reuse" && artifact.reference) {
            record.status = "reused";
            record.output = artifact.reference;
            values.set(item.id, artifact.value);
            hashes.set(item.id, artifact.reference.hash);
            continue;
          }
          if (!context) throw new Error("Eligible reuse is missing a verified artifact.");
          let returned: unknown;
          callbackInvoked = true;
          try {
            const pending = item.run(context);
            returned = isPromise(pending) ? await pending : pending;
          } catch {
            throw new AbilityBenchError("callback_failed", "Stage callback failed.", "callback");
          }
          // Synchronous callbacks are copied before yielding; asynchronous results are copied immediately on settlement.
          const output = copyValue(returned);
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
          if (item.reuse !== false && item.reuse.files?.length) {
            const after = await observeWatchComponent(item, root, history).catch(
              (error: unknown) => {
                if (!(error instanceof AbilityBenchError)) throw error;
                throw new AbilityBenchError(
                  "influence_changed_during_execution",
                  "Declared influence became unavailable during callback.",
                  "execute",
                  {
                    ...(error.file ? { file: error.file } : {}),
                    causeCode: error.causeCode ?? error.code,
                  },
                );
              },
            );
            if (after !== components?.watchedFiles)
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
          if (!callbackInvoked && item.reuse !== false)
            record.actual = eligibility(item, baseline, fixedComponents, hashes, {
              artifactError,
              influenceError: error instanceof AbilityBenchError ? error : undefined,
            });
          record.actual = {
            ...record.actual,
            decision: "execute",
            details: { ...(record.actual.details as object), callbackInvoked },
          };
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
        const finalized = finalizeRecord(
          attemptId,
          workflowId,
          startedAt,
          failureMode,
          records,
          baselineSelection,
          refresh,
        );
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
            status: coded?.status ?? (runId ? "uncertain" : "not_published"),
            ...(coded?.file ? { file: coded.file } : {}),
            ...(coded?.limit !== undefined ? { limit: coded.limit } : {}),
            ...(coded?.actualBytes !== undefined ? { actualBytes: coded.actualBytes } : {}),
          },
        );
      }
    },
  });
}
