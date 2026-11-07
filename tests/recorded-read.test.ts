import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBounded } from "../src/recorded-data.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench bounded "));
  roots.push(root);
  const file = join(root, "record");
  await writeFile(file, Buffer.alloc(65536, 120));
  return { root, file };
}
function compete(file: string, action: string) {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import * as fs from 'node:fs'; const file = process.argv[1]; ${action}`,
      file,
    ],
    { encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(0);
}
it.runIf(process.platform === "win32")(
  "distinguishes unreadable regular files with Windows ACLs",
  async () => {
    const { root, file } = await setup();
    const identity = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(identity.status, identity.stderr).toBe(0);
    const sid = identity.stdout.match(/S-1-[\d-]+/)?.[0];
    if (!sid) throw new Error("Cannot determine current Windows SID.");
    const acl = (...args: string[]) => {
      const result = spawnSync("icacls.exe", [file, ...args], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    };
    try {
      acl("/deny", `*${sid}:(R)`);
      await expect(readBounded(root, file, 65536, "record", "run", {})).rejects.toMatchObject({
        code: "record_unreadable",
        causeCode: expect.stringMatching(/^(EACCES|EPERM)$/),
      });
      await expect(readBounded(root, file, 65536, "artifact", "output", {})).rejects.toMatchObject({
        code: "artifact_unreadable",
        causeCode: expect.stringMatching(/^(EACCES|EPERM)$/),
      });
    } finally {
      acl("/remove:d", `*${sid}`);
    }
    expect((await readFile(file)).length).toBe(65536);
  },
);
it("checks EOF with remaining-budget-plus-one when a competing process grows the file", async () => {
  const { root, file } = await setup();
  await expect(
    readBounded(root, file, 65536, "record", "run", {}, async () => {
      compete(file, "fs.appendFileSync(file, 'x')");
    }),
  ).rejects.toMatchObject({ code: "read_limit_exceeded", actualBytes: 65537, limit: 65536 });
  expect((await readFile(file)).length).toBe(65537);
});
it("rejects truncation by a competing process rather than returning partial data", async () => {
  const { root, file } = await setup();
  await expect(
    readBounded(root, file, 100000, "artifact", "output", {}, async () => {
      compete(file, "fs.truncateSync(file, 1)");
    }),
  ).rejects.toMatchObject({ code: "corrupt_artifact" });
});
it("rejects physical directory aliases escaping history", async () => {
  const { root, file } = await setup();
  const nested = join(root, "history");
  await mkdir(nested);
  await symlink(root, join(nested, "alias"), process.platform === "win32" ? "junction" : "dir");
  await expect(
    readBounded(nested, join(nested, "alias", "record"), 65536, "record", "run", {}),
  ).rejects.toMatchObject({ code: "unsafe_path" });
  expect((await readFile(file)).length).toBe(65536);
});
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "distinguishes unreadable regular files (POSIX mode bits; Windows ACLs are different)",
  async () => {
    const { root, file } = await setup();
    await chmod(file, 0);
    try {
      await expect(readBounded(root, file, 65536, "record", "run", {})).rejects.toMatchObject({
        code: "record_unreadable",
        causeCode: expect.stringMatching(/^(EACCES|EPERM)$/),
      });
      await expect(readBounded(root, file, 65536, "artifact", "output", {})).rejects.toMatchObject({
        code: "artifact_unreadable",
        causeCode: expect.stringMatching(/^(EACCES|EPERM)$/),
      });
    } finally {
      await chmod(file, 0o600);
    }
  },
);
