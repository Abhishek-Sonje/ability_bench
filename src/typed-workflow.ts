import type {
  BuiltWorkflow,
  JsonValue,
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

export interface InputDescriptor<Value = unknown> {
  readonly pointer: string;
  readonly contract: string;
  /** Type-only marker; no selected value is stored on a descriptor. */
  readonly __value?: Value;
}

export type AnyInputDescriptor = InputDescriptor<unknown>;
export type InputDefinitions = Readonly<Record<string, AnyInputDescriptor>>;
export type InputDescriptorValue<Descriptor extends AnyInputDescriptor> =
  Descriptor extends InputDescriptor<infer Value> ? Value : never;
export type TypedInputs<Inputs extends InputDefinitions> = {
  readonly [Name in keyof Inputs]: InputDescriptorValue<Inputs[Name]>;
};

export type InputValidationErrorCode = "input_missing" | "input_type_mismatch";

export class InputValidationError extends TypeError {
  constructor(
    readonly code: InputValidationErrorCode,
    readonly pointer: string,
    readonly expected: string,
  ) {
    super(
      code === "input_missing"
        ? `Input "${pointer}" is required as ${expected}.`
        : `Input "${pointer}" must be ${expected}.`,
    );
    this.name = "InputValidationError";
  }
}

export interface CacheInfluences<
  Mode extends "cacheable" | "disabled" | "volatile" = "cacheable" | "disabled" | "volatile",
  Environment extends readonly string[] = readonly string[],
> {
  readonly mode: Mode;
  readonly revision: string;
  readonly files: readonly string[];
  readonly environment: Environment;
}

export type AnyCacheInfluences = CacheInfluences<
  "cacheable" | "disabled" | "volatile",
  readonly string[]
>;

export type TypedEnvironment<Influences extends AnyCacheInfluences> = Readonly<
  Record<Influences["environment"][number], string | undefined>
>;

export interface TypedStageContext<
  Dependencies extends readonly AnyStageHandle[],
  Inputs extends InputDefinitions,
  Influences extends AnyCacheInfluences,
> {
  readonly dependencies: DependencyOutputs<Dependencies>;
  readonly inputs: TypedInputs<Inputs>;
  readonly env: TypedEnvironment<Influences>;
}

export interface CacheableInfluenceOptions<Environment extends readonly string[]> {
  readonly revision: string;
  readonly files: readonly [string, ...string[]];
  readonly environment: Environment;
}

export interface NonCacheableInfluenceOptions<Environment extends readonly string[]> {
  readonly revision: string;
  readonly files: readonly string[];
  readonly environment: Environment;
}

export type TypedStageDeclaration<
  Id extends string,
  Dependencies extends readonly AnyStageHandle[],
  Inputs extends InputDefinitions,
  Influences extends AnyCacheInfluences,
  Output extends JsonValue,
> = {
  readonly id: Id;
  readonly dependsOn: Dependencies;
  readonly inputs: Inputs;
  readonly cache: Influences;
  readonly run: (
    context: TypedStageContext<Dependencies, Inputs, Influences>,
  ) => Output | Promise<Output>;
};

export interface ComposedWorkflowOptions extends WorkflowOptions {
  readonly stages: readonly AnyStageHandle[];
}

type InputParser = (value: JsonValue | undefined, pointer: string) => unknown;

const declarations = new WeakMap<object, StageDeclaration>();
const inputParsers = new WeakMap<object, InputParser>();
const influenceDeclarations = new WeakSet<object>();

/** Internal descriptor provenance check shared by declaration APIs. */
export function isBuiltInInputDescriptor(value: unknown): value is AnyInputDescriptor {
  return typeof value === "object" && value !== null && inputParsers.has(value);
}

/** Internal runtime parsing shared by stage and evaluation preparation. */
export function parseBuiltInInputDescriptor(
  descriptor: AnyInputDescriptor,
  value: JsonValue | undefined,
): unknown {
  const parse = inputParsers.get(descriptor);
  if (!parse)
    throw new TypeError("Input descriptor was not created by the AbilityBench input API.");
  return parse(value, descriptor.pointer);
}

function required<Value>(value: Value | undefined, pointer: string, expected: string): Value {
  if (value === undefined) {
    throw new InputValidationError("input_missing", pointer, expected);
  }
  return value;
}

function descriptor<Value>(
  pointer: string,
  contract: string,
  parse: InputParser,
): InputDescriptor<Value> {
  const result: InputDescriptor<Value> = Object.freeze({ pointer, contract });
  inputParsers.set(result, parse);
  return result;
}

function scalar<Value extends JsonValue>(
  pointer: string,
  kind: "boolean" | "number" | "string",
): InputDescriptor<Value> {
  return descriptor<Value>(pointer, `required-${kind}-v1`, (value) => {
    const selected = required(value, pointer, kind);
    if (typeof selected !== kind) {
      throw new InputValidationError("input_type_mismatch", pointer, `a ${kind}`);
    }
    return selected;
  });
}

export const input = Object.freeze({
  json(pointer: string): InputDescriptor<JsonValue> {
    return descriptor(pointer, "required-json-v1", (value) =>
      required(value, pointer, "JSON value"),
    );
  },
  boolean(pointer: string): InputDescriptor<boolean> {
    return scalar<boolean>(pointer, "boolean");
  },
  number(pointer: string): InputDescriptor<number> {
    return scalar<number>(pointer, "number");
  },
  string(pointer: string): InputDescriptor<string> {
    return scalar<string>(pointer, "string");
  },
  stringArray(pointer: string): InputDescriptor<string[]> {
    return descriptor(pointer, "required-string-array-v1", (value) => {
      const selected = required(value, pointer, "string array");
      if (!Array.isArray(selected) || !selected.every((item) => typeof item === "string")) {
        throw new InputValidationError("input_type_mismatch", pointer, "an array of strings");
      }
      return selected;
    });
  },
  optional<Value>(base: InputDescriptor<Value>): InputDescriptor<Value | undefined> {
    const parse = inputParsers.get(base);
    if (parse === undefined) {
      throw new TypeError("Optional input base was not created by the AbilityBench input API.");
    }
    return descriptor(base.pointer, `optional-${base.contract}`, (value, pointer) =>
      value === undefined ? undefined : parse(value, pointer),
    );
  },
});

function influences<
  const Mode extends "cacheable" | "disabled" | "volatile",
  const Environment extends readonly string[],
>(
  mode: Mode,
  options: CacheableInfluenceOptions<Environment> | NonCacheableInfluenceOptions<Environment>,
): CacheInfluences<Mode, Environment> {
  const result: CacheInfluences<Mode, Environment> = Object.freeze({
    mode,
    revision: options.revision,
    files: Object.freeze([...options.files]),
    environment: Object.freeze([...options.environment]) as unknown as Environment,
  });
  influenceDeclarations.add(result);
  return result;
}

export const cache = Object.freeze({
  enabled<const Environment extends readonly string[]>(
    options: CacheableInfluenceOptions<Environment>,
  ): CacheInfluences<"cacheable", Environment> {
    return influences("cacheable", options);
  },
  disabled<const Environment extends readonly string[]>(
    options: NonCacheableInfluenceOptions<Environment>,
  ): CacheInfluences<"disabled", Environment> {
    return influences("disabled", options);
  },
  volatile<const Environment extends readonly string[]>(
    options: NonCacheableInfluenceOptions<Environment>,
  ): CacheInfluences<"volatile", Environment> {
    return influences("volatile", options);
  },
});

/**
 * Declares a stage without executing it and carries its input and output types to callbacks.
 */
export function defineStage<
  const Id extends string,
  const Dependencies extends readonly AnyStageHandle[],
  const Inputs extends InputDefinitions,
  const Influences extends AnyCacheInfluences,
  Output extends JsonValue,
>(
  declaration: TypedStageDeclaration<Id, Dependencies, Inputs, Influences, Output>,
): StageHandle<Id, Output> {
  for (const dependency of declaration.dependsOn) {
    if (!declarations.has(dependency)) {
      throw new TypeError(
        `Stage "${declaration.id}" received a dependency that was not created by defineStage().`,
      );
    }
  }
  if (!influenceDeclarations.has(declaration.cache)) {
    throw new TypeError(
      `Stage "${declaration.id}" cache influences were not created by the AbilityBench cache API.`,
    );
  }

  const pointers = new Map<string, string>();
  const typedInputs = Object.entries(declaration.inputs).map(([name, selection]) => {
    const parse = inputParsers.get(selection);
    if (parse === undefined) {
      throw new TypeError(
        `Stage "${declaration.id}" input "${name}" was not created by the AbilityBench input API.`,
      );
    }
    const existing = pointers.get(selection.pointer);
    if (existing !== undefined && existing !== selection.contract) {
      throw new TypeError(
        `Stage "${declaration.id}" declares conflicting contracts for "${selection.pointer}".`,
      );
    }
    pointers.set(selection.pointer, selection.contract);
    return { name, parse, selection };
  });

  const run: StageFunction = (context) => {
    const selected = Object.freeze(
      Object.fromEntries(
        typedInputs.map(({ name, parse, selection }) => [
          name,
          parse(context.inputs[selection.pointer], selection.pointer),
        ]),
      ),
    ) as TypedInputs<Inputs>;
    return declaration.run({
      dependencies: context.dependencies as DependencyOutputs<Dependencies>,
      inputs: selected,
      env: context.env as TypedEnvironment<Influences>,
    });
  };
  const normalized: StageDeclaration = Object.freeze({
    id: declaration.id,
    dependsOn: Object.freeze(declaration.dependsOn.map(({ id }) => id)),
    implementation: declaration.cache.revision,
    watch: declaration.cache.files,
    inputs: Object.freeze([...pointers.keys()]),
    inputContracts: Object.freeze(Object.fromEntries(pointers)),
    env: declaration.cache.environment,
    ...(declaration.cache.mode === "volatile"
      ? { cache: false as const, volatile: true as const }
      : declaration.cache.mode === "cacheable"
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
