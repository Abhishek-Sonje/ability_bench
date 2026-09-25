import { createWorkflow, defineStage, type JsonValue } from "abilitybench";

function stringArray(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${label} must be an array of strings.`);
  }
  return value;
}

function boolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean.`);
  return value;
}

function number(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number") throw new TypeError(`${label} must be a number.`);
  return value;
}

const inventory = defineStage({
  id: "inventory",
  dependsOn: [],
  implementation: "inventory-v1",
  watch: ["workflow.ts"],
  inputs: ["/packages"],
  env: [],
  cache: true,
  run: ({ inputs }) => {
    const packages = stringArray(inputs["/packages"], "packages");
    return { packageCount: packages.length, packages };
  },
});

const unitTests = defineStage({
  id: "unit-tests",
  dependsOn: [inventory],
  implementation: "unit-tests-v1",
  watch: ["workflow.ts"],
  inputs: ["/signals/testsPassed"],
  env: [],
  cache: true,
  run: ({ dependencies, inputs }) => ({
    packageCount: dependencies.inventory.packageCount,
    passed: boolean(inputs["/signals/testsPassed"], "testsPassed"),
  }),
});

const security = defineStage({
  id: "security",
  dependsOn: [inventory],
  implementation: "security-v1",
  watch: ["workflow.ts"],
  inputs: ["/signals/criticalVulnerabilities"],
  env: [],
  cache: true,
  run: ({ dependencies, inputs }) => {
    const critical = number(inputs["/signals/criticalVulnerabilities"], "criticalVulnerabilities");
    return {
      critical,
      packageCount: dependencies.inventory.packageCount,
      passed: critical === 0,
    };
  },
});

const documentation = defineStage({
  id: "documentation",
  dependsOn: [],
  implementation: "documentation-v1",
  watch: ["workflow.ts"],
  inputs: ["/signals/docsCurrent"],
  env: [],
  cache: true,
  run: ({ inputs }) => ({
    passed: boolean(inputs["/signals/docsCurrent"], "docsCurrent"),
  }),
});

const summary = defineStage({
  id: "summary",
  dependsOn: [documentation, security, unitTests],
  implementation: "summary-v1",
  watch: ["workflow.ts"],
  inputs: [],
  env: [],
  cache: true,
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
  implementation: "report-v1",
  watch: ["workflow.ts"],
  inputs: [],
  env: [],
  cache: true,
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
