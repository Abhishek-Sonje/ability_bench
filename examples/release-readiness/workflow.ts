import { defineWorkflow, type JsonObject, type JsonValue } from "abilitybench";

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

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

function dependency(
  values: Readonly<Record<string, JsonValue>>,
  id: string,
): JsonValue | undefined {
  return values[id];
}

function property(value: JsonValue | undefined, key: string, label: string): JsonValue | undefined {
  return object(value, label)[key];
}

export default defineWorkflow({ id: "release-readiness", root: import.meta.dirname })
  .stage({
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
  })
  .stage({
    id: "unit-tests",
    dependsOn: ["inventory"],
    implementation: "unit-tests-v1",
    watch: ["workflow.ts"],
    inputs: ["/signals/testsPassed"],
    env: [],
    cache: true,
    run: ({ dependencies, inputs }) => ({
      packageCount: number(
        property(dependency(dependencies, "inventory"), "packageCount", "inventory"),
        "packageCount",
      ),
      passed: boolean(inputs["/signals/testsPassed"], "testsPassed"),
    }),
  })
  .stage({
    id: "security",
    dependsOn: ["inventory"],
    implementation: "security-v1",
    watch: ["workflow.ts"],
    inputs: ["/signals/criticalVulnerabilities"],
    env: [],
    cache: true,
    run: ({ dependencies, inputs }) => {
      const critical = number(
        inputs["/signals/criticalVulnerabilities"],
        "criticalVulnerabilities",
      );
      return {
        critical,
        packageCount: number(
          property(dependency(dependencies, "inventory"), "packageCount", "inventory"),
          "packageCount",
        ),
        passed: critical === 0,
      };
    },
  })
  .stage({
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
  })
  .stage({
    id: "summary",
    dependsOn: ["documentation", "security", "unit-tests"],
    implementation: "summary-v1",
    watch: ["workflow.ts"],
    inputs: [],
    env: [],
    cache: true,
    run: ({ dependencies }) => {
      const checks = ["documentation", "security", "unit-tests"].map((id) => ({
        id,
        passed: boolean(property(dependency(dependencies, id), "passed", id), `${id}.passed`),
      }));
      return { checks, ready: checks.every(({ passed }) => passed) };
    },
  })
  .stage({
    id: "report",
    dependsOn: ["summary"],
    implementation: "report-v1",
    watch: ["workflow.ts"],
    inputs: [],
    env: [],
    cache: true,
    run: ({ dependencies }) => {
      const ready = boolean(
        property(dependency(dependencies, "summary"), "ready", "summary"),
        "summary.ready",
      );
      return { message: ready ? "Release is ready." : "Release is blocked.", ready };
    },
  })
  .build();
