import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

assert.equal(
  process.argv.length,
  5,
  "Usage: node run.mjs <candidate.tgz> <composio-agent checkout> <npm-cli.js>",
);
const [tarball, composio, npm] = process.argv.slice(2).map((path) => resolve(path));
const witness = import.meta.dirname;
const legacy = resolve(witness, "../..");
const scratch = await mkdtemp(join(tmpdir(), "abilitybench provider witness "));
const consumer = join(scratch, "consumer");
const app = join(consumer, "app");
const history = join(scratch, "Gemini history");
const diagnostics = join(scratch, "diagnostics");
const publication = join(scratch, "current-run.txt");

function node(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: consumer,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

try {
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), '{"private":true,"type":"module"}');
  node([npm, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  const installed = join(consumer, "node_modules", "abilitybench");
  assert.equal(await realpath(installed), installed);
  assert.equal(
    JSON.parse(await readFile(join(installed, "package.json"), "utf8")).version,
    "0.1.0",
  );

  const geminiSource = join(legacy, "examples", "live-gemini");
  const gemini = join(app, "examples", "live-gemini");
  await mkdir(gemini, { recursive: true });
  await mkdir(join(app, "src"));
  await copyFile(join(witness, "workflow.mjs"), join(app, "workflow.mjs"));
  await copyFile(join(legacy, "src", "canonical-json.ts"), join(app, "src", "canonical-json.ts"));
  for (const file of ["provider.mjs", "grounding.mjs"]) {
    await copyFile(join(geminiSource, file), join(gemini, file));
  }
  const execution = JSON.parse(
    node([join(app, "workflow.mjs"), history, diagnostics, publication]),
  );
  await rm(app, { recursive: true });
  // The only application code copied to the independent reader is the original validator and its constants.
  await copyFile(join(geminiSource, "grounding.mjs"), join(consumer, "grounding.mjs"));
  await copyFile(join(witness, "inspect.mjs"), join(consumer, "inspect.mjs"));
  const inspection = JSON.parse(
    node([join(consumer, "inspect.mjs"), history, execution.a.runId, execution.b.runId, app]),
  );
  assert.deepEqual(inspection.original.stages, execution.a.stages);
  assert.deepEqual(inspection.changed.stages, execution.b.stages);

  const analysisFixture = join(composio, "results", "analysis.json");
  const rendererSources = [
    "analysis.ts",
    "agent/result-schema.ts",
    "data/assessment-categories.ts",
  ];
  const rendererHashes = {};
  for (const source of rendererSources) {
    const input = join(composio, "src", source);
    const output = join(consumer, "composio", source.replace(/\.ts$/, ".js"));
    await mkdir(dirname(output), { recursive: true });
    const bytes = await readFile(input);
    await writeFile(output, stripTypeScriptTypes(bytes.toString("utf8")));
    rendererHashes[source] = sha256(bytes);
  }
  const zod = join(composio, "node_modules", "zod");
  await cp(zod, join(consumer, "node_modules", "zod"), { recursive: true, dereference: true });
  const analysisBytes = await readFile(analysisFixture);
  await writeFile(join(consumer, "composio", "analysis.json"), analysisBytes);
  await copyFile(join(witness, "composio.mjs"), join(consumer, "composio.mjs"));
  const order = JSON.parse(
    node([join(consumer, "composio.mjs"), join(scratch, "Composio history")]),
  );
  console.log(
    JSON.stringify(
      {
        node: process.version,
        npm: node([npm, "--version"]).trim(),
        tarballSha256: sha256(await readFile(tarball)),
        fixtures: {
          composio: {
            analysisSha256: sha256(analysisBytes),
            rendererHashes,
            zod: JSON.parse(await readFile(join(zod, "package.json"), "utf8")).version,
          },
        },
        execution,
        inspection,
        order,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
