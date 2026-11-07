import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FileEvaluationReceiptStore } from "./evaluation-receipt.js";
import { FileArtifactStore, FileRunManifestStore } from "./filesystem-store.js";
import { resolveContainedPath } from "./path-safety.js";
import { diffRunManifests } from "./run-diff.js";
import { decodeArtifact } from "./serialization.js";

const RUN = /^run_[a-f0-9]{64}$/;
const RECEIPT = /^eval_[a-f0-9]{64}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
export const VIEWER_LIMITS = Object.freeze({
  runs: 500,
  recordBytes: 2 * 1024 * 1024,
  previewBytes: 256 * 1024,
});

export class ViewerReadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ViewerReadError";
  }
}

/** A separate read adapter. No config imports, cache planning, callbacks, or writes. */
export class ViewerData {
  readonly root: string;
  constructor(
    storageRoot: string,
    readonly workflowId: string,
  ) {
    this.root = resolve(storageRoot);
    if (!workflowId || workflowId.length > 200)
      throw new ViewerReadError("invalid_workflow", "Supply a workflow ID of 1–200 characters.");
  }

  async history() {
    const directory = await this.safe("runs", true);
    if (directory === null)
      return { workflowId: this.workflowId, runs: [], storeStatus: "missing" as const };
    const names = (await readdir(directory)).filter((name) =>
      /^run_[a-f0-9]{64}\.json$/.test(name),
    );
    if (names.length > VIEWER_LIMITS.runs)
      throw new ViewerReadError(
        "history_limit",
        "This viewer supports at most 500 retained manifests per store. Use a smaller retained store.",
        413,
      );
    for (const name of names) await this.safe(join("runs", name));
    const runs = (await new FileRunManifestStore(this.root).list()).filter(
      (run) => run.workflowId === this.workflowId,
    );
    return {
      workflowId: this.workflowId,
      storeStatus: "available" as const,
      runs: runs.map(({ id, createdAt, executionStatus, baselineRunId }) => ({
        id,
        createdAt,
        executionStatus,
        baselineRunId,
      })),
    };
  }

  async run(id: string) {
    const candidate = await this.manifest(id);
    const baseline =
      candidate.baselineRunId === null ? null : await this.manifest(candidate.baselineRunId);
    if (
      baseline &&
      (baseline.manifestHash !== candidate.baselineManifestHash ||
        baseline.baselineRunId !== null ||
        baseline.executionStatus !== "completed")
    ) {
      throw new ViewerReadError(
        "invalid_lineage",
        "The recorded baseline is not the exact completed immutable baseline.",
        409,
      );
    }
    return {
      candidate,
      baseline,
      diff: baseline === null ? null : diffRunManifests(baseline, candidate),
    };
  }

  async artifact(runId: string, stageId: string) {
    const run = await this.manifest(runId);
    const stage = run.stages.find((item) => item.stageId === stageId);
    if (!stage)
      throw new ViewerReadError("stage_not_found", "Stage is not recorded in this run.", 404);
    const hash = stage.outputArtifactHash;
    if (hash === null)
      return { hash: null, verification: "no_output", value: null, byteLength: null };
    const path = await this.safe(this.artifactPath(hash), false, Number.MAX_SAFE_INTEGER);
    if (path === null)
      throw new ViewerReadError("artifact_missing", "The recorded artifact is missing.", 404);
    const size = (await lstat(path)).size;
    if (size > VIEWER_LIMITS.previewBytes)
      return {
        hash,
        byteLength: size,
        verification: "not_previewed",
        value: null,
        notice:
          "Artifact exceeds the 256 KiB preview limit. Its bytes have not been verified by this preview.",
      };
    const artifact = await new FileArtifactStore(this.root).get(hash);
    if (!artifact)
      throw new ViewerReadError("artifact_missing", "The recorded artifact disappeared.", 404);
    return {
      hash,
      byteLength: artifact.byteLength,
      codec: artifact.codec,
      verification: "verified",
      value: decodeArtifact(artifact),
    };
  }

