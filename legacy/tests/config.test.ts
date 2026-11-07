import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadWorkflowConfig } from "../src/index.js";

const fixture = join(
  process.cwd(),
  "tests",
  "fixtures",
  "loaded-workflow",
  "abilitybench.config.ts",
);

describe("workflow config loading", () => {
  it("loads a sealed TypeScript workflow relative to its config", async () => {
    const loaded = await loadWorkflowConfig(fixture);
    expect(loaded.workflow.id).toBe("loaded-fixture");
    expect(loaded.workflow.topologicalOrder).toEqual(["source"]);
    expect(loaded.storageDir).toBe(
      join(process.cwd(), "tests", "fixtures", "loaded-workflow", ".abilitybench"),
    );
  });

  it("reports missing configuration before loading a workflow", async () => {
    await expect(
      loadWorkflowConfig(join(process.cwd(), "missing.config.ts")),
    ).rejects.toMatchObject({
      code: "config_not_found",
    });
  });
});
