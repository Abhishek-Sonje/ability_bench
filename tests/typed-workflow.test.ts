import { describe, expect, expectTypeOf, it } from "vitest";

import {
  cache,
  computeStageFingerprint,
  createWorkflow,
  defineStage,
  executeWorkflow,
  InMemoryArtifactStore,
  input,
  type JsonValue,
  planWorkflow,
} from "../src/index.js";

const cached = (revision: string) =>
  cache.enabled({
    revision,
    files: ["package.json"],
    environment: [] as const,
  });

describe("typed stage handles", () => {
  it("carries direct dependency and selected-input types into callbacks", async () => {
    let observed:
      | {
          inputs: {
            enabled: boolean;
            labels: string[];
            note: string | undefined;
          };
          env: Readonly<Record<"MODE", string | undefined>>;
        }
      | undefined;
    const seed = defineStage({
      id: "seed",
      dependsOn: [],
      inputs: {
        enabled: input.boolean("/enabled"),
        labels: input.stringArray("/labels"),
        note: input.optional(input.string("/note")),
      },
      cache: cache.enabled({
        revision: "seed-v1",
        files: ["package.json"],
        environment: ["MODE"] as const,
      }),
      run: ({ inputs, env }) => {
        expectTypeOf(inputs).toEqualTypeOf<
          Readonly<{
            enabled: boolean;
            labels: string[];
            note: string | undefined;
          }>
        >();
        expectTypeOf(env).toEqualTypeOf<Readonly<Record<"MODE", string | undefined>>>();
        observed = { inputs, env };
        return {
          count: inputs.labels.length,
          enabled: inputs.enabled,
          mode: env.MODE ?? "default",
          note: inputs.note ?? null,
        };
      },
    });
    const report = defineStage({
      id: "report",
      dependsOn: [seed],
      inputs: {},
      cache: cached("report-v1"),
      run: ({ dependencies }) => {
        expectTypeOf(dependencies.seed).toEqualTypeOf<{
          count: number;
          enabled: boolean;
          mode: string;
          note: string | null;
        }>();
        return { message: dependencies.seed.mode, total: dependencies.seed.count };
      },
    });
    const workflow = createWorkflow({
      id: "typed-handles",
      root: process.cwd(),
      stages: [seed, report],
    });
    const plan = await planWorkflow({
      workflow,
      inputs: { enabled: true, labels: ["a", "b"] },
      environment: { MODE: "strict" },
      baseline: null,
      invalidate: [],
    });
    const execution = await executeWorkflow({
      workflow,
      plan,
      inputs: { enabled: true, labels: ["a", "b"] },
      environment: { MODE: "strict" },
      artifacts: new InMemoryArtifactStore(),
    });

    expect(workflow.topologicalOrder).toEqual(["seed", "report"]);
    expect(execution.executionStatus).toBe("completed");
    expect(observed).toEqual({
      inputs: { enabled: true, labels: ["a", "b"], note: undefined },
      env: { MODE: "strict" },
    });
    expect(workflow.stages[0]?.inputContracts).toEqual({
      "/enabled": "required-boolean-v1",
      "/labels": "required-string-array-v1",
      "/note": "optional-required-string-v1",
    });
  });

  it("fails execution when a selected input violates its declared contract", async () => {
    const stage = defineStage({
      id: "typed",
      dependsOn: [],
      inputs: { count: input.number("/count") },
      cache: cached("typed-v1"),
      run: ({ inputs }) => ({ count: inputs.count }),
    });
    const workflow = createWorkflow({
      id: "typed-input-failure",
      root: process.cwd(),
      stages: [stage],
    });
    const plan = await planWorkflow({
      workflow,
      inputs: { count: "not-a-number" },
      environment: {},
      baseline: null,
      invalidate: [],
    });
    const execution = await executeWorkflow({
      workflow,
      plan,
      inputs: { count: "not-a-number" },
      environment: {},
      artifacts: new InMemoryArtifactStore(),
    });
    expect(execution).toMatchObject({
      executionStatus: "failed",
      stages: [
        {
          executionStatus: "failed",
          error: {
            name: "InputValidationError",
            message: 'Input "/count" must be a number.',
          },
        },
      ],
    });
  });

  it("includes the input contract identity in the stage fingerprint", async () => {
    const booleanStage = defineStage({
      id: "contract",
      dependsOn: [],
      inputs: { value: input.boolean("/value") },
      cache: cached("contract-v1"),
      run: ({ inputs }) => inputs.value,
    });
    const jsonStage = defineStage({
      id: "contract",
      dependsOn: [],
      inputs: { value: input.json("/value") },
      cache: cached("contract-v1"),
      run: ({ inputs }) => inputs.value,
    });
    const booleanWorkflow = createWorkflow({
      id: "input-contract",
      root: process.cwd(),
      stages: [booleanStage],
    });
    const jsonWorkflow = createWorkflow({
      id: "input-contract",
      root: process.cwd(),
      stages: [jsonStage],
    });
    const calculate = (workflow: typeof booleanWorkflow) =>
      computeStageFingerprint({
        workflowId: workflow.id,
        workflowRoot: workflow.root,
        stage: workflow.stages[0] as NonNullable<(typeof workflow.stages)[0]>,
        runInputs: { value: true },
        environment: {},
        dependencyArtifacts: {},
      });
    const booleanFingerprint = await calculate(booleanWorkflow);
    const jsonFingerprint = await calculate(jsonWorkflow);

    expect(booleanFingerprint.fingerprint).not.toBe(jsonFingerprint.fingerprint);
    expect(booleanFingerprint.componentHashes.selectedInputs).not.toBe(
      jsonFingerprint.componentHashes.selectedInputs,
    );
    expect(booleanFingerprint.componentHashes.implementation).toBe(
      jsonFingerprint.componentHashes.implementation,
    );
  });

  it("retains runtime graph validation and rejects forged declarations", () => {
    const forged = { id: "forged" } as const;
    expect(() =>
      defineStage({
        id: "consumer",
        dependsOn: [forged as unknown as ReturnType<typeof defineStage>],
        inputs: {},
        cache: cached("consumer-v1"),
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

    expect(() =>
      defineStage({
        id: "forged-cache",
        dependsOn: [],
        inputs: {},
        cache: {
          mode: "cacheable",
          revision: "v1",
          files: ["package.json"],
          environment: [],
        },
        run: () => null,
      }),
    ).toThrow("cache influences were not created");

    const missingFiles = defineStage({
      id: "missing-files",
      dependsOn: [],
      inputs: {},
      cache: cache.enabled({
        revision: "v1",
        files: [] as unknown as [string, ...string[]],
        environment: [],
      }),
      run: () => null,
    });
    expect(() =>
      createWorkflow({
        id: "missing-files",
        root: process.cwd(),
        stages: [missingFiles],
      }),
    ).toThrow("must watch a source file");
  });
});
