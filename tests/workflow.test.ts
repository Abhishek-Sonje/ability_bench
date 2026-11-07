import { describe, expect, it, vi } from "vitest";
import type { JsonValue, StageDeclaration } from "../src/types.js";
import { defineWorkflow, type WorkflowValidationError } from "../src/workflow.js";

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
  it("rejects unsafe identifiers and duplicate stage identities", () => {
    for (const id of ["", "../outside", "Bad", "a--b", "a/b"]) {
      expect(() => defineWorkflow({ id: "valid", root }).stage(stage(id)).build()).toThrow();
      expect(() => defineWorkflow({ id, root }).stage(stage("valid")).build()).toThrow();
    }
    expect(() =>
      defineWorkflow({ id: "valid", root }).stage(stage("same")).stage(stage("same")).build(),
    ).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "duplicate_stage" })]),
      }),
    );
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
});
