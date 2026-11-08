import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Publication, publish } from "../src/filesystem-store.js";
import { digest, HEADER } from "../src/recorded-data.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function root() {
  const p = await mkdtemp(join(tmpdir(), "abilitybench publish "));
  roots.push(p);
  return p;
}
function candidate(payload = '{"z":2,"a":1}'): Publication {
  const bytes = Buffer.from(HEADER + payload);
  const hash = digest("abilitybench/artifact/v2", bytes);
  return {
    kind: "artifact",
    identity: hash,
    bytes,
    reference: {
      artifactSchema: "abilitybench-artifact-v2",
      codec: "ordered-json-v1",
      hashScheme: "sha256-domain-v2",
      hash,
      byteLength: Buffer.byteLength(payload),
      observedAt: "2026-11-08T00:00:00.000Z",
      origin: { attemptId: "12345678-1234-4234-8234-123456789abc", stageId: "stage" },
    },
  };
}
function slot(root: string, p: Publication) {
  return join(root, "objects", "abilitybench-artifact-v2", "sha256", p.identity.slice(7));
}
it("publishes a closed verified hard link and preserves identical occupied inode", async () => {
  const r = await root(),
    p = candidate();
  let stagedInode = 0;
  await publish(r, p, {
    staged: async (file) => {
      stagedInode = (await stat(file)).ino;
    },
  });
  const before = await stat(slot(r, p));
  expect(before.ino).toBe(stagedInode);
  await publish(r, p);
  expect((await stat(slot(r, p))).ino).toBe(before.ino);
  expect(await readFile(slot(r, p))).toEqual(p.bytes);
  expect(await readdir(join(r, "staging"))).toEqual([]);
});
it("rejects malformed incoming bytes before creating state or deleting foreign temps", async () => {
  const r = await root(),
    p = candidate();
  await expect(
    publish(r, { ...p, bytes: Buffer.from(HEADER + '{"x":1,"x":2}') }),
  ).rejects.toMatchObject({ code: "corrupt_artifact" });
  expect(await readdir(r)).toEqual([]);
  await expect(publish(r, { ...p, identity: "../outside" })).rejects.toMatchObject({
    code: "invalid_argument",
  });
  await publish(r, p);
  const foreign = join(r, "staging", "foreign.tmp");
  await writeFile(foreign, "evidence");
  await publish(r, p);
  expect(await readFile(foreign, "utf8")).toBe("evidence");
});
it("refuses valid different occupied bytes under a private injected digest collision", async () => {
  const r = await root(),
    a = candidate(),
    b = candidate('{"a":1,"z":2}');
  await publish(r, a);
  const before = await stat(slot(r, a));
  if (!b.reference) throw new Error("Fixture reference missing.");
  const collision = {
    ...b,
    identity: a.identity,
    reference: { ...b.reference, hash: a.identity },
  };
  await expect(publish(r, collision, { hashDigest: () => a.identity })).rejects.toMatchObject({
    code: "content_collision",
  });
  expect(await readFile(slot(r, a))).toEqual(a.bytes);
  expect((await stat(slot(r, a))).ino).toBe(before.ino);
});
it("refuses corrupt occupied bytes without repair and cleans only its own temp", async () => {
  const r = await root(),
    p = candidate();
  await publish(r, p);
  await writeFile(slot(r, p), HEADER + "broken");
  await expect(publish(r, p)).rejects.toMatchObject({ code: "corrupt_artifact" });
  expect(await readFile(slot(r, p), "utf8")).toBe(HEADER + "broken");
  expect(await readdir(join(r, "staging"))).toEqual([]);
});
it("reopens bounded staged data and refuses tampering before commit", async () => {
  const r = await root(),
    p = candidate();
  await expect(
    publish(r, p, {
      staged: async (file) => {
        await writeFile(file, HEADER + "null");
      },
    }),
  ).rejects.toMatchObject({ code: "corrupt_artifact" });
  expect(await readdir(join(r, "objects", "abilitybench-artifact-v2", "sha256"))).toEqual([]);
});
it("refuses directory aliases and leaves the external directory untouched", async () => {
  const r = await root(),
    outside = await root();
  await symlink(outside, join(r, "objects"), "junction");
  await expect(publish(r, candidate())).rejects.toMatchObject({ code: "unsafe_path" });
  expect(await readdir(outside)).toEqual([]);
});
it("does not release a foreign owner token or steal an abandoned lock", async () => {
  const r = await root(),
    p = candidate();
  await expect(
    publish(r, p, {
      locked: async (lock) => {
        await writeFile(join(lock, "owner.json"), "{}");
      },
    }),
  ).rejects.toMatchObject({ code: "storage_busy" });
  expect(await readFile(join(r, "writer-lock", "owner.json"), "utf8")).toBe("{}");
  const start = performance.now();
  await expect(publish(r, p)).rejects.toMatchObject({ code: "storage_busy" });
  expect(performance.now() - start).toBeLessThan(5500);
  expect(await readFile(join(r, "writer-lock", "owner.json"), "utf8")).toBe("{}");
}, 7000);
it("leaves a conservative blocked lock if owner-token creation fails", async () => {
  const r = await root();
  await mkdir(join(r, "writer-lock"));
  await writeFile(join(r, "writer-lock", "owner.json"), "interrupted");
  // A preexisting lock is never inspected as authority to steal it.
  await expect(publish(r, candidate())).rejects.toMatchObject({ code: "storage_busy" });
  expect(await readFile(join(r, "writer-lock", "owner.json"), "utf8")).toBe("interrupted");
}, 7000);
it("normalizes real lock cleanup failures without deleting foreign evidence", async () => {
  const r = await root(),
    p = candidate();
  await expect(
    publish(r, p, {
      locked: async (lock) => {
        await writeFile(join(lock, "foreign-evidence"), "preserve");
      },
    }),
  ).rejects.toMatchObject({
    code: "publication_failed",
    causeCode: expect.stringMatching(/ENOTEMPTY|EEXIST/),
  });
  expect(await readFile(join(r, "writer-lock", "foreign-evidence"), "utf8")).toBe("preserve");
  expect(await readdir(join(r, "staging"))).toEqual([]);
  expect(await readFile(slot(r, p))).toEqual(p.bytes);
});
