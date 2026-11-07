import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readCapture } from "../composio-capture/capture.mjs";

// A deliberately explicit example-specific source boundary, not engine dependency discovery.
export const SOURCE_FILES = [
  "agent/result-schema.ts",
  "agent/research-agent.ts",
  "pipeline/batch-research.ts",
  "pipeline/save-result.ts",
  "data/assessment-categories.ts",
  "analysis.ts",
];
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function treeHashes(root, prefix = "") {
  const rows = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    assert(!entry.isSymbolicLink(), `Symbolic links are not supported in snapshot trees: ${name}`);
    if (entry.isDirectory()) rows.push(...(await treeHashes(root, name)));
    else rows.push([name.replaceAll("\\", "/"), sha256(await readFile(join(root, name)))]);
  }
  return rows.sort(([a], [b]) => a.localeCompare(b));
}

function outside(root, target) {
  const remainder = relative(root, target);
  return remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder);
}

export async function prepareProject(source, resultFile, outputParent, options = {}) {
  source = await realpath(resolve(source));
  outputParent = resolve(outputParent);
  assert(outside(source, outputParent), "Adapter output must be outside the original project.");
  let ancestor = outputParent;
  while (true) {
    try {
      assert(outside(source, await realpath(ancestor)), "Output aliases the original project.");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  assert(/^[a-z0-9-]+\.json$/.test(resultFile), "Choose one per-app result filename, not a path.");
  assert(!["analysis.json", "research-dataset.json", "run-manifest.json"].includes(resultFile));
  const resultPath = await realpath(join(source, "results", resultFile));
  assert(!outside(source, resultPath), "Result escapes the source project.");
  let resultBytes = await readFile(resultPath);
  let captured = null;
  if (options.capturePackage) {
    captured = await readCapture(resolve(options.capturePackage));
    assert(
      captured.manifest.status === "completed" && captured.result,
      "Only completed, explicitly exported captures can be adopted.",
    );
    const hashes = captured.manifest.sourceHashes;
    const required = [
      ...SOURCE_FILES.map((file) => `src/${file}`),
      "src/agent/gemini-model.ts",
      "src/agent/prompt.ts",
      "src/agent/evidence-mapping.ts",
    ];
    assert(
      Array.isArray(hashes) && required.every((file) => hashes.some(([name]) => name === file)),
      "Capture lacks source provenance.",
    );
    for (const [file, hash] of hashes) {
      assert(
        /^src\/[a-zA-Z0-9/_.-]+\.ts$/.test(file) && !file.includes(".."),
        "Unsafe source provenance.",
      );
      assert(
        sha256(await readFile(join(source, file))) === hash,
        "Captured and selected source implementations differ.",
      );
    }
    assert(
      captured.result.app === JSON.parse(resultBytes).app,
      "Captured target differs from selected saved target.",
    );
    resultBytes = Buffer.from(JSON.stringify(captured.result));
  }
  const contextPath = await realpath(join(source, "results/research-dataset.json"));
  assert(!outside(source, contextPath), "Dataset context escapes the source project.");
  const contextBytes = await readFile(contextPath);
  const target = JSON.parse(resultBytes).app;
  assert(typeof target === "string" && target.length > 0, "Saved result requires an app name.");
  await mkdir(outputParent, { recursive: true });
  const root = await realpath(await mkdtemp(join(outputParent, "integration-")));
  await mkdir(join(root, "capture"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "capture/result.json"), resultBytes);
  await writeFile(join(root, "capture/dataset-context.json"), contextBytes);
  const upstreamHashes = [];
  for (const file of SOURCE_FILES) {
    const original = await readFile(join(source, "src", file), "utf8");
    upstreamHashes.push([`src/${file}`, sha256(original)]);
    const destination = join(root, "upstream", file.replace(/\.ts$/, ".js"));
    await mkdir(dirname(destination), { recursive: true });
    // Native Node type erasure; no upstream build, rewrites, or emitted source-project files.
    await writeFile(destination, stripTypeScriptTypes(original));
  }
  const require = createRequire(join(source, "package.json"));
  const zod = dirname(require.resolve("zod/package.json"));
  await cp(zod, join(root, "node_modules/zod"), { recursive: true, dereference: true });
  const dependencyHashes = await treeHashes(join(root, "node_modules/zod"));
  await writeFile(
    join(root, "dependency-files.json"),
    JSON.stringify(dependencyHashes.map(([file]) => `node_modules/zod/${file}`)),
  );
  await writeFile(
    join(root, "capture/provenance.json"),
    JSON.stringify(
      {
        version: 1,
        target,
        filename: resultFile,
        resultSha256: sha256(resultBytes),
        contextSha256: sha256(contextBytes),
        upstreamHashes,
        dependencyTreeSha256: sha256(JSON.stringify(dependencyHashes)),
        importedAt: new Date().toISOString(),
        acquisitionTime: captured?.manifest.completedAt ?? null,
        modelSettings: captured?.manifest.modelSettings ?? null,
        observations: null,
        origin: captured ? "mock-capture" : "historical-saved-result",
        captureManifestSha256: captured?.manifestSha256 ?? null,
        note: captured
          ? "Explicitly approved mock-capture export, not live research. Model settings and acquisition metadata describe the mock execution. Raw observations were intentionally not exported; approved source URLs remain in the result. Dataset context is unchanged historical research."
          : "Existing saved result; original model settings, acquisition time, and raw observations are unavailable. Evidence URLs remain in the original result; this is not a fresh web observation.",
      },
      null,
      2,
    ),
  );
  if (captured)
    await writeFile(join(root, "capture/research-capture.json"), JSON.stringify(captured.manifest));
  const sdkUrl = new URL("../../dist/index.js", import.meta.url).href;
  for (const name of ["workflow.mjs", "evaluation.mjs"]) {
    const text = await readFile(new URL(name, import.meta.url), "utf8");
    await writeFile(
      join(root, name),
      text.replace('"../../dist/index.js"', JSON.stringify(sdkUrl)),
    );
  }
  await writeFile(join(root, "report-style.json"), '{"title":null}');
  await writeFile(
    join(root, "abilitybench.config.ts"),
    'export default { workflow: "./workflow.mjs", evaluation: "./evaluation.mjs" };',
  );
  await writeFile(
    join(root, "inputs.json"),
    JSON.stringify({ target, refresh: "saved-v1", publish: false }, null, 2),
  );
  return { root, target, resultSha256: sha256(resultBytes), upstreamHashes };
}

export async function openProject(root) {
  // Reopen in a new process after code changes: normal Node module caching still applies.
  const { build } = await import(pathToFileURL(join(root, "workflow.mjs")).href);
  return build(root);
}
