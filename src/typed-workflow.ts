import type {
  BuiltWorkflow,
  JsonValue,
  StageCachePolicy,
  StageContext,
  StageDeclaration,
  StageFunction,
  WorkflowOptions,
} from "./types.js";
import { defineWorkflow } from "./workflow.js";

export interface StageHandle<Id extends string = string, Output extends JsonValue = JsonValue> {
  readonly id: Id;
  /** Type-only marker; no output value is stored on a stage handle. */
  readonly __output?: Output;
}

export type AnyStageHandle = StageHandle<string, JsonValue>;

export type StageHandleOutput<Handle extends AnyStageHandle> =
  Handle extends StageHandle<string, infer Output> ? Output : never;

export type DependencyOutputs<Dependencies extends readonly AnyStageHandle[]> = {
  readonly [Dependency in Dependencies[number] as Dependency["id"]]: StageHandleOutput<Dependency>;
};

export interface TypedStageContext<Dependencies extends readonly AnyStageHandle[]> {
  readonly dependencies: DependencyOutputs<Dependencies>;
  readonly inputs: StageContext["inputs"];
  readonly env: StageContext["env"];
}

export type TypedStageDeclaration<
  Id extends string,
  Dependencies extends readonly AnyStageHandle[],
  Output extends JsonValue,
> = StageCachePolicy & {
  readonly id: Id;
  readonly dependsOn: Dependencies;
  readonly implementation: string;
  readonly watch: readonly string[];
  readonly inputs: readonly string[];
  readonly env: readonly string[];
  readonly run: (context: TypedStageContext<Dependencies>) => Output | Promise<Output>;
};

export interface ComposedWorkflowOptions extends WorkflowOptions {
  readonly stages: readonly AnyStageHandle[];
}

const declarations = new WeakMap<object, StageDeclaration>();

/**
 * Declares a stage without executing it and carries its output type to direct dependents.
 */
export function defineStage<
  const Id extends string,
  const Dependencies extends readonly AnyStageHandle[],
  Output extends JsonValue,
>(declaration: TypedStageDeclaration<Id, Dependencies, Output>): StageHandle<Id, Output> {
  for (const dependency of declaration.dependsOn) {
    if (!declarations.has(dependency)) {
      throw new TypeError(
        `Stage "${declaration.id}" received a dependency that was not created by defineStage().`,
      );
    }
  }
  const run: StageFunction = (context) =>
    declaration.run(context as unknown as TypedStageContext<Dependencies>);
  const normalized: StageDeclaration = Object.freeze({
    id: declaration.id,
    dependsOn: Object.freeze(declaration.dependsOn.map(({ id }) => id)),
    implementation: declaration.implementation,
    watch: Object.freeze([...declaration.watch]),
    inputs: Object.freeze([...declaration.inputs]),
    env: Object.freeze([...declaration.env]),
    ...(declaration.volatile === true
      ? { cache: false as const, volatile: true as const }
      : declaration.cache
        ? { cache: true as const }
        : { cache: false as const }),
    run,
  });
  const handle: StageHandle<Id, Output> = Object.freeze({ id: declaration.id });
  declarations.set(handle, normalized);
  return handle;
}

/**
 * Seals a complete workflow from typed handles. Graph validation is shared with the fluent API.
 */
export function createWorkflow(options: ComposedWorkflowOptions): BuiltWorkflow {
  const builder = defineWorkflow({ id: options.id, root: options.root });
  for (const handle of options.stages) {
    const declaration = declarations.get(handle);
    if (declaration === undefined) {
      throw new TypeError(`Stage handle "${handle.id}" was not created by defineStage().`);
    }
    builder.stage(declaration);
  }
  return builder.build();
}
