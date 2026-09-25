import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createWorkflow, defineStage, type JsonValue } from "../src/index.js";

describe("typed stage handles", () => {
  it("carries direct dependency output types into callbacks", () => {
    const run = vi.fn(() => ({ count: 3, label: "seed" }));
    const seed = defineStage({
      id: "seed",
      dependsOn: [],
      implementation: "seed-v1",
      watch: ["workflow.ts"],
      inputs: [],
      env: [],
      cache: true,
      run,
    });
    const report = defineStage({
      id: "report",
      dependsOn: [seed],
      implementation: "report-v1",
      watch: ["workflow.ts"],
      inputs: [],
      env: [],
      cache: true,
      run: ({ dependencies }) => {
        expectTypeOf(dependencies.seed).toEqualTypeOf<{
          count: number;
          label: string;
        }>();
        return { message: dependencies.seed.label, total: dependencies.seed.count };
      },
    });
    const workflow = createWorkflow({
      id: "typed-handles",
      root: process.cwd(),
      stages: [seed, report],
    });

    expect(workflow.topologicalOrder).toEqual(["seed", "report"]);
    expect(run).not.toHaveBeenCalled();
  });

  it("retains runtime graph validation and rejects forged handles", () => {
    const forged = { id: "forged" } as const;
    expect(() =>
      defineStage({
        id: "consumer",
        dependsOn: [forged as unknown as ReturnType<typeof defineStage>],
        implementation: "v1",
        watch: ["workflow.ts"],
        inputs: [],
        env: [],
        cache: true,
        run: (): JsonValue => null,
      }),
    ).toThrow("was not created by defineStage");

    expect(() =>
      createWorkflow({
        id: "forged-workflow",
        root: process.cwd(),
        stages: [forged],
      }),
    ).toThrow("was not created by defineStage");
  });
});
