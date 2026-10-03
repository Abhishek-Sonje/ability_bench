// biome-ignore-all lint/complexity/useLiteralKeys: Untrusted JSON records require indexed access under noPropertyAccessFromIndexSignature.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type BuiltEvaluationSuite,
  compareCheckVerdicts,
  createEvaluationSuite,
  defineCheck,
  freezeJson,
  summarizeCheckVerdicts,
} from "./evaluation.js";
import {
  checkFingerprint,
  EvaluationExecutionError,
  type EvaluationExecutionResult,
  executePreparedEvaluationPair,
} from "./evaluation-execution.js";
import {
  type PrepareEvaluationPairOptions,
  prepareEvaluationPair,
  selectEvaluationOutput,
  snapshotEvaluationSuite,
} from "./evaluation-pair.js";
import {
  FileArtifactStore,
  FileRunManifestStore,
  PersistenceError,
  writeImmutable,
} from "./filesystem-store.js";
import { PathEscapeError, resolveContainedPath } from "./path-safety.js";
import { canonicalizeJson, createArtifact, decodeArtifact } from "./serialization.js";
import { type AnyInputDescriptor, input } from "./typed-workflow.js";

const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^eval_[a-f0-9]{64}$/;
const RUN = /^run_[a-f0-9]{64}$/;
const DOMAIN = "abilitybench/evaluation-receipt/v1\0";

export interface EvaluationReceipt extends Omit<EvaluationExecutionResult, "contractVersion"> {
  readonly schemaVersion: "phase2-evaluation-receipt-v1";
  readonly id: string;
  readonly receiptHash: string;
  readonly runtime: {
    readonly nodeVersion: string;
    readonly platform: string;
    readonly arch: string;
  };
}

export class EvaluationReceiptError extends Error {
  constructor(
    readonly code: "invalid_evaluation_id" | "corrupt_receipt",
    message: string,
  ) {
    super(message);
    this.name = "EvaluationReceiptError";
  }
}

function corrupt(message: string): never {
  throw new EvaluationReceiptError("corrupt_receipt", message);
}

/** Evaluates fresh inputs and publishes a separate immutable receipt. */
export async function evaluateRunPair(
  suite: BuiltEvaluationSuite,
  options: PrepareEvaluationPairOptions,
): Promise<EvaluationReceipt> {
  const prepared = await prepareEvaluationPair(suite, options);
  const execution = await executePreparedEvaluationPair(suite, prepared);
  const { contractVersion: _contractVersion, ...body } = execution;
  const receiptBody = {
    ...body,
    schemaVersion: "phase2-evaluation-receipt-v1" as const,
    runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch },
  };
  const receiptHash = hash(DOMAIN, receiptBody);
  const receipt = parseReceipt({ ...receiptBody, receiptHash, id: `eval_${receiptHash.slice(7)}` });
  const artifacts = new FileArtifactStore(prepared.storageDir);
  await artifacts.put(createArtifact(prepared.criteria));
  const store = new FileEvaluationReceiptStore(prepared.storageDir);
  await store.put(receipt, async () => {
    try {
      const current = await snapshotEvaluationSuite(suite, prepared.storageDir);
      if (current.suiteHash !== prepared.suiteHash) throw new EvaluationExecutionError();
    } catch {
      throw new EvaluationExecutionError();
    }
  });
  return receipt;
}

/** Exact lookup verifies canonical bytes, receipt identity, lineage, and referenced artifacts. */
export class FileEvaluationReceiptStore {
  readonly #root: string;
  constructor(storageRoot: string) {
    this.#root = resolve(storageRoot);
  }

