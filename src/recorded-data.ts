// biome-ignore-all lint/complexity/useLiteralKeys: Unknown schema fields require index access under noPropertyAccessFromIndexSignature.
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AbilityBenchError, type ErrorContext } from "./errors.js";
import { isPhase0Run, type Phase0Run, parsePhase0, validatePhase0Run } from "./phase0-history.js";
import {
  digest,
  HASH,
  keys,
  object,
  oneOf,
  pattern,
  RUN_ID,
  requireValue,
  timestamp,
  validId,
} from "./recorded-schema.js";
import { decodeRecordedJson, orderedJson, parseOrdered } from "./recorded-values.js";
import type { JsonValue } from "./types.js";

const ARTIFACT_PREFIX = "abilitybench-artifact-";
export const HEADER = "abilitybench-artifact-v2\nordered-json-v1\nsha256-domain-v2\n";
export const RECORD_LIMIT = 2 * 1024 * 1024;
export const OUTPUT_LIMIT = 16 * 1024 * 1024;
export { digest, RUN_ID, validId } from "./recorded-schema.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type Data = Record<string, unknown>;
export interface OutputReference {
  artifactSchema: string;
  codec: string;
  hashScheme: string;
  hash: string;
  byteLength: number;
  observedAt: string;
  origin: { attemptId: string; stageId: string };
}
export interface RecordedStage {
  stageId: string;
  dependencies: { name: string; stageId: string }[];
  policy: "reusable" | "always-execute";
  preview: { decision: string; reason: string; details: JsonValue };
  actual: { decision: string; reason: string; details: JsonValue };
  status: "succeeded" | "reused" | "failed" | "skipped";
  fingerprint: string | null;
  components: Record<string, string> | null;
  output: OutputReference | null;
  error: Data | null;
}
export interface RecordedRun {
  schemaVersion: "abilitybench-run-v2";
  codec: string;
  hashScheme: string;
  fingerprintContract: string;
  id: string;
  recordHash: string;
  attemptId: string;
  workflowId: string;
  startedAt: string;
  finalizedAt: string;
  status: "completed" | "failed";
  baseline: { runId: string; recordHash: string; schemaVersion: string; status: string } | null;
  failureMode: string;
  refresh: { scope: "selected" | "descendants" | "all"; stageIds: string[] };
  stages: RecordedStage[];
}
const reasons =
  "fresh,reuse_not_enabled,refresh,baseline_stage_missing,baseline_output_absent,baseline_policy_ineligible,influences_changed,reuse_unavailable,reused,dependency_blocked,run_stopped";
const errorCodes =
  "invalid_argument,invalid_declaration,invalid_json_value,history_not_found,run_not_found,stage_not_found,output_absent,artifact_not_found,corrupt_artifact,artifact_unreadable,corrupt_record,record_unreadable,unsupported_history_format,read_limit_exceeded,baseline_not_found,baseline_workflow_mismatch,baseline_incompatible,prepared_execution_used,influence_unavailable,influence_changed_during_execution,callback_failed,output_limit_exceeded,record_limit_exceeded,content_collision,unsafe_path,storage_busy,repair_refused,publication_failed,finalization_failed";
