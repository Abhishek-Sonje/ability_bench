import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizeJson, defineWorkflow } from "../../dist/index.js";
import {
  EXAMPLE_VERSION,
  validateCatalog,
  validateStageInputs,
  validateStageOutput,
} from "./grounding.mjs";

import { outputFromSnapshot, requestBody, SETTINGS } from "./provider.mjs";

export {
  BUDGET_CAP_USD,
  Budget,
  createGeminiGenerator,
  digest,
  outputFromSnapshot,
  PRICING,
  PROTOCOL_CALLS,
  providerFailure,
  RETRY_POLICY,
  requestBody,
  requestReservation,
  retainedExposure,
  retryDelay,
  SETTINGS,
  usageFromResponse,
} from "./provider.mjs";

export const GRAPH = Object.freeze([
  ["catalog", []],
  ["facts", ["catalog"]],
  ["options", ["catalog", "facts"]],
  ["risks", ["catalog", "facts"]],
  ["report", ["catalog", "options", "risks"]],
  ["summary", ["catalog", "report"]],
]);
export async function buildWorkflow(root, toolMetrics) {
  const builder = defineWorkflow({ id: `live-gemini-${EXAMPLE_VERSION}`, root });
  for (const [id, dependencies] of GRAPH) {
    builder.stage({
      id,
      dependsOn: dependencies,
      implementation: `snapshot-${id}-${EXAMPLE_VERSION}`,
      inputs: [],
      env: [],
      cache: true,
      watch:
        id === "catalog"
          ? ["adapter.mjs", "grounding.mjs", "catalog.json"]
          : [
              "adapter.mjs",
              "provider.mjs",
              "canonical-json.ts",
              "grounding.mjs",
              "settings.json",
              `prompts/${id}.txt`,
              `snapshots/${id}.json`,
            ],
      run: async ({ dependencies: outputs }) => {
        if (id === "catalog") {
          const value = JSON.parse(await readFile(join(root, "catalog.json"), "utf8"));
          toolMetrics.localCatalogLookupCalls++;
          return validateCatalog(value);
        }
        const prompt = await readFile(join(root, "prompts", `${id}.txt`), "utf8");
        const snapshot = JSON.parse(await readFile(join(root, "snapshots", `${id}.json`), "utf8"));
        const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
        if (canonicalizeJson(settings) !== canonicalizeJson(SETTINGS))
          throw new Error("Loaded settings differ from declared request settings.");
        validateStageInputs(id, outputs);
        const output = outputFromSnapshot(snapshot, requestBody(prompt, outputs, id));
        validateStageOutput(id, output.text, outputs, prompt);
        return output;
      },
    });
  }
  return builder.build();
}
