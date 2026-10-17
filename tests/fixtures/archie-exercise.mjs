import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  decodeArtifact,
  evaluateRunPair,
  FileArtifactStore,
  runWorkflow,
} from "../../dist/index.js";

const [scenario, root] = process.argv.slice(2);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const headings = [
  "# Architecture",
  "## What This Project Does",
  "## Tech Stack",
  "## Project Structure",
  "## Core Flows",
  "## Key Decisions and Tradeoffs",
  "## Known Gaps and Limitations",
];
const input = {
  userConfig: null,
  identityFiles: [{ path: "package.json", content: '{"name":"fixture"}' }],
  treeString: "src/index.ts",
  sourceFiles: [{ path: "src/index.ts", content: "export const value=1;" }],
  gitHistory: [],
};
await mkdir(join(root, "upstream/core"), { recursive: true });
await writeFile(join(root, "package.json"), '{"type":"module"}');
for (const [key, value] of Object.entries(input))
  await writeFile(join(root, `${key}.json`), JSON.stringify(value));
await writeFile(
  join(root, "upstream/core/gemini.js"),
  "// Fixture acquisition implementation identity; never executed.\n",
);
await writeFile(
  join(root, "upstream/core/writer.js"),
  'import {writeFile} from "node:fs/promises"; import {join} from "node:path"; export async function writeArchitecture(root,content){await writeFile(join(root,"ARCHITECTURE.md"),content);}',
);
const workflow = (
  await readFile(new URL("../../examples/archie-offline/workflow.mjs", import.meta.url), "utf8")
).replaceAll(
  '"../../dist/index.js"',
  JSON.stringify(new URL("../../dist/index.js", import.meta.url).href),
);
await writeFile(join(root, "workflow.mjs"), workflow);
await writeFile(
  join(root, "evaluation-policy.json"),
  JSON.stringify({ requiredHeadings: headings }),
);
let markdown = headings.join("\nDocumented existing contract.\n");
const capture = {
  version: 1,
  mode: "mocked-existing-agent",
  inputSha256: sha(JSON.stringify(input)),
  architectureSha256: sha(markdown),
  generationModuleSha256: sha(await readFile(join(root, "upstream/core/gemini.js"))),
};
await writeFile(join(root, "architecture.md"), markdown);
await writeFile(join(root, "capture.json"), JSON.stringify(capture));
globalThis.fetch = async () => {
  throw new Error("Network forbidden");
};
const { build, evaluation } = await import(pathToFileURL(join(root, "workflow.mjs")).href);
const options = { inputs: { snapshotReadRevision: "snapshot-v1", publish: false }, baseline: null };
const baseline = await runWorkflow(build(root), options);
const baselinePath = join(baseline.storageDir, "runs", `${baseline.manifest.id}.json`);
const before = await readFile(baselinePath, "utf8");
const candidateOptions = { ...options, baseline: { runId: baseline.manifest.id } };
if (scenario === "writer-change")
  await writeFile(
    join(root, "upstream/core/writer.js"),
    (await readFile(join(root, "upstream/core/writer.js"), "utf8")) +
      "\n// Downstream implementation revision.\n",
  );
if (scenario === "source-change")
  await writeFile(
    join(root, "sourceFiles.json"),
    JSON.stringify([{ path: "src/index.ts", content: "export const value=2;" }]),
  );
if (scenario === "prompt-change")
  await writeFile(join(root, "upstream/core/gemini.js"), "// Changed prompt implementation\n");
if (scenario === "manual") candidateOptions.invalidate = ["architecture"];
if (scenario === "typed-input") candidateOptions.inputs.publish = "yes";
if (scenario === "corrupt-capture") await writeFile(join(root, "architecture.md"), "corrupt");
if (scenario === "corrupt-artifact") {
  const record = baseline.manifest.stages.find((s) => s.stageId === "architecture");
  await writeFile(
    join(baseline.storageDir, "objects/sha256", record.outputArtifactHash.slice(7)),
    "corrupt",
  );
}
if (scenario === "quality-regression") {
  markdown = markdown.replace("## Tech Stack", "## Missing Tech Stack");
  await writeFile(join(root, "architecture.md"), markdown);
  await writeFile(
    join(root, "capture.json"),
    JSON.stringify({ ...capture, architectureSha256: sha(markdown) }),
  );
}
if (scenario === "evaluation-change")
  await writeFile(
    join(root, "evaluation-policy.json"),
    JSON.stringify({ requiredHeadings: [...headings, "## New required section"] }),
  );
if (["publish", "publish-failure"].includes(scenario)) {
  candidateOptions.inputs.publish = true;
  candidateOptions.environment = {
    ARCHIE_EXAMPLE_OUTPUT: scenario === "publish" ? join(root, "published") : root,
  };
}
let candidate;
let receipt;
let rejected = null;
try {
  candidate = await runWorkflow(build(root), candidateOptions);
  if (candidate.manifest.executionStatus === "completed")
    receipt = await evaluateRunPair(evaluation(root), {
      baselineRunId: baseline.manifest.id,
      candidateRunId: candidate.manifest.id,
      criteria: {},
    });
} catch (error) {
  rejected = error.code ?? error.name;
}
let outputMatches = null;
if (scenario === "publish") {
  const record = baseline.manifest.stages.find((s) => s.stageId === "architecture");
  const artifact = await new FileArtifactStore(baseline.storageDir).get(record.outputArtifactHash);
  outputMatches =
    (await readFile(join(root, "published/ARCHITECTURE.md"), "utf8")) ===
    decodeArtifact(artifact).markdown;
}
assert.equal(await readFile(baselinePath, "utf8"), before);
process.stdout.write(
  JSON.stringify({
    baseline: baseline.manifest,
    candidate: candidate?.manifest,
    receipt,
    rejected,
    outputMatches,
    baselineUnchanged: true,
    providerCalls: 0,
  }),
);
