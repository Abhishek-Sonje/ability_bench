import { AbilityBenchError } from "./errors.js";
import {
  digest,
  RECORD_LIMIT,
  type RecordedRun,
  type RecordedStage,
  validateRun,
} from "./recorded-data.js";
import { orderedJson, parseOrdered } from "./recorded-values.js";
export function finalizeRecord(
  attemptId: string,
  workflowId: string,
  startedAt: string,
  failureMode: string,
  stages: RecordedStage[],
): { record: RecordedRun; bytes: Buffer } {
  const versions = {
    schemaVersion: "abilitybench-run-v2",
    codec: "ordered-json-v1",
    hashScheme: "sha256-domain-v2",
    fingerprintContract: "declared-influences-v2",
  };
  const body = {
    ...versions,
    attemptId,
    workflowId,
    startedAt,
    finalizedAt: new Date().toISOString(),
    status: stages.some((s) => s.status === "failed") ? "failed" : "completed",
    baseline: null,
    failureMode,
    refresh: { scope: "selected", stageIds: [] },
    stages,
  };
  const recordHash = digest("abilitybench/run/v2", orderedJson(body));
  const id = `run_${recordHash.slice(7)}`;
  const { schemaVersion, codec, hashScheme, fingerprintContract, ...rest } = body;
  const value = { schemaVersion, codec, hashScheme, fingerprintContract, id, recordHash, ...rest };
  const bytes = Buffer.from(orderedJson(value));
  if (bytes.length > RECORD_LIMIT)
    throw new AbilityBenchError(
      "record_limit_exceeded",
      "Final record exceeds byte limit.",
      "finalize",
      { attemptId, runId: id, limit: RECORD_LIMIT, actualBytes: bytes.length },
    );
  return { record: validateRun(parseOrdered(bytes), id), bytes };
}