function decision(value: unknown, actual: boolean): asserts value is Data {
  keys(value, "decision,reason,details");
  oneOf(value["decision"], actual ? "reuse,execute,skip" : "reuse,execute,conditional");
  oneOf(value["reason"], reasons);
  object(value["details"]);
}
function reference(value: unknown): void {
  keys(value, "artifactSchema,codec,hashScheme,hash,byteLength,observedAt,origin");
  requireValue(
    value["artifactSchema"] === "abilitybench-artifact-v2" &&
      value["codec"] === "ordered-json-v1" &&
      value["hashScheme"] === "sha256-domain-v2",
  );
  pattern(value["hash"], HASH);
  timestamp(value["observedAt"]);
  requireValue(
    Number.isSafeInteger(value["byteLength"]) &&
      Number(value["byteLength"]) >= 0 &&
      Number(value["byteLength"]) <= OUTPUT_LIMIT,
  );
  keys(value["origin"], "attemptId,stageId");
  pattern(value["origin"]["attemptId"], UUID);
  requireValue(validId(value["origin"]["stageId"]));
}
export function validateRun(value: unknown, runId: string): RecordedRun {
  object(value);
  if (
    typeof value["schemaVersion"] === "string" &&
    value["schemaVersion"] !== "abilitybench-run-v2"
  )
    throw new AbilityBenchError("unsupported_history_format", "Unsupported run format.", "run", {
      runId,
      ...(value["schemaVersion"] === "phase0-run-v1" ? { reason: "phase0-run-v1" } : {}),
    });
  keys(
    value,
    "schemaVersion,codec,hashScheme,fingerprintContract,id,recordHash,attemptId,workflowId,startedAt,finalizedAt,status,baseline,failureMode,refresh,stages",
  );
  requireValue(
    value["schemaVersion"] === "abilitybench-run-v2" &&
      value["codec"] === "ordered-json-v1" &&
      value["hashScheme"] === "sha256-domain-v2" &&
      value["fingerprintContract"] === "declared-influences-v2",
  );
  pattern(value["id"], RUN_ID);
  pattern(value["recordHash"], HASH);
  pattern(value["attemptId"], UUID);
  requireValue(validId(value["workflowId"]));
  timestamp(value["startedAt"]);
  timestamp(value["finalizedAt"]);
  requireValue(String(value["finalizedAt"]) >= String(value["startedAt"]));
  oneOf(value["status"], "completed,failed");
  oneOf(value["failureMode"], "fail-fast,continue-independent");
  if (value["baseline"] !== null) {
    keys(value["baseline"], "runId,recordHash,schemaVersion,status");
    pattern(value["baseline"]["runId"], RUN_ID);
    pattern(value["baseline"]["recordHash"], HASH);
    requireValue(value["baseline"]["schemaVersion"] === "abilitybench-run-v2");
    oneOf(value["baseline"]["status"], "completed,failed");
    requireValue(
      value["baseline"]["runId"] === `run_${String(value["baseline"]["recordHash"]).slice(7)}` &&
        value["baseline"]["runId"] !== runId,
    );
  }
  keys(value["refresh"], "scope,stageIds");
  oneOf(value["refresh"]["scope"], "selected,descendants,all");
  requireValue(Array.isArray(value["refresh"]["stageIds"]));
  const refreshIds = value["refresh"]["stageIds"];
  requireValue(refreshIds.every(validId) && new Set(refreshIds).size === refreshIds.length);
  requireValue(value["refresh"]["scope"] !== "all" || refreshIds.length === 0);
  requireValue(Array.isArray(value["stages"]));
  const seen = new Set<string>();
  const blocked = new Set<string>();
  const unavailable = new Set<string>();
  let failed = false;
  for (const stage of value["stages"]) {
    keys(
      stage,
      "stageId,dependencies,policy,preview,actual,status,fingerprint,components,output,error",
    );
    requireValue(validId(stage["stageId"]) && !seen.has(stage["stageId"]));
    requireValue(Array.isArray(stage["dependencies"]));
    const bindings = new Set<string>();
    for (const dep of stage["dependencies"]) {
      keys(dep, "name,stageId");
      requireValue(
        typeof dep["name"] === "string" && dep["name"].length > 0 && !bindings.has(dep["name"]),
      );
      requireValue(typeof dep["stageId"] === "string" && seen.has(dep["stageId"]));
      bindings.add(dep["name"]);
    }
    seen.add(stage["stageId"]);
    oneOf(stage["policy"], "reusable,always-execute");
    decision(stage["preview"], false);
    decision(stage["actual"], true);
    requireValue(
      (stage["actual"]["decision"] === "reuse") === (stage["actual"]["reason"] === "reused"),
    );
    requireValue(
      (stage["actual"]["decision"] === "skip") ===
        ["dependency_blocked", "run_stopped"].includes(String(stage["actual"]["reason"])),
    );
    oneOf(stage["status"], "succeeded,reused,failed,skipped");
    const dependencies = stage["dependencies"] as { name: string; stageId: string }[];
    const isBlocked = dependencies.some((dep) => blocked.has(dep.stageId));
    if (stage["status"] === "skipped") {
      requireValue(
        stage["actual"]["reason"] === (isBlocked ? "dependency_blocked" : "run_stopped"),
      );
      requireValue(isBlocked || (failed && value["failureMode"] === "fail-fast"));
    } else {
      requireValue(!dependencies.some((dep) => unavailable.has(dep.stageId)));
      requireValue(!(failed && value["failureMode"] === "fail-fast"));
    }
    if (stage["status"] === "failed" || isBlocked) blocked.add(stage["stageId"]);
    if (stage["status"] === "failed" || stage["status"] === "skipped")
      unavailable.add(stage["stageId"]);
    if (stage["policy"] === "always-execute")
      requireValue(stage["fingerprint"] === null && stage["components"] === null);
    else if (stage["fingerprint"] !== null || stage["components"] !== null) {
      pattern(stage["fingerprint"], HASH);
      keys(
        stage["components"],
        "contract,inputs,dependencies,environment,implementation,watchedFiles",
      );
      for (const hash of Object.values(stage["components"])) pattern(hash, HASH);
      requireValue(
        stage["fingerprint"] ===
          digest(
            "abilitybench/fingerprint/declared-influences-v2",
            orderedJson({
              workflowId: value["workflowId"],
              stageId: stage["stageId"],
              components: stage["components"],
            }),
          ),
      );
    } else requireValue(stage["status"] === "failed" || stage["status"] === "skipped");
    if (stage["status"] === "succeeded" || stage["status"] === "reused") {
      reference(stage["output"]);
      requireValue(stage["error"] === null);
      requireValue(
        stage["actual"]["decision"] === (stage["status"] === "reused" ? "reuse" : "execute"),
      );
      if (stage["status"] === "reused")
        requireValue(
          stage["policy"] === "reusable" &&
            value["baseline"] !== null &&
            stage["actual"]["reason"] === "reused",
        );
      const output = stage["output"] as unknown as OutputReference;
      requireValue(output.origin.stageId === stage["stageId"]);
      if (stage["status"] === "succeeded")
        requireValue(
          output.origin.attemptId === value["attemptId"] &&
            output.observedAt >= String(value["startedAt"]) &&
            output.observedAt <= String(value["finalizedAt"]),
        );
    } else {
      requireValue(stage["output"] === null);
      if (stage["status"] === "skipped")
        requireValue(
          stage["error"] === null &&
            stage["actual"]["decision"] === "skip" &&
            ["dependency_blocked", "run_stopped"].includes(String(stage["actual"]["reason"])),
        );
      else {
        failed = true;
        requireValue(stage["actual"]["decision"] === "execute");
        object(stage["error"]);
        oneOf(stage["error"]["code"], errorCodes);
        const required = ["code", "message", "operation"];
        const optional = [
          "runId",
          "attemptId",
          "stageId",
          "side",
          "file",
          "path",
          "limit",
          "actualBytes",
          "causeCode",
        ];
        requireValue(
          required.every(
            (k) =>
              typeof stage["error"] !== "undefined" &&
              typeof (stage["error"] as Data)[k] === "string",
          ) &&
            Object.keys(stage["error"]).every((k) => required.includes(k) || optional.includes(k)),
        );
        const errorFields = [...required, ...optional];
        requireValue(
          Object.keys(stage["error"]).join(",") ===
            errorFields.filter((key) => Object.hasOwn(stage["error"] as Data, key)).join(","),
        );
        requireValue(typeof (stage["actual"]["details"] as Data)["callbackInvoked"] === "boolean");
        for (const [key, item] of Object.entries(stage["error"])) {
          if (key === "limit" || key === "actualBytes")
            requireValue(Number.isSafeInteger(item) && Number(item) >= 0);
          else requireValue(typeof item === "string");
        }
        if (stage["error"]["side"] !== undefined) oneOf(stage["error"]["side"], "left,right");
        if (stage["error"]["runId"] !== undefined) pattern(stage["error"]["runId"], RUN_ID);
        if (stage["error"]["attemptId"] !== undefined) pattern(stage["error"]["attemptId"], UUID);
        if (stage["error"]["stageId"] !== undefined)
          requireValue(validId(stage["error"]["stageId"]));
      }
    }
    if (value["status"] === "completed")
      requireValue(stage["status"] === "succeeded" || stage["status"] === "reused");
  }
  requireValue(value["status"] === "completed" || failed);
  requireValue(refreshIds.every((id) => seen.has(id)));
  const { id, recordHash, ...body } = value;
  requireValue(
    recordHash === digest("abilitybench/run/v2", orderedJson(body)) &&
      id === runId &&
      id === `run_${String(recordHash).slice(7)}`,
  );
  return value as unknown as RecordedRun;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export async function readBounded(
  root: string,
  file: string,
  limit: number,
  kind: "record" | "artifact",
  operation: string,
  context: ErrorContext,
  // Private real-file harness schedule; never exposed through the SDK.
  afterRead?: (accumulated: number) => Promise<void>,
): Promise<Buffer> {
  const ctx = { ...context, file };
  let physicalRoot: string;
  try {
    physicalRoot = await realpath(root);
    requireValue((await stat(physicalRoot)).isDirectory());
  } catch (error) {
    throw new AbilityBenchError(
      "history_not_found",
      "History directory is unavailable.",
      operation,
      { ...ctx, causeCode: causeCode(error) },
    );
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const physical = await realpath(file);
    if (!inside(physicalRoot, physical))
      throw new AbilityBenchError("unsafe_path", "History path escapes directory.", operation, ctx);
    handle = await open(
      file,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK),
    );
    const before = await handle.stat();
    if (!before.isFile())
      throw new AbilityBenchError(
        "unsafe_path",
        "History entry must be a regular file.",
        operation,
        ctx,
      );
    const named = await stat(await realpath(file));
    if (
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      !inside(physicalRoot, await realpath(file))
    )
      throw new AbilityBenchError("unsafe_path", "History path identity changed.", operation, ctx);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit)
        throw new AbilityBenchError(
          "read_limit_exceeded",
          "Recorded data exceeds read limit.",
          operation,
          { ...ctx, limit, actualBytes: total },
        );
      chunks.push(buffer.subarray(0, bytesRead));
      await afterRead?.(total);
    }
    const after = await handle.stat();
    if (
      before.size !== total ||
      after.size !== total ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new AbilityBenchError(
        kind === "record" ? "corrupt_record" : "corrupt_artifact",
        "Recorded file changed during read.",
        operation,
        ctx,
      );
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof AbilityBenchError) throw error;
    const code = causeCode(error);
    throw new AbilityBenchError(
      code === "ENOENT"
        ? kind === "record"
          ? "run_not_found"
          : "artifact_not_found"
        : kind === "record"
          ? "record_unreadable"
          : "artifact_unreadable",
      "Unable to read recorded data.",
      operation,
      { ...ctx, causeCode: code },
    );
  } finally {
    await handle?.close();
  }
}
function causeCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN";
}
export function readHistoryRun(
  root: string,
  runId: string,
  operation: string,
  context: ErrorContext,
): Promise<RecordedRun | Phase0Run> {
  return readRunRecord<RecordedRun | Phase0Run>(root, runId, operation, context, (text, value) =>
    isPhase0Run(value)
      ? validatePhase0Run(text, value, runId)
      : verifyCurrentRun(text, value, runId),
  );
}

