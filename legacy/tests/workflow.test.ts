import { describe, expect, it, vi } from "vitest";

import {
  defineWorkflow,
  type JsonValue,
  type StageDeclaration,
  type WorkflowValidationError,
} from "../src/index.js";

const root = process.cwd();
const run = vi.fn<() => JsonValue>(() => null);

function stage(
  id: string,
  dependsOn: readonly string[] = [],
  overrides: Partial<StageDeclaration> = {},
): StageDeclaration {
  return {
    id,
    dependsOn,
    implementation: `${id}-v1`,
    watch: [`./${id}.ts`],
    inputs: [],
    env: [],
    cache: true,
    run,
    ...overrides,
  } as StageDeclaration;
}

describe("workflow declaration", () => {
  it("orders a branch-and-join graph without executing stages", () => {
    const workflow = defineWorkflow({ id: "branching-example", root })
      .stage(stage("seed"))
      .stage(stage("right", ["seed"]))
      .stage(stage("left", ["seed"]))
      .stage(stage("join", ["left", "right"]))
      .stage(stage("report", ["join"]))
      .stage(stage("independent"))
      .build();

    expect(workflow.topologicalOrder).toEqual([
      "independent",
      "seed",
      "left",
      "right",
      "join",
      "report",
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(Object.isFrozen(workflow)).toBe(true);
  });

  it("reports a deterministic cycle path", () => {
    const builder = defineWorkflow({ id: "cycle-example", root })
      .stage(stage("left", ["join"]))
      .stage(stage("right", ["seed"]))
      .stage(stage("join", ["left", "right"]))
      .stage(stage("seed", ["join"]));

    expect(() => builder.build()).toThrowError(
      expect.objectContaining<Partial<WorkflowValidationError>>({
        issues: [expect.objectContaining({ code: "cycle" })],
      }),
    );
  });

  it("rejects missing and self dependencies", () => {
    const builder = defineWorkflow({ id: "invalid-graph", root })
      .stage(stage("self", ["self"]))
      .stage(stage("consumer", ["missing"]));
    expect(() => builder.build()).toThrowError(
      expect.objectContaining<Partial<WorkflowValidationError>>({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "self_dependency" }),
          expect.objectContaining({ code: "missing_dependency" }),
        ]),
      }),
    );
  });

  it("rejects duplicate declaration fields", () => {
    const builder = defineWorkflow({ id: "duplicate-example", root })
      .stage(stage("same"))
      .stage(
        stage("same", ["same", "same"], {
          watch: ["./same.ts", "./same.ts"],
          inputs: ["/value", "/value"],
          env: ["VALUE", "VALUE"],
        }),
      );
    expect(() => builder.build()).toThrowError(
      expect.objectContaining<Partial<WorkflowValidationError>>({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "duplicate_stage" }),
          expect.objectContaining({ code: "duplicate_dependency" }),
          expect.objectContaining({ code: "duplicate_watch" }),
          expect.objectContaining({ code: "duplicate_input" }),
          expect.objectContaining({ code: "duplicate_environment" }),
        ]),
      }),
    );
  });

  it("enforces cache metadata", () => {
    const invalid = defineWorkflow({ id: "cache-contract", root }).stage(
      stage("cacheable", [], { implementation: "  ", watch: [] }),
    );
    expect(() => invalid.build()).toThrowError(
      expect.objectContaining<Partial<WorkflowValidationError>>({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "empty_implementation" }),
          expect.objectContaining({ code: "missing_watch" }),
        ]),
      }),
    );

    const valid = defineWorkflow({ id: "non-cacheable", root })
      .stage(stage("clock", [], { cache: false, watch: [] }))
      .stage(stage("random", [], { cache: false, volatile: true, watch: [] }))
      .build();
    expect(valid.stages.map(({ cachePolicy }) => cachePolicy)).toEqual(["disabled", "volatile"]);

    const conflicting = defineWorkflow({ id: "conflicting-cache", root }).stage(
      stage("unsafe", [], { cache: true, volatile: true } as unknown as Partial<StageDeclaration>),
    );
    expect(() => conflicting.build()).toThrowError(
      expect.objectContaining<Partial<WorkflowValidationError>>({
        issues: [expect.objectContaining({ code: "invalid_cache_policy" })],
      }),
    );
  });

  it("rejects paths outside the workflow root", () => {
    const builder = defineWorkflow({ id: "escaped-path", root }).stage(
      stage("unsafe", [], { watch: ["../outside.ts"] }),
    );
    expect(() => builder.build()).toThrowError(
      expect.objectContaining<Partial<WorkflowValidationError>>({
        issues: [expect.objectContaining({ code: "invalid_watch_path" })],
      }),
    );
  });

  it("rejects malformed input contract metadata", () => {
    const builder = defineWorkflow({ id: "input-contracts", root })
      .stage(
        stage("empty-contract", [], {
          inputs: ["/value"],
          inputContracts: { "/value": "" },
        }),
      )
      .stage(
        stage("unknown-contract", [], {
          inputs: [],
          inputContracts: { "/undeclared": "required-string-v1" },
        }),
      );
    expect(() => builder.build()).toThrowError(
      expect.objectContaining<Partial<WorkflowValidationError>>({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "invalid_input_contract", stageId: "empty-contract" }),
          expect.objectContaining({ code: "invalid_input_contract", stageId: "unknown-contract" }),
        ]),
      }),
    );
  });

  it("seals a builder after build", () => {
    const builder = defineWorkflow({ id: "sealed", root }).stage(stage("only"));
    builder.build();
    expect(() => builder.stage(stage("late"))).toThrowError(
      expect.objectContaining<Partial<WorkflowValidationError>>({
        issues: [expect.objectContaining({ code: "sealed_workflow" })],
      }),
    );
  });
});
