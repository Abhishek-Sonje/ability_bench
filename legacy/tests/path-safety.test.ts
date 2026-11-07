import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveContainedPath } from "../src/path-safety.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("physical path containment", () => {
  it("allows a new child directory under the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "abilitybench-path-"));
    roots.push(root);
    expect(await resolveContainedPath(root, "nested/new-store")).toBe(
      join(root, "nested", "new-store"),
    );
  });

  it("rejects a path through a parent junction outside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "abilitybench-path-"));
    const outside = await mkdtemp(join(tmpdir(), "abilitybench-outside-"));
    roots.push(root, outside);
    await mkdir(join(outside, "data"));
    await symlink(outside, join(root, "linked"), "junction");
    await expect(resolveContainedPath(root, "linked/data")).rejects.toMatchObject({
      name: "PathEscapeError",
    });
    await expect(resolveContainedPath(root, "linked/new-store")).rejects.toMatchObject({
      name: "PathEscapeError",
    });
  });
});