  async get(id: string): Promise<EvaluationReceipt | undefined> {
    let bytes: Uint8Array;
    try {
      const path = await this.#path(id);
      bytes = await readFile(path);
    } catch (error: unknown) {
      if (error instanceof EvaluationReceiptError || error instanceof PathEscapeError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw new PersistenceError("read_failed", `Unable to read evaluation "${id}".`, error);
    }
    let receipt: EvaluationReceipt;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      receipt = parseReceipt(JSON.parse(text));
      if (canonicalizeJson(receipt) !== text || receipt.id !== id)
        corrupt("Receipt bytes or filename are noncanonical.");
    } catch (error: unknown) {
      if (error instanceof EvaluationReceiptError) throw error;
      corrupt("Unable to decode canonical evaluation receipt.");
    }
    await verifyReferences(receipt, this.#root);
    return receipt;
  }

  async put(value: EvaluationReceipt, beforePublication?: () => Promise<void>): Promise<void> {
    const receipt = parseReceipt(value);
    const path = await this.#path(receipt.id);
    await verifyReferences(receipt, this.#root);
    if (beforePublication) await beforePublication();
    await writeImmutable(path, new TextEncoder().encode(canonicalizeJson(receipt)), receipt.id);
  }

  async #path(id: string): Promise<string> {
    if (typeof id !== "string" || !ID.test(id))
      throw new EvaluationReceiptError(
        "invalid_evaluation_id",
        "Expected an exact content-addressed evaluation ID.",
      );
    return resolveContainedPath(this.#root, join("evaluations", `${id}.json`));
  }
}

function parseReceipt(value: unknown): EvaluationReceipt {
  try {
    const record = object(JSON.parse(canonicalizeJson(value)), [
      "schemaVersion",
      "id",
      "receiptHash",
      "runtime",
      "workflowId",
      "suiteId",
      "suiteHash",
      "suiteDescriptor",
      "baseline",
      "candidate",
      "criteriaArtifactHash",
      "createdAt",
      "completedAt",
      "evaluationStatus",
      "comparisonStatus",
      "summary",
      "checks",
    ]);
    if (record["schemaVersion"] !== "phase2-evaluation-receipt-v1")
      corrupt("Unsupported evaluation receipt schema.");
    if (!ID.test(string(record["id"])) || !HASH.test(string(record["receiptHash"])))
      corrupt("Invalid receipt identity.");
    for (const field of ["suiteHash", "criteriaArtifactHash"])
      if (!HASH.test(string(record[field]))) corrupt("Invalid receipt hash field.");
    for (const field of ["createdAt", "completedAt"]) {
      const timestamp = string(record[field]);
      if (new Date(timestamp).toISOString() !== timestamp) corrupt("Invalid receipt timestamp.");
    }
    const runtime = object(record["runtime"], ["nodeVersion", "platform", "arch"]);
    if (!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(string(runtime["nodeVersion"])))
      corrupt("Invalid runtime version.");
    for (const field of ["platform", "arch"])
      if (!/^[a-z0-9_]+$/.test(string(runtime[field]))) corrupt("Invalid runtime metadata.");
    for (const field of ["baseline", "candidate"]) {
      const identity = object(record[field], ["runId", "manifestHash"]);
      if (
        !RUN.test(string(identity["runId"])) ||
        !HASH.test(string(identity["manifestHash"])) ||
        string(identity["runId"]).slice(4) !== string(identity["manifestHash"]).slice(7)
      )
        corrupt("Invalid run identity.");
    }
    const suite = historicalSuite(record["suiteDescriptor"]);
    if (
      suite.id !== record["suiteId"] ||
      suite.workflowId !== record["workflowId"] ||
      hash("abilitybench/evaluation-suite/v1\0", record["suiteDescriptor"]) !== record["suiteHash"]
    )
      corrupt("Suite identity mismatch.");
    const checks = array(record["checks"]);
    if (checks.length !== suite.checks.length) corrupt("Receipt check coverage mismatch.");
    for (const [index, raw] of checks.entries()) {
      const pair = object(raw, ["checkId", "targetStageId", "baseline", "candidate", "comparison"]);
      if (
        pair["checkId"] !== suite.checks[index]?.id ||
        pair["targetStageId"] !== suite.checks[index]?.targetStage
      )
        corrupt("Check ordering or target mismatch.");
      const baseline = validateSide(pair["baseline"]);
      const candidate = validateSide(pair["candidate"]);
      if (compareCheckVerdicts(baseline.verdict, candidate.verdict) !== pair["comparison"])
        corrupt("Invalid check comparison.");
    }
    const receipt = record as unknown as EvaluationReceipt;
    const statuses = summarizeCheckVerdicts(
      receipt.checks.map(({ baseline, candidate }) => ({
        baseline: baseline.verdict,
        candidate: candidate.verdict,
      })),
    );
    if (
      receipt.evaluationStatus !== statuses.evaluationStatus ||
      receipt.comparisonStatus !== statuses.comparisonStatus ||
      canonicalizeJson(receipt.summary) !== canonicalizeJson(statuses.summary)
    )
      corrupt("Invalid aggregate status or summary.");
    const { id: _id, receiptHash: _hash, ...body } = receipt;
    if (
      hash(DOMAIN, body) !== receipt.receiptHash ||
      receipt.id !== `eval_${receipt.receiptHash.slice(7)}`
    )
      corrupt("Receipt content identity mismatch.");
    freezeJson(receipt);
    return receipt;
  } catch (error: unknown) {
    if (error instanceof EvaluationReceiptError) throw error;
    corrupt("Malformed evaluation receipt.");
  }
}

function validateSide(value: unknown): EvaluationReceipt["checks"][number]["baseline"] {
  const side = object(value, [
    "sourceArtifactHash",
    "fingerprint",
    "invocationStatus",
    "verdict",
    "details",
    "error",
  ]);
  for (const field of ["sourceArtifactHash", "fingerprint"])
    if (!HASH.test(string(side[field]))) corrupt("Invalid side hash.");
  const details = object(side["details"]);
  if (side["invocationStatus"] === "completed") {
    if (!["passed", "failed"].includes(string(side["verdict"])) || side["error"] !== null)
      corrupt("Invalid completed side.");
  } else if (side["invocationStatus"] === "error") {
    const error = object(side["error"], ["code", "name", "message"]);
    if (
      !["output_contract_failed", "check_threw", "invalid_check_result"].includes(
        string(error["code"]),
      ) ||
      side["verdict"] !== null ||
      Object.keys(details).length !== 0
    )
      corrupt("Invalid errored side.");
    string(error["name"]);
    string(error["message"]);
  } else corrupt("Invalid side invocation status.");
  return side as unknown as EvaluationReceipt["checks"][number]["baseline"];
}

function historicalSuite(value: unknown): BuiltEvaluationSuite {
  const descriptor = object(value, [
    "contractVersion",
    "suiteId",
    "workflowId",
    "checks",
    "runner",
  ]);
  if (descriptor["contractVersion"] !== "phase2-evaluation-v1") corrupt("Invalid suite contract.");
  const runner = {
    order: "sequential-check-id",
    sideOrder: "baseline-first",
    results: "strict-boolean",
    ordinaryErrors: "continue",
    outputCodec: "canonical-json-v1",
  };
  if (canonicalizeJson(descriptor["runner"]) !== canonicalizeJson(runner))
    corrupt("Invalid runner semantics.");
  const rows = array(descriptor["checks"]);
  const handles = rows.map((value) => {
    const check = object(value, ["id", "targetStage", "revision", "watchedFiles", "outputInputs"]);
    const outputInputs = Object.fromEntries(
      array(check["outputInputs"]).map((value) => {
        const selection = object(value, ["alias", "pointer", "contract"]);
        return [
          string(selection["alias"]),
          restoreDescriptor(string(selection["pointer"]), string(selection["contract"])),
        ];
      }),
    );
    const watchedFiles = array(check["watchedFiles"]);
    const files = watchedFiles.map((value) => {
      const file = object(value);
      if (file["state"] === "file") {
        object(file, ["path", "state", "contentHash"]);
        if (!HASH.test(string(file["contentHash"]))) corrupt("Invalid watched digest.");
      } else if (file["state"] === "missing") object(file, ["path", "state"]);
      else corrupt("Invalid watched state.");
      return string(file["path"]);
    });
    return defineCheck({
      id: string(check["id"]),
      targetStage: string(check["targetStage"]),
      revision: string(check["revision"]),
      outputInputs,
      files: files as [string, ...string[]],
      evaluate: () => {
        throw new Error("Historical evaluators cannot execute.");
      },
    });
  });
  const suite = createEvaluationSuite({
    id: string(descriptor["suiteId"]),
    workflowId: string(descriptor["workflowId"]),
    root: process.cwd(),
    checks: handles,
  });
  for (const [index, check] of suite.checks.entries()) {
    const row = object(rows[index]);
    const normalizedInputs = Object.entries(check.outputInputs).map(([alias, input]) => ({
      alias,
      pointer: input.pointer,
      contract: input.contract,
    }));
    const paths = array(row["watchedFiles"]).map((file) => object(file)["path"]);
    if (
      row["id"] !== check.id ||
      canonicalizeJson(paths) !== canonicalizeJson(check.files) ||
      canonicalizeJson(row["outputInputs"]) !== canonicalizeJson(normalizedInputs)
    )
      corrupt("Noncanonical historical declaration.");
  }
  return suite;
}

function restoreDescriptor(pointer: string, contract: string): AnyInputDescriptor {
  let base = contract;
  let optional = 0;
  while (base.startsWith("optional-")) {
    optional++;
    base = base.slice(9);
  }
  const factories: Record<string, (pointer: string) => AnyInputDescriptor> = {
    "required-json-v1": input.json,
    "required-boolean-v1": input.boolean,
    "required-number-v1": input.number,
    "required-string-v1": input.string,
    "required-string-array-v1": input.stringArray,
  };
  const factory = factories[base];
  if (!Object.hasOwn(factories, base) || !factory) corrupt("Unsupported input contract.");
  let descriptor = factory(pointer);
  while (optional-- > 0) descriptor = input.optional(descriptor);
  return descriptor;
}

async function verifyReferences(receipt: EvaluationReceipt, root: string): Promise<void> {
  const manifests = new FileRunManifestStore(root);
  const baseline = await manifests.get(receipt.baseline.runId);
  const candidate = await manifests.get(receipt.candidate.runId);
  if (!baseline || !candidate)
    throw new PersistenceError("read_failed", "Evaluation source runs are unavailable.");
  if (
    baseline.manifestHash !== receipt.baseline.manifestHash ||
    candidate.manifestHash !== receipt.candidate.manifestHash ||
    baseline.workflowId !== receipt.workflowId ||
    candidate.workflowId !== receipt.workflowId ||
    baseline.executionStatus !== "completed" ||
    candidate.executionStatus !== "completed" ||
    baseline.id === candidate.id ||
    candidate.baselineRunId !== baseline.id ||
    candidate.baselineManifestHash !== baseline.manifestHash
  )
    corrupt("Evaluation source lineage mismatch.");
  const artifacts = new FileArtifactStore(root);
  const criteria = await artifacts.get(receipt.criteriaArtifactHash);
  if (!criteria)
    throw new PersistenceError("read_failed", "Evaluation criteria artifact is unavailable.");
  object(decodeArtifact(criteria));
  const suite = historicalSuite(receipt.suiteDescriptor);
  const decoded = new Map<string, ReturnType<typeof decodeArtifact>>();
  for (const [index, pair] of receipt.checks.entries()) {
    const definition = suite.checks[index];
    if (!definition) corrupt("Missing historical check.");
    for (const [run, side] of [
      [baseline, pair.baseline],
      [candidate, pair.candidate],
    ] as const) {
      const stage = run.stages.find(({ stageId }) => stageId === pair.targetStageId);
      if (
        !stage ||
        !["succeeded", "reused"].includes(stage.executionStatus) ||
        stage.outputArtifactHash !== side.sourceArtifactHash
      )
        corrupt("Source artifact does not match its run.");
      if (!decoded.has(side.sourceArtifactHash)) {
        const artifact = await artifacts.get(side.sourceArtifactHash);
        if (!artifact)
          throw new PersistenceError("read_failed", "Evaluation source artifact is unavailable.");
        decoded.set(side.sourceArtifactHash, decodeArtifact(artifact));
      }
      const selected = selectEvaluationOutput(
        definition,
        side.sourceArtifactHash,
        decoded.get(side.sourceArtifactHash),
      );
      if (
        checkFingerprint(receipt, selected, pair.checkId, pair.targetStageId) !== side.fingerprint
      )
        corrupt("Check fingerprint mismatch.");
      if ((selected.error !== null) !== (side.error?.code === "output_contract_failed"))
        corrupt("Output contract status mismatch.");
      if (selected.error && canonicalizeJson(selected.error) !== canonicalizeJson(side.error))
        corrupt("Output contract diagnostic mismatch.");
    }
  }
}

function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    corrupt("Expected an object.");
  if (
    keys &&
    (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)))
  )
    corrupt("Unexpected object fields.");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) corrupt("Expected an array.");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string") corrupt("Expected a string.");
  return value;
}
function hash(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(domain).update(canonicalizeJson(value)).digest("hex")}`;
}
