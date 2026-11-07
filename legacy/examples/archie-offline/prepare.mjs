import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { configureReply, recordedRequests } from "./mock-sdk.mjs";

export const sha = (text) => createHash("sha256").update(text).digest("hex");
const [sourceArg, outputArg] = process.argv.slice(2);
assert(
  sourceArg && outputArg,
  "Usage: prepare.mjs <existing-archie-checkout> <isolated-output-parent>",
);
const source = await realpath(resolve(sourceArg));
const output = resolve(outputArg);
const outside = (target) => {
  const remainder = relative(source, target);
  return remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder);
};
assert(outside(output), "Do not prepare inside the agent checkout.");
assert(
  outside(await realpath(dirname(output))),
  "Output parent must exist outside the agent checkout.",
);
await mkdir(output, { recursive: true });
const physicalOutput = await realpath(output);
assert(outside(physicalOutput), "Do not prepare inside the agent checkout.");
const root = await mkdtemp(join(physicalOutput, "archie-"));
const paths = [
  "core/gemini",
  "core/writer",
  "core/fileReader",
  "core/dependencyGraph",
  "core/gitReader",
  "utils/config",
];
const sourceHashes = [];
await mkdir(join(root, "upstream/core"), { recursive: true });
await mkdir(join(root, "upstream/utils"), { recursive: true });
await writeFile(join(root, "package.json"), '{"type":"module"}', { flag: "wx" });
for (const name of paths) {
  const bytes = await readFile(join(source, "src", `${name}.ts`), "utf8");
  sourceHashes.push([`src/${name}.ts`, sha(bytes)]);
  await writeFile(join(root, "upstream", `${name}.js`), stripTypeScriptTypes(bytes), {
    flag: "wx",
  });
}
const gitPackage = JSON.parse(
  await readFile(join(source, "node_modules/simple-git/package.json"), "utf8"),
);
const simpleGitPath = pathToFileURL(
  join(source, "node_modules/simple-git", gitPackage.exports["."].import),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@google/generative-ai")
      return next(new URL("./mock-sdk.mjs", import.meta.url).href, context);
    if (specifier === "simple-git") return next(simpleGitPath, context);
    return next(specifier, context);
  },
});
// Never load the ordinary CLI, dotenv, hook installer, or .git/archie writer.
globalThis.fetch = async () => {
  throw new Error("Network disabled: offline Archie exercise.");
};
const module = (name) => import(pathToFileURL(join(root, "upstream", `${name}.js`)).href);
const [reader, history, config, agent] = await Promise.all([
  module("core/fileReader"),
  module("core/gitReader"),
  module("utils/config"),
  module("core/gemini"),
]);
const input = {
  userConfig: (await config.readConfigFile(source))?.raw ?? null,
  identityFiles: await reader.readProjectIdentityFiles(source),
  treeString: await reader.getStructurePromptBlock(source),
  sourceFiles: await reader.readAllSourceFiles(source),
  gitHistory: await history.getRecentHistory(source),
};
assert(input.sourceFiles.length > 0, "Use a real populated source checkout.");
const retained = await readFile(join(source, "ARCHITECTURE.md"), "utf8");
configureReply(retained);
const previousKey = process.env.GEMINI_API_KEY;
const previousLog = console.log;
let architecture;
try {
  process.env.GEMINI_API_KEY = "archie-offline-fake-key";
  console.log = () => {};
  architecture = await agent.generateArchitecture(input);
} finally {
  console.log = previousLog;
  if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = previousKey;
}
assert(architecture === retained.trim(), "Original response normalization changed.");
const calls = recordedRequests();
assert(calls.length === 1 && calls[0].settings.model === "gemini-2.5-flash");
const capture = {
  version: 1,
  mode: "mocked-existing-agent",
  inputSha256: sha(JSON.stringify(input)),
  architectureSha256: sha(architecture),
  promptSha256: sha(calls[0].prompt),
  generationModuleSha256: sha(await readFile(join(root, "upstream/core/gemini.js"))),
  acquisition: { mockedCalls: 1, realCalls: 0 },
  modelSettings: calls[0].settings,
  mockImplementationSha256: sha(await readFile(new URL("./mock-sdk.mjs", import.meta.url))),
  acquisitionImplementationSha256: sha(await readFile(new URL(import.meta.url))),
  sourceHashes,
  sourceHead: await history.getCurrentHash(source),
  provenance:
    "Working-tree snapshot, not necessarily clean HEAD. Retained output is a response fixture, not a new generation or proven current documentation.",
};
for (const [key, value] of Object.entries(input)) {
  await writeFile(join(root, `${key}.json`), JSON.stringify(value), { flag: "wx" });
}
await writeFile(join(root, "architecture.md"), architecture, { flag: "wx" });
await writeFile(join(root, "capture.json"), JSON.stringify(capture), { flag: "wx" });
await writeFile(
  join(root, "evaluation-policy.json"),
  JSON.stringify({
    requiredHeadings: [
      "# Architecture",
      "## What This Project Does",
      "## Tech Stack",
      "## Project Structure",
      "## Core Flows",
      "## Key Decisions and Tradeoffs",
      "## Known Gaps and Limitations",
    ],
  }),
  { flag: "wx" },
);
for (const name of ["workflow.mjs", "run.mjs"]) {
  const text = await readFile(new URL(`./${name}`, import.meta.url), "utf8");
  // Bind the example to the public SDK entry, never internal modules or a provider registry.
  const sdk = new URL("../../dist/index.js", import.meta.url).href;
  await writeFile(join(root, name), text.replaceAll('"../../dist/index.js"', JSON.stringify(sdk)), {
    flag: "wx",
  });
}
process.stdout.write(
  `${JSON.stringify({ root, acquisition: capture.acquisition, sourceFiles: input.sourceFiles.length, historyRecords: input.gitHistory.length, sourceHashes: sourceHashes.length })}\n`,
);