function verifyCurrentRun(text: string, value: JsonValue, runId: string): RecordedRun {
  const record = validateRun(value, runId);
  requireValue(orderedJson(value) === text);
  return record;
}

async function readRunRecord<T>(
  root: string,
  runId: string,
  operation: string,
  context: ErrorContext,
  verify: (text: string, value: JsonValue) => T,
): Promise<T> {
  const file = resolve(root, "runs", `${runId}.json`);
  const bytes = await readBounded(root, file, RECORD_LIMIT, "record", operation, context);
  try {
    const { text, value } = decodeRecordedJson(bytes);
    return verify(text, value);
  } catch (error) {
    if (error instanceof AbilityBenchError && error.code === "unsupported_history_format")
      throw new AbilityBenchError(error.code, error.message, operation, {
        ...context,
        file,
        ...error.context,
      });
    throw new AbilityBenchError(
      "corrupt_record",
      "Run failed schema or integrity verification.",
      operation,
      { ...context, file, ...(error instanceof AbilityBenchError ? error.context : {}) },
    );
  }
}

export async function readPhase0Output(
  root: string,
  hash: string,
  operation: string,
  context: ErrorContext,
): Promise<JsonValue> {
  const file = resolve(root, "objects", "sha256", hash.slice(7));
  const bytes = await readBounded(root, file, OUTPUT_LIMIT, "artifact", operation, context);
  if (bytes.toString("utf8", 0, ARTIFACT_PREFIX.length) === ARTIFACT_PREFIX)
    throw new AbilityBenchError(
      "unsupported_history_format",
      "Unsupported Phase 0 artifact format.",
      operation,
      { ...context, file },
    );
  try {
    requireValue(digest("abilitybench/artifact/v1", bytes) === hash);
    const { text, value } = decodeRecordedJson(bytes);
    return parsePhase0(text, value);
  } catch {
    throw new AbilityBenchError(
      "corrupt_artifact",
      "Artifact failed Phase 0 integrity verification.",
      operation,
      { ...context, file },
    );
  }
}
export async function readOutput(
  root: string,
  ref: OutputReference,
  operation: string,
  context: ErrorContext,
): Promise<JsonValue> {
  const bytes = await readBounded(
    root,
    resolve(root, "objects", "abilitybench-artifact-v2", "sha256", ref["hash"].slice(7)),
    OUTPUT_LIMIT + Buffer["byteLength"](HEADER),
    "artifact",
    operation,
    context,
  );
  return verifyOutput(bytes, ref, operation, {
    ...context,
    file: resolve(root, "objects", "abilitybench-artifact-v2", "sha256", ref.hash.slice(7)),
  });
}
// Shared incoming/occupied/read verification; the optional digest is private collision-fixture support.
export function verifyOutput(
  bytes: Buffer,
  ref: OutputReference,
  operation: string,
  context: ErrorContext,
  hashDigest = digest,
): JsonValue {
  try {
    reference(ref);
    if (!bytes.subarray(0, Buffer["byteLength"](HEADER)).equals(Buffer.from(HEADER))) {
      const [schema, codec, hashScheme, payload] = bytes.toString("utf8", 0, 128).split("\n", 4);
      const formatName = /^[a-z][a-z0-9-]*$/;
      if (
        schema?.startsWith(ARTIFACT_PREFIX) &&
        (schema !== "abilitybench-artifact-v2" ||
          (codec?.startsWith("ordered-json-") && codec !== "ordered-json-v1") ||
          (hashScheme?.startsWith("sha256-domain-") && hashScheme !== "sha256-domain-v2") ||
          (payload !== undefined &&
            codec !== undefined &&
            formatName.test(codec) &&
            hashScheme !== undefined &&
            formatName.test(hashScheme)))
      )
        throw new AbilityBenchError(
          "unsupported_history_format",
          "Unsupported artifact format.",
          operation,
          context,
        );
      throw new Error("Invalid artifact header.");
    }
    const payload = bytes.subarray(Buffer["byteLength"](HEADER));
    requireValue(
      payload.length === ref["byteLength"] &&
        hashDigest("abilitybench/artifact/v2", bytes) === ref["hash"],
    );
    return parseOrdered(payload);
  } catch (error) {
    if (error instanceof AbilityBenchError && error.code === "unsupported_history_format")
      throw error;
    throw new AbilityBenchError(
      "corrupt_artifact",
      "Artifact failed integrity verification.",
      operation,
      {
        ...context,
        ...(context.file ? { file: context.file } : {}),
        ...(error instanceof AbilityBenchError ? error.context : {}),
      },
    );
  }
}
