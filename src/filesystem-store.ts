import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AbilityBenchError } from "./errors.js";
import {
  ARTIFACT_SCHEMA,
  type BoundedReadHook,
  type digest,
  HEADER,
  OUTPUT_LIMIT,
  type OutputReference,
  RECORD_LIMIT,
  type RecordedFile,
  RUN_ID,
  readBounded,
  readPublicationFile,
  sameInode,
  validateRun,
  verifyOutput,
} from "./recorded-data.js";
import { orderedJson, parseOrdered } from "./recorded-values.js";

export interface Publication {
  kind: "artifact" | "record";
  identity: string;
  bytes: Buffer;
  reference?: OutputReference;
}
// Private real-file schedule/fault seam, absent from package exports.
export interface PublicationSchedule {
  staged?: (file: string) => Promise<void>;
  beforeOwner?: (lock: string) => Promise<void>;
  contended?: (lock: string) => Promise<void>;
  locked?: (lock: string) => Promise<void>;
  linked?: (file: string) => Promise<void>;
  hashDigest?: typeof digest;
  occupiedRead?: BoundedReadHook;
  quarantined?: (file: string) => Promise<void>;
  quarantineVerified?: (file: string) => Promise<void>;
  removed?: (file: string) => Promise<void>;
  beforeLink?: (file: string) => Promise<void>;
}
function osCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN";
}
async function directory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (osCode(error) !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new AbilityBenchError(
      "unsafe_path",
      "Storage directory must not be an alias.",
      "publish",
      { file: path },
    );
}
async function layout(
  root: string,
  kind: Publication["kind"],
): Promise<{ staging: string; destination: string }> {
  // The selected history may have new parents; all private components are then checked individually.
  await mkdir(dirname(root), { recursive: true });
  await directory(root);
  const staging = join(root, "staging");
  await directory(staging);
  if (kind === "record") {
    await directory(join(root, "runs"));
    return { staging, destination: join(root, "runs") };
  }
  let destination = root;
  for (const part of ["objects", ARTIFACT_SCHEMA, "sha256"]) {
    destination = join(destination, part);
    await directory(destination);
  }
  return { staging, destination };
}
function verify(candidate: Publication, bytes: Buffer, schedule: PublicationSchedule): void {
  if (candidate.kind === "record") {
    try {
      validateRun(parseOrdered(bytes), candidate.identity);
    } catch (error) {
      if (error instanceof AbilityBenchError) throw error;
      throw new AbilityBenchError(
        "corrupt_record",
        "Record failed schema or identity verification.",
        "publish",
      );
    }
  } else {
    if (!candidate.reference || candidate.reference.hash !== candidate.identity)
      throw new AbilityBenchError("invalid_argument", "Missing artifact identity.", "publish");
    verifyOutput(bytes, candidate.reference, "publish", {}, schedule.hashDigest);
  }
}
async function writeClosed(file: string, bytes: string): Promise<void> {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

function verifyOccupied(
  candidate: Publication,
  bytes: Buffer,
  file: string,
  schedule: PublicationSchedule,
): void {
  if (candidate.kind === "artifact" && candidate.reference) {
    // Determine validity at the hash independently of the incoming payload length.
    const byteLength = Math.max(0, bytes.length - Buffer.byteLength(HEADER));
    verifyOutput(
      bytes,
      { ...candidate.reference, byteLength },
      "publish",
      { file },
      schedule.hashDigest,
    );
  } else {
    verify(candidate, bytes, schedule);
  }
}

async function preserveCorruption(
  root: string,
  file: string,
  temp: string,
  reference: OutputReference,
  observed: RecordedFile,
  read: (file: string) => Promise<RecordedFile>,
  beforeProof: (bad: string) => Promise<void>,
): Promise<string> {
  const quarantine = join(root, "quarantine");
  await directory(quarantine);
  const transaction = join(quarantine, randomUUID());
  await mkdir(transaction);
  const descriptor = join(transaction, "transaction.json");
  const descriptorBytes = orderedJson({
    expected: {
      artifactSchema: reference.artifactSchema,
      codec: reference.codec,
      hashScheme: reference.hashScheme,
      hash: reference.hash,
    },
    slot: file,
    corrupt: {
      sha256: createHash("sha256").update(observed.bytes).digest("hex"),
      byteLength: observed.bytes.length,
    },
    incoming: { ...reference, stagedFile: temp },
  });
  await writeClosed(descriptor, descriptorBytes);
  const bad = join(transaction, "corrupt");
  await link(file, bad);
  await beforeProof(bad);

  const saved = await readPublicationFile(
    root,
    descriptor,
    Buffer.byteLength(descriptorBytes),
    "record",
  );
  if (!saved.bytes.equals(Buffer.from(descriptorBytes)))
    throw new AbilityBenchError("repair_refused", "Quarantine descriptor changed.", "publish", {
      file: descriptor,
    });

  for (const path of [bad, file]) {
    const current = await read(path);
    if (!sameInode(observed.identity, current.identity) || !observed.bytes.equals(current.bytes))
      throw new AbilityBenchError(
        "repair_refused",
        "Corrupt inode could not be proven.",
        "publish",
        { file: path },
      );
  }
  return transaction;
}

export async function publish(
  rootDirectory: string,
  candidate: Publication,
  schedule: PublicationSchedule = {},
): Promise<void> {
  const artifact = candidate.kind === "artifact";
  if (
    !(artifact ? /^sha256:[a-f0-9]{64}$/.test(candidate.identity) : RUN_ID.test(candidate.identity))
  )
    throw new AbilityBenchError("invalid_argument", "Invalid publication identity.", "publish");
  const limit = artifact ? OUTPUT_LIMIT + Buffer.byteLength(HEADER) : RECORD_LIMIT;
  if (candidate.bytes.length > limit)
    throw new AbilityBenchError(
      artifact ? "output_limit_exceeded" : "record_limit_exceeded",
      "Publication exceeds byte limit.",
      "publish",
      { limit, actualBytes: candidate.bytes.length },
    );
  verify(candidate, candidate.bytes, schedule);
  const root = resolve(rootDirectory);
  let temp: string | undefined;
  let tempIdentity: BigIntStats | undefined;
  let token: string | undefined;
  let preserve = false;
  let repairCompleted = false;
  let commitPossible = false;
  let primaryError: unknown;
  let cleanupFailure: unknown;
  const lock = join(root, "writer-lock");
  const owner = join(lock, "owner.json");
  try {
    const paths = await layout(root, candidate.kind);
    temp = join(paths.staging, `${randomUUID()}.tmp`);
    const handle = await open(temp, "wx");
    try {
      tempIdentity = await handle.stat({ bigint: true });
      await handle.writeFile(candidate.bytes);
    } finally {
      await handle.close();
    }
    await schedule.staged?.(temp);
    const stagedFile = temp;
    const stagedIdentity = tempIdentity;
    const read = (file: string, afterRead?: BoundedReadHook) =>
      readPublicationFile(root, file, limit, candidate.kind, afterRead);
    const verifyStaging = async () => {
      const staged = await read(stagedFile);
      verify(candidate, staged.bytes, schedule);
      if (!sameInode(stagedIdentity, staged.identity) || !staged.bytes.equals(candidate.bytes))
        throw new AbilityBenchError(
          "publication_failed",
          "Staged artifact or record changed.",
          "publish",
          {
            file: stagedFile,
          },
        );
    };
    await verifyStaging();
    const deadline = performance.now() + 5000;
    const onContention = schedule.contended;
    let notified = false;
    while (true) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if (osCode(error) !== "EEXIST") throw error;
        if (onContention && !notified) {
          notified = true;
          await onContention(lock);
        }
        if (performance.now() >= deadline)
          throw new AbilityBenchError(
            "storage_busy",
            "History writer lock is occupied. Idle administrative recovery may be required.",
            "publish",
            { file: lock },
          );
        await delay(Math.min(25, Math.max(1, deadline - performance.now())));
      }
    }
    // If this write fails, deliberately leave the lock blocked without an owned token.
    await schedule.beforeOwner?.(lock);
    const newToken = orderedJson({
      uuid: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    await writeClosed(owner, newToken);
    token = newToken;
    await schedule.locked?.(lock);
    const owned = await readBounded(root, owner, 4096, "record", "publish", {});
    if (!owned.equals(Buffer.from(token)))
      throw new AbilityBenchError("storage_busy", "Writer lock ownership changed.", "publish", {
        file: lock,
      });
    const file = join(
      paths.destination,
      artifact ? candidate.identity.slice(7) : `${candidate.identity}.json`,
    );
    await verifyStaging();
    const occupied = await read(file, artifact ? schedule.occupiedRead : undefined).catch(
      (error: unknown) => {
        if (
          error instanceof AbilityBenchError &&
          error.code === (artifact ? "artifact_not_found" : "run_not_found")
        )
          return undefined;
        throw error;
      },
    );
    const verifyIdentical = (bytes: Buffer) => {
      verifyOccupied(candidate, bytes, file, schedule);
      if (!bytes.equals(candidate.bytes)) {
        preserve = true;
        throw new AbilityBenchError(
          "content_collision",
          "Occupied content differs at the requested identity.",
          "publish",
          { file },
        );
      }
    };
    let transaction: string | undefined;
    if (occupied) {
      try {
        verifyIdentical(occupied.bytes);
        commitPossible = true;
      } catch (error) {
        if (
          !(error instanceof AbilityBenchError) ||
          error.code !== "corrupt_artifact" ||
          !candidate.reference ||
          !artifact
        )
          throw error;
        if (
          !occupied.bytes
            .subarray(0, ARTIFACT_SCHEMA.length + 1)
            .equals(Buffer.from(`${ARTIFACT_SCHEMA}\n`))
        )
          throw new AbilityBenchError(
            "repair_refused",
            "Occupied artifact format could not be proven.",
            "publish",
            { file },
          );
        transaction = await preserveCorruption(
          root,
          file,
          temp,
          candidate.reference,
          occupied,
          read,
          async (bad) => {
            await schedule.quarantined?.(bad);
            await verifyStaging();
          },
        );
      }
    }
    if (transaction) {
      await schedule.quarantineVerified?.(join(transaction, "corrupt"));
      // From this point on a failure must leave the recovery evidence intact.
      preserve = true;
      await unlink(file);
      await schedule.removed?.(file);
    }

    if (!occupied || transaction) {
      await schedule.beforeLink?.(file);
      await verifyStaging();
      try {
        await link(temp, file);
      } catch (error) {
        if (osCode(error) !== "EEXIST") throw error;
      }
      commitPossible = true;
      verifyIdentical((await read(file)).bytes);
      await schedule.linked?.(file);
      if (transaction) {
        await writeClosed(join(transaction, "complete"), "");
        repairCompleted = true;
      }
    }
  } catch (error) {
    primaryError = error;
    const status = commitPossible ? "uncertain" : "not_published";
    if (error instanceof AbilityBenchError) {
      if (artifact) throw error;
      throw new AbilityBenchError(error.code, error.message, error.operation, {
        ...error.context,
        status,
      });
    }
    throw new AbilityBenchError("publication_failed", "Immutable publication failed.", "publish", {
      causeCode: osCode(error),
      ...(!artifact ? { status } : {}),
    });
  } finally {
    let cleanupError: unknown;
    try {
      if (token) {
        const actual = await readBounded(root, owner, 4096, "record", "unlock", {}).catch(
          () => null,
        );
        if (actual?.equals(Buffer.from(token))) {
          await unlink(owner);
          await rmdir(lock);
        }
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      if (temp && tempIdentity && (!preserve || (repairCompleted && !cleanupError))) {
        const info = await lstat(temp, { bigint: true }).catch(() => null);
        if (
          info?.isFile() &&
          !info.isSymbolicLink() &&
          sameInode(info, tempIdentity) &&
          (await realpath(dirname(temp))) === join(await realpath(root), "staging")
        )
          await unlink(temp);
      }
    } catch (error) {
      cleanupError ??= error;
    }
    cleanupFailure = cleanupError;
  }
  if (cleanupFailure && !primaryError)
    throw new AbilityBenchError(
      "publication_failed",
      "Publication cleanup failed; history acknowledgment is uncertain.",
      "publish",
      { causeCode: osCode(cleanupFailure), file: lock, status: "uncertain" },
    );
}
