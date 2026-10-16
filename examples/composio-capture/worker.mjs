import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire, registerHooks, stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareProject, sha256 } from "../composio-offline/prepare.mjs";
import { captureResearch } from "./capture.mjs";
import { MOCK_POLICY, mockTransport } from "./mock-provider.mjs";

const [mode, sourceArg, outputArg, scenario = "success"] = process.argv.slice(2);
assert(
  mode === "mock" || mode === "normal-cli-mock",
  "Step 2 supports mock capture or normal-cli-mock only. No live mode.",
);
assert(sourceArg && outputArg, "Usage: worker.mjs mock <source> <output> [scenario]");
assert(
  [
    "success",
    "provider-retry",
    "malformed",
    "mapping-malformed",
    "action-correction",
    "tool-retry",
    "tool-failure",
    "timeout",
    "unknown-usage",
    "private-result",
  ].includes(scenario),
  "Unknown mocked scenario.",
);
const source = resolve(sourceArg);
const output = resolve(outputArg);
const project = await prepareProject(source, "salesforce.json", output);
const sourceHashes = [...project.upstreamHashes];
for (const file of [
  "agent/gemini.ts",
  "agent/gemini-model.ts",
  "agent/prompt.ts",
  "agent/evidence-mapping.ts",
  "agent/target-schema.ts",
  "tools/research-tools.ts",
  "config/env.ts",
  "index.ts",
]) {
  const text = await readFile(join(source, "src", file), "utf8");
  sourceHashes.push([`src/${file}`, sha256(text)]);
  const path = join(project.root, "upstream", file.replace(/\.ts$/, ".js"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stripTypeScriptTypes(text));
}
const require = createRequire(join(source, "package.json"));
const sdkVersions = {};
const sdkPaths = {};
for (const name of ["@google/genai", "@composio/core"]) {
  sdkPaths[name] = pathToFileURL(require.resolve(name)).href;
  sdkVersions[name] = JSON.parse(
    await readFile(join(source, "node_modules", name, "package.json")),
  ).version;
}
assert(
  sdkVersions["@google/genai"] === "2.23.0" && sdkVersions["@composio/core"] === "0.18.1",
  "Audit SDK transport behavior before using a different installed version.",
);
registerHooks({
  resolve(specifier, context, next) {
    return next(sdkPaths[specifier] ?? specifier, context);
  },
});
const provider = mockTransport(scenario);
const env = {
  GEMINI_API_KEY: "mock-gemini-credential",
  GEMINI_MODEL: "gemini-3.5-flash-lite",
  COMPOSIO_API_KEY: "mock-composio-credential",
  MAX_RESEARCH_STEPS: "2",
};
if (mode === "normal-cli-mock") {
  globalThis.fetch = provider.fetch;
  Object.assign(process.env, env);
  process.chdir(project.root);
  process.argv = [process.execPath, join(project.root, "upstream/index.js"), "Salesforce"];
  await import(pathToFileURL(join(project.root, "upstream/index.js")).href);
} else {
  const capture = await captureResearch({
    directory: join(output, "mock-budget"),
    policy: { ...MOCK_POLICY, ...(scenario === "timeout" ? { attemptTimeoutMs: 25 } : {}) },
    transport: provider.fetch,
    secrets: [env.GEMINI_API_KEY, env.COMPOSIO_API_KEY],
    approval: { allowPublicResult: true, allowedSourceOrigins: ["https://www.salesforce.com"] },
    metadata: {
      sourceHashes,
      sdkVersions,
      modelSettings: {
        model: env.GEMINI_MODEL,
        maxResearchSteps: 2,
        generation: "unchanged-agent-defaults",
      },
    },
    validateResult: (value) => {
      // The exact original agent already validated the same value; this is a separate export check.
      assert(value?.app === "Salesforce");
      return value;
    },
    execute: async (boundary) => {
      const module = (name) => import(pathToFileURL(join(project.root, "upstream", name)).href);
      const [
        { readConfig },
        { createGeminiClient },
        { createGeminiResearchModel },
        { createComposioResearchTools },
        { researchApp },
      ] = await Promise.all([
        module("config/env.js"),
        module("agent/gemini.js"),
        module("agent/gemini-model.js"),
        module("tools/research-tools.js"),
        module("agent/research-agent.js"),
      ]);
      const config = readConfig(env);
      const gemini = boundary.gemini(createGeminiClient(config));
      const model = createGeminiResearchModel(gemini);
      const tools = boundary.tools(
        await boundary.setup(() => createComposioResearchTools(config.composioApiKey)),
      );
      return researchApp(
        { name: "Salesforce" },
        { model, tools, maxSteps: config.maxResearchSteps, log: boundary.log },
      );
    },
  });
  const summary = JSON.stringify({
    directory: capture.directory,
    status: capture.manifest.status,
    failure: capture.manifest.failure,
    counts: capture.manifest.counts,
    actualNetworkRequests: 0,
    transport: "mock-only",
  });
  // This is a dedicated worker. Do not let an SDK background retry outlive its closed capture scope.
  for (const name of ["log", "warn", "error", "info", "debug", "trace"]) console[name] = () => {};
  process.stdout.write(`${summary}\n`, () =>
    process.exit(capture.manifest.status === "completed" ? 0 : 1),
  );
}
