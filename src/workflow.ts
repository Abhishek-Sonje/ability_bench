import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  BuiltWorkflow,
  CachePolicy,
  StageDeclaration,
  StageDefinition,
  WorkflowOptions,
} from "./types.js";
import { ABILITYBENCH_CONTRACT_VERSION } from "./version.js";

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)*$/;

export type WorkflowValidationCode =
  | "cycle"
  | "duplicate_dependency"
  | "duplicate_environment"
  | "duplicate_input"
  | "duplicate_stage"
  | "duplicate_watch"
  | "empty_implementation"
  | "invalid_environment_name"
  | "invalid_input_pointer"
  | "invalid_stage_id"
  | "invalid_watch_path"
  | "invalid_workflow_id"
  | "missing_dependency"
  | "missing_watch"
  | "sealed_workflow"
  | "self_dependency";

export interface WorkflowValidationIssue {
  readonly code: WorkflowValidationCode;
  readonly message: string;
  readonly stageId?: string;
}

export class WorkflowValidationError extends Error {
  readonly issues: readonly WorkflowValidationIssue[];

  constructor(issues: readonly WorkflowValidationIssue[]) {
    super(issues.map(({ message }) => message).join("\n"));
    this.name = "WorkflowValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

export interface WorkflowBuilder {
  stage(declaration: StageDeclaration): WorkflowBuilder;
  build(): BuiltWorkflow;
}

class DefaultWorkflowBuilder implements WorkflowBuilder {
  readonly #declarations: StageDeclaration[] = [];
  #sealed = false;

  constructor(readonly options: WorkflowOptions) {}

  stage(declaration: StageDeclaration): WorkflowBuilder {
    this.#assertOpen();
    this.#declarations.push(declaration);
    return this;
  }

  build(): BuiltWorkflow {
    this.#assertOpen();
    this.#sealed = true;
    return buildWorkflow(this.options, this.#declarations);
  }

  #assertOpen(): void {
    if (this.#sealed) {
      throw new WorkflowValidationError([
        {
          code: "sealed_workflow",
          message: `Workflow "${this.options.id}" has already been built.`,
        },
      ]);
    }
  }
}

export function defineWorkflow(options: WorkflowOptions): WorkflowBuilder {
  return new DefaultWorkflowBuilder(options);
}

function buildWorkflow(
  options: WorkflowOptions,
  declarations: readonly StageDeclaration[],
): BuiltWorkflow {
  const issues: WorkflowValidationIssue[] = [];
  const root = resolve(options.root);
  if (!ID_PATTERN.test(options.id)) {
    issues.push(issue("invalid_workflow_id", `Workflow ID "${options.id}" is invalid.`));
  }

  const ids = new Set<string>();
  for (const { id } of declarations) {
    if (ids.has(id)) {
      issues.push(issue("duplicate_stage", `Stage ID "${id}" is declared more than once.`, id));
    }
    ids.add(id);
  }

  const stages = declarations.map((value) => normalizeStage(value, root, ids, issues));
  if (issues.length > 0) throw new WorkflowValidationError(issues);

  return Object.freeze({
    id: options.id,
    root,
    contractVersion: ABILITYBENCH_CONTRACT_VERSION,
    stages: Object.freeze(stages),
    topologicalOrder: Object.freeze(topologicalSort(stages)),
  });
}

function normalizeStage(
  declaration: StageDeclaration,
  root: string,
  allIds: ReadonlySet<string>,
  issues: WorkflowValidationIssue[],
): StageDefinition {
  const id = declaration.id;
  if (!ID_PATTERN.test(id)) {
    issues.push(issue("invalid_stage_id", `Stage ID "${id}" is invalid.`, id));
  }

  validateUnique(declaration.dependsOn, "duplicate_dependency", "dependency", id, issues);
  validateUnique(declaration.watch, "duplicate_watch", "watched path", id, issues);
  validateUnique(declaration.inputs, "duplicate_input", "input pointer", id, issues);
  validateUnique(declaration.env, "duplicate_environment", "environment name", id, issues);

  for (const dependency of declaration.dependsOn) {
    if (dependency === id) {
      issues.push(issue("self_dependency", `Stage "${id}" cannot depend on itself.`, id));
    } else if (!allIds.has(dependency)) {
      issues.push(
        issue("missing_dependency", `Stage "${id}" depends on missing stage "${dependency}".`, id),
      );
    }
  }

  if (declaration.implementation.trim() === "") {
    issues.push(
      issue("empty_implementation", `Stage "${id}" requires an implementation revision.`, id),
    );
  }

  const cachePolicy = getCachePolicy(declaration);
  if (cachePolicy === "cacheable" && declaration.watch.length === 0) {
    issues.push(issue("missing_watch", `Cacheable stage "${id}" must watch a source file.`, id));
  }

  const watchedPaths = declaration.watch.map((path) => {
    const absolute = resolve(root, path);
    const normalized = relative(root, absolute);
    const escapes =
      path === "" ||
      normalized === ".." ||
      normalized.startsWith(`..${sep}`) ||
      isAbsolute(normalized);
    if (escapes) {
      issues.push(
        issue("invalid_watch_path", `Watched path "${path}" escapes the workflow root.`, id),
      );
    }
    return normalized.split(sep).join("/");
  });

  for (const pointer of declaration.inputs) {
    if (!JSON_POINTER_PATTERN.test(pointer)) {
      issues.push(
        issue("invalid_input_pointer", `Input selector "${pointer}" is not a JSON Pointer.`, id),
      );
    }
  }
  for (const name of declaration.env) {
    if (!ENV_PATTERN.test(name)) {
      issues.push(issue("invalid_environment_name", `Environment name "${name}" is invalid.`, id));
    }
  }

  return Object.freeze({
    id,
    dependencyIds: Object.freeze([...declaration.dependsOn]),
    implementation: declaration.implementation,
    watchedPaths: Object.freeze(watchedPaths),
    inputPointers: Object.freeze([...declaration.inputs]),
    environmentNames: Object.freeze([...declaration.env]),
    cachePolicy,
    outputCodec: "canonical-json-v1",
    run: declaration.run,
  });
}

function getCachePolicy(declaration: StageDeclaration): CachePolicy {
  if (declaration.volatile === true) return "volatile";
  return declaration.cache ? "cacheable" : "disabled";
}

function validateUnique(
  values: readonly string[],
  code: Extract<WorkflowValidationCode, `duplicate_${string}`>,
  label: string,
  stageId: string,
  issues: WorkflowValidationIssue[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      issues.push(issue(code, `Stage "${stageId}" repeats ${label} "${value}".`, stageId));
    }
    seen.add(value);
  }
}

function topologicalSort(stages: readonly StageDefinition[]): string[] {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const indegree = new Map(stages.map((stage) => [stage.id, stage.dependencyIds.length]));
  const dependents = new Map(stages.map((stage) => [stage.id, [] as string[]]));
  for (const stage of stages) {
    for (const dependency of stage.dependencyIds) dependents.get(dependency)?.push(stage.id);
  }
  for (const values of dependents.values()) values.sort(compareIds);

  const ready = stages
    .filter(({ id }) => indegree.get(id) === 0)
    .map(({ id }) => id)
    .sort(compareIds);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) insertSorted(ready, dependent);
    }
  }

  if (order.length !== stages.length) {
    const cycle = findCycle(byId);
    throw new WorkflowValidationError([
      issue("cycle", `Workflow contains a dependency cycle: ${cycle.join(" -> ")}.`),
    ]);
  }
  return order;
}

function findCycle(stages: ReadonlyMap<string, StageDefinition>): string[] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (active.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return undefined;
    visited.add(id);
    active.add(id);
    stack.push(id);
    for (const dependency of [...(stages.get(id)?.dependencyIds ?? [])].sort(compareIds)) {
      const cycle = visit(dependency);
      if (cycle !== undefined) return cycle;
    }
    stack.pop();
    active.delete(id);
    return undefined;
  };
  for (const id of [...stages.keys()].sort(compareIds)) {
    const cycle = visit(id);
    if (cycle !== undefined) return cycle;
  }
  return [];
}

function insertSorted(values: string[], value: string): void {
  const index = values.findIndex((current) => compareIds(value, current) < 0);
  index === -1 ? values.push(value) : values.splice(index, 0, value);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function issue(
  code: WorkflowValidationCode,
  message: string,
  stageId?: string,
): WorkflowValidationIssue {
  return stageId === undefined ? { code, message } : { code, message, stageId };
}
