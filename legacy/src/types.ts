import type { ABILITYBENCH_CONTRACT_VERSION } from "./version.js";

export type JsonPrimitive = null | boolean | string | number;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type StageCachePolicy =
  | { readonly cache: true; readonly volatile?: false }
  | { readonly cache: false; readonly volatile?: false }
  | { readonly cache?: false; readonly volatile: true };

export interface StageContext {
  readonly dependencies: Readonly<Record<string, JsonValue>>;
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type StageFunction = (context: StageContext) => JsonValue | Promise<JsonValue>;

export type StageDeclaration = StageCachePolicy & {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly implementation: string;
  readonly watch: readonly string[];
  readonly inputs: readonly string[];
  /** Stable input contracts keyed by JSON Pointer. Internal typed-SDK field. */
  readonly inputContracts?: Readonly<Record<string, string>>;
  readonly env: readonly string[];
  readonly run: StageFunction;
};

export interface WorkflowOptions {
  readonly id: string;
  readonly root: string;
}

export type CachePolicy = "cacheable" | "disabled" | "volatile";

export interface StageDefinition {
  readonly id: string;
  readonly dependencyIds: readonly string[];
  readonly implementation: string;
  readonly watchedPaths: readonly string[];
  readonly inputPointers: readonly string[];
  readonly inputContracts: Readonly<Record<string, string>>;
  readonly environmentNames: readonly string[];
  readonly cachePolicy: CachePolicy;
  readonly outputCodec: "canonical-json-v1";
  readonly run: StageFunction;
}

export interface BuiltWorkflow {
  readonly id: string;
  readonly root: string;
  readonly contractVersion: typeof ABILITYBENCH_CONTRACT_VERSION;
  readonly stages: readonly StageDefinition[];
  readonly topologicalOrder: readonly string[];
}
