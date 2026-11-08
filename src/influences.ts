import { constants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { AbilityBenchError } from "./errors.js";
import { digest, type RecordedRun, type RecordedStage } from "./recorded-data.js";
import { orderedJson } from "./recorded-values.js";
import type { StageMetadata } from "./typed-workflow.js";
import type { JsonObject, JsonValue } from "./types.js";
export interface CapturedStage extends Omit<StageMetadata, "dependencies"> {
  bindings: { name: string; stageId: string }[];
  env: Record<string, string | undefined>;
}
interface EligibilityObservation {
  unresolved?: string[];
  artifactError?: AbilityBenchError | undefined;
  influenceError?: AbilityBenchError | undefined;
  skipped?: { reason: "dependency_blocked" | "run_stopped"; prediction: RecordedStage["preview"] };
}
// One policy calculation for predictive and actual observations. Unknown dependency
// outputs are provisionally compared to the selected baseline, never promised equal.
export function eligibility(
  stage: CapturedStage,
  baseline: RecordedRun | null,
  components: Record<string, string> | null,
  outputs: Map<string, string>,
  observation: EligibilityObservation = {},
): RecordedStage["preview"] {
  const { unresolved = [], artifactError, influenceError, skipped } = observation;
  if (skipped) {
    // Unreached work has no current file/output observation. Preserve known preview
    // causes, but never claim that its hypothetical reuse was an actual outcome.
    const details = skipped.prediction.details as JsonObject;
    const causes = Array.isArray(details["causes"])
      ? details["causes"].filter((cause) => cause !== "reused")
      : [];
    return {
      decision: "skip",
      reason: skipped.reason,
      details: { ...details, causes: [skipped.reason, ...causes] },
    };
  }
  const previous = baseline?.stages.find((s) => s.stageId === stage.id);
  const causes: string[] = [];
  if (stage.reuse === false) causes.push("reuse_not_enabled");
  if (!baseline) causes.push("fresh");
  else if (!previous) causes.push("baseline_stage_missing");
  else {
    if (!previous.output || !["succeeded", "reused"].includes(previous.status))
      causes.push("baseline_output_absent");
    if (previous.policy !== "reusable") causes.push("baseline_policy_ineligible");
  }
  const changedComponents =
    components && previous?.components
      ? Object.keys(components).filter((name) => components[name] !== previous.components?.[name])
      : [];
  const changedBindings = previous
    ? [
        ...new Set([
          ...previous.dependencies.map((b) => b.name),
          ...stage.bindings.map((b) => b.name),
        ]),
      ]
        .sort()
        .filter((name) => {
          const before = previous.dependencies.find((b) => b.name === name);
          const after = stage.bindings.find((b) => b.name === name);
          return (
            before?.stageId !== after?.stageId ||
            (after &&
              baseline?.stages.find((s) => s.stageId === before?.stageId)?.output?.hash !==
                outputs.get(after.stageId))
          );
        })
    : [];
  if (changedComponents.length || influenceError) causes.push("influences_changed");
  if (artifactError) causes.push("reuse_unavailable");
  const reason = causes[0] ?? "reused";
  const potential = reason === "reused";
  return {
    decision: potential ? (unresolved.length ? "conditional" : "reuse") : "execute",
    reason,
    details: {
      causes: causes.length ? causes : ["reused"],
      ...(changedComponents.length
        ? {
            changedComponents: changedComponents.map((name) => ({
              name,
              baseline: previous?.components?.[name] ?? null,
              current: components?.[name] ?? null,
            })),
          }
        : {}),
      ...(changedBindings.length ? { changedBindings } : {}),
      ...(unresolved.length
        ? { unresolvedStages: unresolved, potentialEligibility: potential }
        : {}),
      ...(artifactError ? { artifact: { code: artifactError.code } } : {}),
      ...(influenceError
        ? {
            error: {
              code: influenceError.code,
              ...(influenceError.file ? { file: influenceError.file } : {}),
            },
          }
        : {}),
    },
  };
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
async function containsFileIdentity(
  directory: string,
  file: { dev: number; ino: number },
): Promise<boolean> {
  let entries: Awaited<ReturnType<typeof opendir>>;
  try {
    entries = await opendir(directory);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
  // Incremental metadata-only traversal is needed only for multiply linked watches.
  // realpath resolves symlinks; matching device/inode also catches hard-link aliases.
  for await (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (await containsFileIdentity(path, file)) return true;
    } else {
      const identity = await stat(path);
      if (identity.isFile() && identity.dev === file.dev && identity.ino === file.ino) return true;
    }
  }
  return false;
}
export async function observe(
  stage: CapturedStage,
  root: string,
  history: string,
  outputs: Map<string, string>,
): Promise<Record<string, string>> {
  const watches: JsonValue[] = [];
  const physicalPaths = new Set<string>();
  if (stage.reuse === false) throw new Error("Always-execute has no reusable identity.");
  for (const path of [...(stage.reuse.files ?? [])].sort()) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const resolved = resolve(root, path);
      if (
        path.includes("\0") ||
        (!isAbsolute(path) && !inside(root, resolved)) ||
        (process.platform === "win32" &&
          (/^[a-z]:(?:$|[^\\/])/i.test(path) ||
            /^[\\/](?![\\/])/.test(path) ||
            path.replace(/^[a-z]:/i, "").includes(":")))
      )
        throw new AbilityBenchError(
          "unsafe_path",
          "Watch must be an exact path under root or an explicit absolute file.",
          "influence",
          { stageId: stage.id, file: path },
        );
      const physical = await realpath(resolved);
      if (inside(await physicalDestination(history), physical))
        throw new AbilityBenchError("unsafe_path", "Watched file is inside history.", "influence", {
          stageId: stage.id,
          file: path,
        });
      if (physicalPaths.has(physical))
        throw new AbilityBenchError(
          "invalid_declaration",
          "Duplicate physical watched file.",
          "influence",
          { stageId: stage.id, file: path },
        );
      physicalPaths.add(physical);
      handle = await open(
        physical,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK),
      );
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Expected a regular watched file.");
      if (info.nlink > 1 && (await containsFileIdentity(await physicalDestination(history), info)))
        throw new AbilityBenchError("unsafe_path", "Watched file aliases history.", "influence", {
          stageId: stage.id,
          file: path,
        });
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
  watches.sort((a, b) => {
    const left = (a as { path: string }).path,
      right = (b as { path: string }).path;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const values = {
    contract: {
      codec: "ordered-json-v1",
      hashScheme: "sha256-domain-v2",
      fingerprintContract: "declared-influences-v2",
    },
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
