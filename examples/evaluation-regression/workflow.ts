import { cache, createWorkflow, defineStage, input } from "abilitybench";

const inventory = defineStage({
  id: "inventory",
  dependsOn: [],
  inputs: { records: input.stringArray("/records") },
  cache: cache.enabled({ revision: "inventory-v1", files: ["workflow.ts"], environment: [] }),
  run: ({ inputs }) => ({ records: inputs.records }),
});
const evidence = defineStage({
  id: "evidence",
  dependsOn: [inventory],
  inputs: { trusted: input.stringArray("/trusted") },
  cache: cache.enabled({ revision: "evidence-v1", files: ["workflow.ts"], environment: [] }),
  run: ({ dependencies, inputs }) => ({
    records: dependencies.inventory.records.filter((id) => inputs.trusted.includes(id)),
  }),
});
const feasibility = defineStage({
  id: "feasibility",
  dependsOn: [inventory],
  inputs: { eligible: input.stringArray("/eligible") },
  cache: cache.enabled({ revision: "feasibility-v1", files: ["workflow.ts"], environment: [] }),
  run: ({ dependencies, inputs }) => ({
    records: dependencies.inventory.records.filter((id) => inputs.eligible.includes(id)),
  }),
});
const report = defineStage({
  id: "report",
  dependsOn: [evidence, feasibility],
  inputs: {},
  cache: cache.enabled({ revision: "report-v1", files: ["workflow.ts"], environment: [] }),
  run: ({ dependencies }) => ({
    candidates: dependencies.feasibility.records.filter((id) =>
      dependencies.evidence.records.includes(id),
    ),
  }),
});
export default createWorkflow({
  id: "evaluation-regression",
  root: import.meta.dirname,
  stages: [inventory, evidence, feasibility, report],
});
