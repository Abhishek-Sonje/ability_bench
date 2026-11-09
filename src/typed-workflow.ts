import { AbilityBenchError } from "./errors.js";
import { type RecordedRun, validId } from "./recorded-data.js";
import { copyValue } from "./recorded-values.js";
import type { JsonObject, JsonValue } from "./types.js";
import { defineWorkflow } from "./workflow.js";

export interface StageHandle<Output extends JsonValue = JsonValue> {
  readonly id: string;
  readonly __output?: Output;
}
export type DependencyBindings = Readonly<Record<string, StageHandle>>;
export type DependencyOutputs<D extends DependencyBindings> = {
  [K in keyof D]: D[K] extends StageHandle<infer O> ? O : never;
};
export interface ReuseOptions {
  readonly revision?: string;
  readonly files?: readonly string[];
}
export interface StageOptions<
  D extends DependencyBindings,
  I extends JsonObject,
  O extends JsonValue,
> {
  readonly id: string;
  readonly dependencies?: D;
  readonly inputs?: I;
  readonly environment?: readonly string[];
  readonly reuse?: false | ReuseOptions;
  readonly run: (context: {
    inputs: I;
    dependencies: DependencyOutputs<D>;
    env: Record<string, string | undefined>;
  }) => O | Promise<O>;
}
export interface StageMetadata {
  id: string;
  dependencies: DependencyBindings;
  inputs: JsonObject;
  environment: readonly string[];
  reuse: false | ReuseOptions;
  run: (context: {
    inputs: JsonObject;
    dependencies: Record<string, JsonValue>;
    env: Record<string, string | undefined>;
  }) => JsonValue | Promise<JsonValue>;
}
const declarations = new WeakMap<StageHandle, StageMetadata>();
export interface Workflow {
  readonly id: string;
  readonly root: string;
  readonly topologicalOrder: readonly string[];
}
const workflows = new WeakMap<Workflow, readonly StageHandle[]>();
function copyInputs(value: unknown, stageId: string): JsonObject {
  try {
    return copyValue(value) as JsonObject;
  } catch (error) {
    if (error instanceof AbilityBenchError)
      throw new AbilityBenchError(error.code, error.message, error.operation, {
        ...error.context,
        stageId,
      });
    throw error;
  }
}
function plainObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function invalid(message: string): never {
  throw new AbilityBenchError("invalid_declaration", message, "declaration");
}
export function stage<
  D extends DependencyBindings = Record<never, never>,
  I extends JsonObject = JsonObject,
  O extends JsonValue = JsonValue,
>(options: StageOptions<D, I, O>): StageHandle<O> {
  if (!options || typeof options.run !== "function") invalid("A stage requires a callback.");
  if (!validId(options.id)) invalid("Invalid stage identifier.");
  const handle = Object.freeze({ id: options.id });
  // Registration retains ordinary declarations for the future preparation snapshot.
  declarations.set(handle, options as unknown as StageMetadata);
  return handle;
}
export type RefreshOptions =
  | { readonly scope?: "selected" | "descendants"; readonly stages: readonly StageHandle[] }
  | { readonly scope: "all"; readonly stages?: never };

export function normalizeRefresh(
  refresh: RefreshOptions | undefined,
  handles: readonly StageHandle[],
): RecordedRun["refresh"] {
  if (refresh === undefined) return { scope: "selected", stageIds: [] };
  if (plainObject(refresh)) {
    const { scope = "selected", stages } = refresh;
    if (scope === "all" && !Object.hasOwn(refresh, "stages") && stages === undefined)
      return { scope, stageIds: [] };
    if ((scope === "selected" || scope === "descendants") && Array.isArray(stages)) {
      const selected = [...Array.prototype.values.call(stages)];
      if (selected.every((handle) => handles.includes(handle)))
        return { scope, stageIds: [...new Set(selected.map((handle) => handle.id))].sort() };
    }
  }
  throw new AbilityBenchError(
    "invalid_argument",
    "Refresh requires workflow stage handles with selected or descendants scope, or all without a stage list.",
    "prepare",
  );
}

export function workflowDeclarations(workflow: Workflow): {
  stages: StageMetadata[];
  order: readonly string[];
  handles: readonly StageHandle[];
} {
  const handles = workflows.get(workflow);
  if (!handles) invalid("Workflow was not assembled by createWorkflow.");
  const stages = normalizeDeclarations(handles);
  return {
    stages,
    handles,
    order: validateGraph(workflow.id, workflow.root, stages).topologicalOrder,
  };
}
function normalizeDeclarations(handles: readonly StageHandle[]): StageMetadata[] {
  return handles.map((handle) => {
    const options = declarations.get(handle);
    if (!options) invalid("Unregistered stage handle.");
    const dependencies = options.dependencies === undefined ? {} : options.dependencies;
    if (!plainObject(dependencies)) invalid("Dependencies must be an ordinary binding map.");
    const inputs = options.inputs === undefined ? {} : options.inputs;
    if (!plainObject(inputs)) invalid("Inputs must be an ordinary JSON object.");
    const environment = options.environment === undefined ? [] : options.environment;
    if (!Array.isArray(environment) || [...environment].some((name) => typeof name !== "string"))
      invalid("Environment must be an array of names.");
    for (const [name, target] of Object.entries(dependencies)) {
      if (!name || !declarations.has(target) || !handles.includes(target))
        invalid("Invalid or out-of-graph dependency binding.");
    }
    const reuse = options.reuse === undefined ? false : options.reuse;
    if (reuse !== false && !plainObject(reuse))
      invalid("Reuse must be false or ordinary metadata.");
    if (reuse !== false) {
      const files = reuse.files === undefined ? [] : reuse.files;
      if (!Array.isArray(files)) invalid("Reuse files must be an array.");
      if (
        (reuse.revision !== undefined &&
          (typeof reuse.revision !== "string" || !reuse.revision.trim())) ||
        (!reuse.revision && !files.length) ||
        new Set(files).size !== files.length ||
        [...files].some((p) => typeof p !== "string" || !p.trim())
      )
        invalid("Reuse requires nonempty revision or unique files.");
    }
    return {
      id: handle.id,
      dependencies: Object.fromEntries(Object.entries(dependencies)),
      inputs: copyInputs(inputs, handle.id),
      environment: [...environment],
      reuse: reuse === false ? false : { ...reuse, files: [...(reuse.files ?? [])] },
      run: options.run,
    };
  });
}
export function createWorkflow(options: {
  id: string;
  root: string;
  stages: readonly StageHandle[];
}): Workflow {
  if (!validId(options.id)) invalid("Invalid workflow identifier.");
  for (const handle of options.stages)
    if (!declarations.has(handle)) invalid("Unregistered stage handle.");
  const handles = [...options.stages];
  const metadata = normalizeDeclarations(handles);
  const normalized = validateGraph(options.id, options.root, metadata);
  const workflow = Object.freeze({
    id: normalized.id,
    root: normalized.root,
    topologicalOrder: normalized.topologicalOrder,
  });
  workflows.set(workflow, handles);
  return workflow;
}
function validateGraph(id: string, root: string, metadata: StageMetadata[]) {
  const builder = defineWorkflow({ id, root });
  for (const item of metadata)
    builder.stage({
      id: item.id,
      dependsOn: [...new Set(Object.values(item.dependencies).map((h) => h.id))],
      implementation: "declared",
      watch: [],
      inputs: [],
      env: item.environment,
      cache: false,
      run: () => null,
    });
  try {
    return builder.build();
  } catch (error) {
    invalid(error instanceof Error ? error.message : "Invalid graph.");
  }
}
