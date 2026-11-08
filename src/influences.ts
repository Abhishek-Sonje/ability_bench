import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { AbilityBenchError } from "./errors.js";
import { digest } from "./recorded-data.js";
import { orderedJson } from "./recorded-values.js";
import type { StageMetadata } from "./typed-workflow.js";
import type { JsonValue } from "./types.js";
export interface CapturedStage extends Omit<StageMetadata, "dependencies"> {
  bindings: { name: string; stageId: string }[];
  env: Record<string, string | undefined>;
}
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export async function physicalDestination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await physicalDestination(parent), relative(parent, path));
  }
}
export async function observe(
  stage: CapturedStage,
  root: string,
  history: string,
  outputs: Map<string, string>,
): Promise<Record<string, string>> {
  const watches: JsonValue[] = [];
  if (stage.reuse === false) throw new Error("Always-execute has no reusable identity.");
  for (const path of [...(stage.reuse.files ?? [])].sort()) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const physical = await realpath(resolve(root, path));
      if (inside(await physicalDestination(history), physical))
        throw new AbilityBenchError("unsafe_path", "Watched file is inside history.", "influence", {
          stageId: stage.id,
          file: path,
        });
      handle = await open(
        physical,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK),
      );
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Expected a regular watched file.");
      const bytes = await handle.readFile();
      watches.push({ path: physical, hash: digest("abilitybench/watched-file/v2", bytes) });
    } catch (error) {
      if (error instanceof AbilityBenchError) throw error;
      throw new AbilityBenchError(
        "influence_unavailable",
        "Required watched file is unavailable.",
        "influence",
        {
          stageId: stage.id,
          file: path,
          ...(error && typeof error === "object" && "code" in error
            ? { causeCode: String(error.code) }
            : {}),
        },
      );
    } finally {
      await handle?.close();
    }
  }
  const values = {
    contract: { codec: "ordered-json-v1", fingerprintContract: "declared-influences-v2" },
    inputs: stage.inputs,
    dependencies: stage.bindings.map((binding) => ({
      ...binding,
      hash: outputs.get(binding.stageId) ?? null,
    })),
    environment: Object.keys(stage.env)
      .sort()
      .map((name) => ({
        name,
        presence: stage.env[name] === undefined ? "missing" : "present",
        hash:
          stage.env[name] === undefined
            ? null
            : digest("abilitybench/environment-value/v2", stage.env[name] as string),
      })),
    implementation: stage.reuse.revision ?? null,
    watchedFiles: watches,
  };
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      digest(`abilitybench/component/${key}/v2`, orderedJson(value)),
    ]),
  );
}
