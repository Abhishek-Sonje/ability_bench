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
  const results: RunSummary[] = [];
  for await (const record of scanRuns(root, "runs")) {
    const { id } = record;
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
  return results.sort(newestFirst).slice(0, limit);
}

export function newestFirst(
  a: Pick<RunSummary, "finalizedAt" | "id">,
  b: Pick<RunSummary, "finalizedAt" | "id">,
): number {
  if (a.finalizedAt !== b.finalizedAt) return a.finalizedAt > b.finalizedAt ? -1 : 1;
  return a.id === b.id ? 0 : a.id > b.id ? -1 : 1;
}

export async function* scanRuns(root: string, operation: string) {
  let physical: string;
  try {
    physical = await realpath(root);
    if (!(await stat(physical)).isDirectory()) throw new Error();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new AbilityBenchError(
      code === undefined || code === "ENOENT" || code === "ENOTDIR"
        ? "history_not_found"
        : "record_unreadable",
      "History directory is unavailable.",
      operation,
      { file: root },
    );
  }
  const directory = resolve(root, "runs");
  let entries: Awaited<ReturnType<typeof opendir>>;
  try {
    const target = await realpath(directory);
    const path = relative(physical, target);
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`))
      throw new AbilityBenchError("unsafe_path", "Run directory escapes history.", operation);
    entries = await opendir(directory);
  } catch (error) {
    if (error instanceof AbilityBenchError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new AbilityBenchError("record_unreadable", "Cannot enumerate run records.", operation);
  }
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
          operation,
          { limit: 1000 },
        );
      const id = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
      if (!RUN_ID.test(id))
        throw new AbilityBenchError("corrupt_record", "Invalid committed run entry.", operation, {
          file: resolve(directory, entry.name),
        });
      yield await readHistoryRun(root, id, operation, { runId: id });
    }
  } catch (error) {
    if (error instanceof AbilityBenchError) throw error;
    throw new AbilityBenchError("record_unreadable", "Cannot enumerate run records.", operation);
  }
}
