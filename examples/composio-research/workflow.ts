import { readFile } from "node:fs/promises";
import { cache, createWorkflow, defineStage, input } from "abilitybench";

const inventory = defineStage({
  id: "inventory",
  dependsOn: [],
  inputs: { apps: input.stringArray("/apps") },
  cache: cache.enabled({ revision: "inventory-v1", files: ["workflow.ts"], environment: [] }),
  run: ({ inputs }) => ({ apps: inputs.apps, count: inputs.apps.length }),
});

const evidence = defineStage({
  id: "evidence",
  dependsOn: [inventory],
  inputs: { officialMentions: input.stringArray("/officialMentions") },
  cache: cache.enabled({
    revision: "evidence-v1",
    files: ["workflow.ts", "evidence-policy.json"],
    environment: [],
  }),
  run: async ({ dependencies, inputs }) => {
    const policy: unknown = JSON.parse(
      await readFile(new URL("./evidence-policy.json", import.meta.url), "utf8"),
    );
    if (
      policy === null ||
      typeof policy !== "object" ||
      !("minimumOfficialSources" in policy) ||
      typeof policy.minimumOfficialSources !== "number" ||
      !Number.isInteger(policy.minimumOfficialSources) ||
      policy.minimumOfficialSources < 1
    ) {
      throw new Error("minimumOfficialSources must be a positive integer.");
    }
    const minimum = policy.minimumOfficialSources;
    return {
      supported: dependencies.inventory.apps.filter(
        (app) => inputs.officialMentions.filter((name) => name === app).length >= minimum,
      ),
      minimum,
    };
  },
});

const feasibility = defineStage({
  id: "feasibility",
  dependsOn: [inventory],
  inputs: {
    feasibleApps: input.stringArray("/feasibleApps"),
    highConfidenceApps: input.stringArray("/highConfidenceApps"),
  },
  cache: cache.enabled({
    revision: "feasibility-v1",
    files: ["workflow.ts"],
    environment: ["ABILITYBENCH_REQUIRE_HIGH_CONFIDENCE"],
  }),
  run: ({ dependencies, inputs, env }) => {
    const value = env.ABILITYBENCH_REQUIRE_HIGH_CONFIDENCE;
    if (value !== "true" && value !== "false")
      throw new Error("ABILITYBENCH_REQUIRE_HIGH_CONFIDENCE must be true or false.");
    return {
      eligible: dependencies.inventory.apps.filter(
        (app) =>
          inputs.feasibleApps.includes(app) &&
          (value === "false" || inputs.highConfidenceApps.includes(app)),
      ),
      requireHighConfidence: value === "true",
    };
  },
});

const summary = defineStage({
  id: "summary",
  dependsOn: [evidence, feasibility],
  inputs: {},
  cache: cache.enabled({ revision: "summary-v1", files: ["workflow.ts"], environment: [] }),
  run: ({ dependencies }) => ({
    candidates: dependencies.feasibility.eligible.filter((app) =>
      dependencies.evidence.supported.includes(app),
    ),
  }),
});

const report = defineStage({
  id: "report",
  dependsOn: [summary],
  inputs: { fail: input.boolean("/failReport") },
  cache: cache.enabled({ revision: "report-v1", files: ["workflow.ts"], environment: [] }),
  run: ({ dependencies, inputs }) => {
    if (inputs.fail) throw new Error("Intentional report failure for demonstration.");
    return {
      candidates: dependencies.summary.candidates,
      message: `${dependencies.summary.candidates.length} captured research records meet the declared screening rules.`,
    };
  },
});

const delivery = defineStage({
  id: "delivery",
  dependsOn: [report],
  inputs: {},
  cache: cache.disabled({ revision: "delivery-v1", files: ["workflow.ts"], environment: [] }),
  run: ({ dependencies }) => ({
    mode: "dry-run",
    candidateCount: dependencies.report.candidates.length,
  }),
});

export default createWorkflow({
  id: "composio-research-screening",
  root: import.meta.dirname,
  stages: [inventory, evidence, feasibility, summary, report, delivery],
});
