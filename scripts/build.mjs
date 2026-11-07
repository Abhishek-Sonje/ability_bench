import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
// Fixed generated directory: prevent retired entrypoints surviving an incremental build.
rmSync(new URL("dist/", root), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("node_modules/typescript/bin/tsc", root)), "-p", "tsconfig.build.json"],
  { cwd: fileURLToPath(root), stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
