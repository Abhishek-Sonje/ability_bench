import { resolve } from "node:path";
import { AbilityBenchError } from "./errors.js";
import { type Comparison, firstDifference } from "./history-compare.js";
import { listRuns, type RunSummary, type RunsOptions } from "./history-list.js";
import type { Phase0Run } from "./phase0-history.js";
import {
  type RecordedRun,
  RUN_ID,
  readHistoryRun,
  readOutput,
  readPhase0Output,
  validId,
} from "./recorded-data.js";
import type { JsonValue } from "./types.js";

export type RunInspection = (
  | RecordedRun
  | (Phase0Run & {
      status: Phase0Run["executionStatus"];
      finalizedAt: string;
      codec: "canonical-json-v1";
    })
) & { outputReferences: "unchecked" };
export interface History {
  runs(options?: RunsOptions): Promise<RunSummary[]>;
  run(runId: string): Promise<RunInspection>;
  compare(runA: string, runB: string, stageId: string): Promise<Comparison>;
  output(runId: string, stageId: string): Promise<JsonValue>;
}
export function openHistory(historyDirectory: string): History {
  if (typeof historyDirectory !== "string" || historyDirectory.trim().length === 0)
    throw new AbilityBenchError("invalid_argument", "Expected a history directory.", "openHistory");
  const root = resolve(historyDirectory);
  function checkRun(runId: string, operation: string): void {
    if (typeof runId !== "string" || !RUN_ID.test(runId))
      throw new AbilityBenchError("invalid_argument", "Invalid run identifier.", operation, {
        runId,
      });
  }
  return {
    runs: (options) => listRuns(root, options),
    async compare(runA, runB, stageId) {
      const selected = async (runId: string, side: "left" | "right") => {
        try {
          return await openHistory(root).output(runId, stageId);
        } catch (error) {
          if (error instanceof AbilityBenchError)
            throw new AbilityBenchError(error.code, error.message, "compare", {
              ...error.context,
              side,
            });
          throw error;
        }
      };
      const left = await selected(runA, "left");
      const right = await selected(runB, "right");
      const difference = firstDifference(left, right);
      return {
        left: { runId: runA, stageId },
        right: { runId: runB, stageId },
        equal: difference === null,
        difference,
      };
    },
    async run(runId) {
      checkRun(runId, "run");
      const record = await readHistoryRun(root, runId, "run", { runId });
      if (record.schemaVersion === "phase0-run-v1") {
        return {
          ...record,
          status: record.executionStatus,
          finalizedAt: record.completedAt,
          codec: "canonical-json-v1",
          outputReferences: "unchecked",
        };
      }
      return { ...record, outputReferences: "unchecked" };
    },
    async output(runId, stageId) {
      checkRun(runId, "output");
      const context = { runId, stageId };
      if (!validId(stageId))
        throw new AbilityBenchError(
          "invalid_argument",
          "Invalid stage identifier.",
          "output",
          context,
        );
      const record = await readHistoryRun(root, runId, "output", context);
      if (record.schemaVersion === "phase0-run-v1") {
        const stage = record.stages.find((stage) => stage.stageId === stageId);
        if (!stage) throw stageNotFound(context);
        if (stage.outputArtifactHash === null)
          throw outputAbsent(context, stage.executionStatus, stage.decisionReason);
        return readPhase0Output(root, stage.outputArtifactHash, "output", context);
      }
      const stage = record.stages.find((stage) => stage.stageId === stageId);
      if (!stage) throw stageNotFound(context);
      if (stage.output === null) throw outputAbsent(context, stage.status, stage.actual.reason);
      return readOutput(root, stage.output, "output", context);
    },
  };
}

function stageNotFound(context: { runId: string; stageId: string }): AbilityBenchError {
  return new AbilityBenchError(
    "stage_not_found",
    "Stage is not recorded in this run.",
    "output",
    context,
  );
}
function outputAbsent(
  context: { runId: string; stageId: string },
  status: string,
  reason: string,
): AbilityBenchError {
  return new AbilityBenchError("output_absent", "Recorded stage has no output.", "output", {
    ...context,
    status,
    reason,
  });
}
