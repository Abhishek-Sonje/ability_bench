import { describe, expect, expectTypeOf, it } from "vitest";
import { cache, createWorkflow, defineStage } from "../src/typed-workflow.js";

// Retained inference/registration machinery; #13 supplies the supported SDK.
const identity = () => cache.enabled({ revision: "v1", files: ["package.json"], environment: [] });

describe("retained typed graph machinery", () => {
  it("infers dependency outputs and builds without invoking callbacks", () => {
    let calls = 0;
    const seed = defineStage({
      id: "seed",
      dependsOn: [],
      inputs: {},
      cache: identity(),
      run: () => {
        calls++;
        return { count: 2 };
      },
    });
    const consumer = defineStage({
      id: "consumer",
      dependsOn: [seed],
      inputs: {},
      cache: identity(),
      run: ({ dependencies }) => {
        expectTypeOf(dependencies.seed).toEqualTypeOf<{ count: number }>();
        // @ts-expect-error Inferred output fields reject the wrong value type.
        const wrong: string = dependencies.seed.count;
        void wrong;
        return dependencies.seed.count;
      },
    });
    const workflow = createWorkflow({ id: "typed", root: process.cwd(), stages: [consumer, seed] });
    expect(workflow.topologicalOrder).toEqual(["seed", "consumer"]);
    expect(calls).toBe(0);
  });

  it("rejects an unregistered handle", () => {
    const forged = { id: "forged" };
    expect(() => createWorkflow({ id: "typed", root: process.cwd(), stages: [forged] })).toThrow(
      "was not created by defineStage",
    );
  });
});
