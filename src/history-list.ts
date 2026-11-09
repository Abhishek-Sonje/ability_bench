import { opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AbilityBenchError } from "./errors.js";
import { type RecordedRun, RUN_ID, readHistoryRun, validId } from "./recorded-data.js";

export interface RunsOptions {
  workflowId?: string;
  limit?: number;
}
export type RunSummary = Pick<
  RecordedRun,
  "id" | "workflowId" | "finalizedAt" | "status" | "codec" | "hashScheme" | "fingerprintContract"
> &
  (
    | Pick<RecordedRun, "schemaVersion" | "baseline">
    | {
        schemaVersion: "phase0-run-v1";
        baseline: {
          runId: string;
          recordHash: string;
          schemaVersion: "phase0-run-v1";
        } | null;
      }
  );
export async function listRuns(root: string, options: RunsOptions = {}): Promise<RunSummary[]> {
  if (options === null || typeof options !== "object" || Array.isArray(options))
    throw new AbilityBenchError("invalid_argument", "Expected listing options.", "runs");
  const limit = options.limit === undefined ? 20 : options.limit;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    (options.workflowId !== undefined && !validId(options.workflowId))
  )
    throw new AbilityBenchError(
      "invalid_argument",
      "Expected a positive limit up to 1000 and a valid workflow ID.",
      "runs",
    );
  let physical: string;
  try {
    physical = await realpath(root);
    if (!(await stat(physical)).isDirectory()) throw new Error();
  } catch {
    throw new AbilityBenchError("history_not_found", "History directory is unavailable.", "runs");
  }
  const directory = resolve(root, "runs");
  let entries: Awaited<ReturnType<typeof opendir>>;
  try {
    const target = await realpath(directory);
    const path = relative(physical, target);
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`))
      throw new AbilityBenchError("unsafe_path", "Run directory escapes history.", "runs");
    entries = await opendir(directory);
  } catch (error) {
    if (error instanceof AbilityBenchError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new AbilityBenchError("record_unreadable", "Cannot enumerate run records.", "runs");
  }
  const results: RunSummary[] = [];
  let scanned = 0;
  try {
    for await (const entry of entries) {
      // The Phase 0 writer staged hard links beside the final record.
      if (
        entry.isFile() &&
        /^\.tmp-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          entry.name,
        )
      )
        continue;
      if (++scanned > 1000)
        throw new AbilityBenchError(
          "read_limit_exceeded",
          "History exceeds the 1000-record scan limit.",
          "runs",
          { limit: 1000 },
        );
      const id = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
      if (!RUN_ID.test(id))
        throw new AbilityBenchError("corrupt_record", "Invalid committed run entry.", "runs", {
          file: resolve(directory, entry.name),
        });
      const record = await readHistoryRun(root, id, "runs", { runId: id });
      if (options.workflowId !== undefined && record.workflowId !== options.workflowId) continue;
      if (record.schemaVersion === "phase0-run-v1") {
        results.push({
          id,
          workflowId: record.workflowId,
          finalizedAt: record.completedAt,
          status: record.executionStatus,
          baseline:
            record.baselineRunId !== null && record.baselineManifestHash !== null
              ? {
                  runId: record.baselineRunId,
                  recordHash: record.baselineManifestHash,
                  schemaVersion: record.schemaVersion,
                }
              : null,
          schemaVersion: record.schemaVersion,
          codec: "canonical-json-v1",
          hashScheme: "sha256-domain-v1",
          fingerprintContract: "phase0-v1",
        });
        continue;
      }
      const {
        workflowId,
        finalizedAt,
        status,
        baseline,
        schemaVersion,
        codec,
        hashScheme,
        fingerprintContract,
      } = record;
      results.push({
        id,
        workflowId,
        finalizedAt,
        status,
        baseline,
        schemaVersion,
        codec,
        hashScheme,
        fingerprintContract,
      });
    }
  } catch (error) {
    if (error instanceof AbilityBenchError) throw error;
    throw new AbilityBenchError("record_unreadable", "Cannot enumerate run records.", "runs");
  }
  results.sort((a, b) =>
    a.finalizedAt === b.finalizedAt
      ? a.id < b.id
        ? 1
        : a.id > b.id
          ? -1
          : 0
      : a.finalizedAt < b.finalizedAt
        ? 1
        : -1,
  );
  return results.slice(0, limit);
}
