import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifact } from "../src/serialization.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function writer(root: string, bytes: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["tests/fixtures/storage-writer.mjs", root, bytes], {
      cwd: process.cwd(),
      timeout: 10_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("private storage process harness", () => {
  it("deduplicates competing real writers and refuses different occupied bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "abilitybench process storage "));
    roots.push(root);
    const first = await Promise.all([writer(root, "same"), writer(root, "same")]);
    for (const result of first) expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await readFile(join(root, "slot"), "utf8")).toBe("same");
    const collision = await writer(root, "different");
    expect(collision).toEqual({ code: 2, stdout: "", stderr: "content_collision" });
    expect(await readFile(join(root, "slot"), "utf8")).toBe("same");
    expect(await readdir(root)).toEqual(["slot"]);
    expect(resolve(root)).toContain(" ");
  });

  it("rejects invalid artifact identities through a child process without writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "abilitybench process invalid "));
    roots.push(root);
    const result = await writer(root, "invalid-hash");
    expect(result).toEqual({ code: 2, stdout: "", stderr: "invalid_artifact_hash" });
    expect(await readdir(root)).toEqual([]);
    expect(createArtifact(null).contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
