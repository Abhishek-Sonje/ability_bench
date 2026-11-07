import { resolve } from "node:path";
import { AbilityBenchError } from "./errors.js";
import { type RecordedRun, RUN_ID, readOutput, readRun, validId } from "./recorded-data.js";
import type { JsonValue } from "./types.js";

export interface RunInspection extends RecordedRun {
  outputReferences: "unchecked";
}
export interface History {
  run(runId: string): Promise<RunInspection>;
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
    async run(runId) {
      checkRun(runId, "run");
      return { ...(await readRun(root, runId, "run", { runId })), outputReferences: "unchecked" };
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
      const record = await readRun(root, runId, "output", context);
      const stage = record.stages.find((stage) => stage.stageId === stageId);
      if (!stage)
        throw new AbilityBenchError(
          "stage_not_found",
          "Stage is not recorded in this run.",
          "output",
          context,
        );
      if (stage.output === null)
        throw new AbilityBenchError("output_absent", "Recorded stage has no output.", "output", {
          ...context,
          status: stage.status,
          reason: stage.actual.reason,
        });
      return readOutput(root, stage.output, "output", context);
    },
  };
}