  async receipt(runId: string, receiptId: string) {
    const { candidate, baseline } = await this.run(runId);
    if (!RECEIPT.test(receiptId))
      throw new ViewerReadError("invalid_receipt_id", "Enter a complete eval_ receipt ID.");
    const path = await this.safe(join("evaluations", `${receiptId}.json`));
    if (path === null)
      throw new ViewerReadError("receipt_missing", "Receipt was not found in this store.", 404);
    // Preflight untrusted references BEFORE the existing verifier reads them.
    // These bytes authorize no claims; FileEvaluationReceiptStore verifies the full record below.
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    const metadata = asObject(raw);
    const candidateRef = asObject(metadata["candidate"]);
    const baselineRef = asObject(metadata["baseline"]);
    if (
      metadata["workflowId"] !== this.workflowId ||
      candidateRef["runId"] !== candidate.id ||
      baselineRef["runId"] !== baseline?.id
    )
      throw new ViewerReadError(
        "receipt_pair_mismatch",
        "This receipt does not belong to the selected run and its recorded baseline.",
        409,
      );
    await this.manifest(asString(candidateRef["runId"]));
    await this.manifest(asString(baselineRef["runId"]));
    const hashes = new Set([asString(metadata["criteriaArtifactHash"])]);
    const checks = metadata["checks"];
    if (!Array.isArray(checks) || checks.length > 128)
      throw new ViewerReadError("receipt_limit", "Malformed receipt or more than 128 checks.", 413);
    for (const check of checks) {
      const pair = asObject(check);
      for (const side of ["baseline", "candidate"])
        hashes.add(asString(asObject(pair[side])["sourceArtifactHash"]));
    }
    let bytes = 0;
    for (const hash of hashes) {
      const artifact = await this.safe(this.artifactPath(hash));
      if (artifact === null)
        throw new ViewerReadError("artifact_missing", "A receipt reference is missing.", 404);
      bytes += (await lstat(artifact)).size;
      if (bytes > 16 * 1024 * 1024)
        throw new ViewerReadError(
          "receipt_limit",
          "Receipt verification exceeds the 16 MiB aggregate artifact limit.",
          413,
        );
    }
    const receipt = await new FileEvaluationReceiptStore(this.root).get(receiptId);
    if (!receipt)
      throw new ViewerReadError("receipt_missing", "Receipt disappeared during verification.", 404);
    return receipt;
  }

  private async manifest(id: string) {
    if (!RUN.test(id)) throw new ViewerReadError("invalid_run_id", "Supply a complete run_ ID.");
    if ((await this.safe(join("runs", `${id}.json`))) === null)
      throw new ViewerReadError(
        "run_missing",
        "The selected run or its recorded baseline is missing.",
        404,
      );
    const run = await new FileRunManifestStore(this.root).get(id);
    if (!run) throw new ViewerReadError("run_missing", "Run disappeared during verification.", 404);
    if (run.workflowId !== this.workflowId)
      throw new ViewerReadError("workflow_mismatch", "Run belongs to another workflow.", 409);
    return run;
  }

  private artifactPath(hash: string) {
    if (!HASH.test(hash))
      throw new ViewerReadError(
        "invalid_artifact_reference",
        "Stored artifact identity is invalid.",
      );
    return join("objects", "sha256", hash.slice(7));
  }

  private async safe(
    relativePath: string,
    directory = false,
    maxBytes = VIEWER_LIMITS.recordBytes,
  ): Promise<string | null> {
    try {
      const rootInfo = await lstat(this.root);
      if (
        !rootInfo.isDirectory() ||
        rootInfo.isSymbolicLink() ||
        (await realpath(this.root)) !== this.root
      )
        throw new ViewerReadError(
          "unsafe_store",
          "Use a physical storage directory without symlinked ancestors.",
          409,
        );
      let cursor = this.root;
      const parts = relativePath.split(/[\\/]/);
      for (const [index, part] of parts.entries()) {
        cursor = join(cursor, part);
        const info = await lstat(cursor);
        if (info.isSymbolicLink())
          throw new ViewerReadError(
            "unsafe_store",
            "Symlinked storage entries are not supported by the read-only viewer.",
            409,
          );
        const shouldBeDirectory = index < parts.length - 1 || directory;
        if (shouldBeDirectory ? !info.isDirectory() : !info.isFile())
          throw new ViewerReadError("unsafe_store", "Unexpected storage entry type.", 409);
        if (!shouldBeDirectory && info.size > maxBytes)
          throw new ViewerReadError(
            "record_limit",
            "Stored record exceeds the viewer read limit.",
            413,
          );
      }
      return await resolveContainedPath(this.root, relativePath);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ViewerReadError("invalid_receipt", "Malformed receipt reference.", 409);
  return value as Record<string, unknown>;
}
function asString(value: unknown): string {
  if (typeof value !== "string")
    throw new ViewerReadError("invalid_receipt", "Malformed receipt reference.", 409);
  return value;
}
