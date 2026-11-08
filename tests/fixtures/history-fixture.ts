// biome-ignore-all lint/complexity/useLiteralKeys: Malformed schema fixtures use index signatures.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const digest = (domain: string, bytes: string) =>
  `sha256:${createHash("sha256").update(`${domain}\0`).update(bytes).digest("hex")}`;
const time = "2026-11-08T00:00:00.000Z";
const attemptId = "12345678-1234-4234-8234-123456789abc";
const header = "abilitybench-artifact-v2\nordered-json-v1\nsha256-domain-v2\n";

// Independently assembled disk bytes: no production writer/codec/schema helper.
export async function fixture(payload = '{"z":[2,1],"a":null}') {
  const root = await mkdtemp(join(tmpdir(), "abilitybench history "));
  roots.push(root);
  const hash = digest("abilitybench/artifact/v2", header + payload);
  const output = {
    artifactSchema: "abilitybench-artifact-v2",
    codec: "ordered-json-v1",
    hashScheme: "sha256-domain-v2",
    hash,
    byteLength: Buffer.byteLength(payload),
    observedAt: time,
    origin: { attemptId, stageId: "source" },
  };
  const body: Record<string, unknown> & { stages: Record<string, unknown>[] } = {
    schemaVersion: "abilitybench-run-v2",
    codec: "ordered-json-v1",
    hashScheme: "sha256-domain-v2",
    fingerprintContract: "declared-influences-v2",
    attemptId,
    workflowId: "example",
    startedAt: time,
    finalizedAt: time,
    status: "completed",
    baseline: null,
    failureMode: "fail-fast",
    refresh: { scope: "selected", stageIds: [] },
    stages: [
      {
        stageId: "source",
        dependencies: [],
        policy: "always-execute",
        preview: { decision: "execute", reason: "reuse_not_enabled", details: {} },
        actual: { decision: "execute", reason: "reuse_not_enabled", details: {} },
        status: "succeeded",
        fingerprint: null,
        components: null,
        output,
        error: null,
      },
    ],
  };
  const save = async () => {
    const recordHash = digest("abilitybench/run/v2", JSON.stringify(body));
    const id = `run_${recordHash.slice(7)}`;
    const { schemaVersion, codec, hashScheme, fingerprintContract, ...rest } = body;
    const record = {
      schemaVersion,
      codec,
      hashScheme,
      fingerprintContract,
      id,
      recordHash,
      ...rest,
    };
    await mkdir(join(root, "runs"), { recursive: true });
    await writeFile(join(root, "runs", `${id}.json`), JSON.stringify(record));
    return id;
  };
  await mkdir(join(root, "objects", "abilitybench-artifact-v2", "sha256"), { recursive: true });
  const artifact = join(root, "objects", "abilitybench-artifact-v2", "sha256", hash.slice(7));
  await writeFile(artifact, header + payload);
  return { root, body, save, artifact, stage: body.stages[0] as Record<string, unknown> };
}
