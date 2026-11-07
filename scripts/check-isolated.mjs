import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../", import.meta.url));
const isolated = await mkdtemp(join(tmpdir(), "abilitybench supported only "));
try {
  for (const entry of [
    "src",
    "tests",
    "scripts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "tsconfig.build.json",
    "vitest.config.ts",
    "biome.json",
    "README.md",
  ]) {
    await cp(join(source, entry), join(isolated, entry), { recursive: true });
  }
  // Dependencies are shared, but no historical source or build output is copied.
  await symlink(join(source, "node_modules"), join(isolated, "node_modules"), "junction");
  const manager = process.env.npm_execpath;
  if (!manager) throw new Error("Run this check with pnpm check:isolated.");
  console.log(`Checking supported sources with legacy absent: ${isolated}`);
  const javascriptManager = /\.[cm]?js$/i.test(manager);
  const result = spawnSync(
    javascriptManager ? process.execPath : manager,
    javascriptManager ? [manager, "check"] : ["check"],
    {
      cwd: isolated,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(isolated, { recursive: true, force: true });
}
