import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AbilityBenchError } from "./errors.js";
import {
  type digest,
  HEADER,
  OUTPUT_LIMIT,
  type OutputReference,
  RECORD_LIMIT,
  RUN_ID,
  readBounded,
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
  locked?: (lock: string) => Promise<void>;
  linked?: (file: string) => Promise<void>;
  hashDigest?: typeof digest;
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
  for (const part of ["objects", "abilitybench-artifact-v2", "sha256"]) {
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
  let tempIdentity: { dev: number; ino: number } | undefined;
  let token: string | undefined;
  let preserve = false;
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
      tempIdentity = await handle.stat();
      await handle.writeFile(candidate.bytes);
    } finally {
      await handle.close();
    }
    await schedule.staged?.(temp);
    const staged = await readBounded(
      root,
      temp,
      limit,
      artifact ? "artifact" : "record",
      "publish",
      {},
    );
    verify(candidate, staged, schedule);
    if (!staged.equals(candidate.bytes))
      throw new AbilityBenchError("publication_failed", "Staged bytes changed.", "publish", {
        file: temp,
      });
    const deadline = performance.now() + 5000;
    while (true) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if (osCode(error) !== "EEXIST") throw error;
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
    const ownerHandle = await open(owner, "wx");
    try {
      await ownerHandle.writeFile(newToken);
    } finally {
      await ownerHandle.close();
    }
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
    const occupied = async () => {
      const bytes = await readBounded(
        root,
        file,
        limit,
        artifact ? "artifact" : "record",
        "publish",
        {},
      );
      verify(candidate, bytes, schedule);
      if (!bytes.equals(staged)) {
        preserve = true;
        throw new AbilityBenchError(
          "content_collision",
          "Occupied content differs at the requested identity.",
          "publish",
          { file },
        );
      }
    };
    try {
      await occupied();
      commitPossible = true;
    } catch (error) {
      if (
        !(error instanceof AbilityBenchError) ||
        !["artifact_not_found", "run_not_found"].includes(error.code)
      )
        throw error;
      // Recheck the closed staged inode while holding the lock before committing it.
      const current = await readBounded(
        root,
        temp,
        limit,
        artifact ? "artifact" : "record",
        "publish",
        {},
      );
      if (!current.equals(staged))
        throw new AbilityBenchError(
          "publication_failed",
          "Staged bytes changed before publication.",
          "publish",
          { file: temp },
        );
      try {
        await link(temp, file);
      } catch (linkError) {
        if (osCode(linkError) !== "EEXIST") throw linkError;
      }
      commitPossible = true;
      await occupied();
      await schedule.linked?.(file);
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
      if (temp && tempIdentity && !preserve) {
        const info = await lstat(temp).catch(() => null);
        if (
          info?.isFile() &&
          !info.isSymbolicLink() &&
          info.dev === tempIdentity.dev &&
          info.ino === tempIdentity.ino &&
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
