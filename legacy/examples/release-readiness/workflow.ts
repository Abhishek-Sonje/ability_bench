import { cache, createWorkflow, defineStage, input } from "abilitybench";

const cached = (revision: string) =>
  cache.enabled({
    revision,
    files: ["workflow.ts"],
    environment: [],
  });

const inventory = defineStage({
  id: "inventory",
  dependsOn: [],
  inputs: { packages: input.stringArray("/packages") },
  cache: cached("inventory-v1"),
  run: ({ inputs }) => ({
    packageCount: inputs.packages.length,
    packages: inputs.packages,
  }),
});

const unitTests = defineStage({
  id: "unit-tests",
  dependsOn: [inventory],
  inputs: { testsPassed: input.boolean("/signals/testsPassed") },
  cache: cached("unit-tests-v1"),
  run: ({ dependencies, inputs }) => ({
    packageCount: dependencies.inventory.packageCount,
    passed: inputs.testsPassed,
  }),
});

const security = defineStage({
  id: "security",
  dependsOn: [inventory],
  inputs: {
    criticalVulnerabilities: input.number("/signals/criticalVulnerabilities"),
  },
  cache: cached("security-v1"),
  run: ({ dependencies, inputs }) => ({
    critical: inputs.criticalVulnerabilities,
    packageCount: dependencies.inventory.packageCount,
    passed: inputs.criticalVulnerabilities === 0,
  }),
});

const documentation = defineStage({
  id: "documentation",
  dependsOn: [],
  inputs: { docsCurrent: input.boolean("/signals/docsCurrent") },
  cache: cached("documentation-v1"),
  run: ({ inputs }) => ({ passed: inputs.docsCurrent }),
});

const summary = defineStage({
  id: "summary",
  dependsOn: [documentation, security, unitTests],
  inputs: {},
  cache: cached("summary-v1"),
  run: ({ dependencies }) => {
    const checks = [
      { id: "documentation", passed: dependencies.documentation.passed },
      { id: "security", passed: dependencies.security.passed },
      { id: "unit-tests", passed: dependencies["unit-tests"].passed },
    ];
    return { checks, ready: checks.every(({ passed }) => passed) };
  },
});

const report = defineStage({
  id: "report",
  dependsOn: [summary],
  inputs: {},
  cache: cached("report-v1"),
  run: ({ dependencies }) => {
    const { ready } = dependencies.summary;
    return { message: ready ? "Release is ready." : "Release is blocked.", ready };
  },
});

export default createWorkflow({
  id: "release-readiness",
  root: import.meta.dirname,
  stages: [inventory, unitTests, security, documentation, summary, report],
});
