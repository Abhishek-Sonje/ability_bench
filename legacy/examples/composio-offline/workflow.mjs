import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { cache, canonicalizeJson, createWorkflow, defineStage, input } from "../../dist/index.js";
import { removeUnsupportedClaims } from "./upstream/agent/research-agent.js";
import { appResearchResultSchema } from "./upstream/agent/result-schema.js";
import { analyzeDataset, renderReport } from "./upstream/analysis.js";
import { createCombinedDataset } from "./upstream/pipeline/batch-research.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const outputEnv = "ABILITYBENCH_SITE_OUTPUT_DIRECTORY";
const dependencyFiles = JSON.parse(
  await readFile(new URL("./dependency-files.json", import.meta.url), "utf8"),
);
const schemaFiles = [
  "upstream/agent/result-schema.js",
  "dependency-files.json",
  ...dependencyFiles,
];
const analysisFiles = [
  "upstream/analysis.js",
  "upstream/data/assessment-categories.js",
  ...schemaFiles,
];
const policyFiles = ["upstream/agent/research-agent.js", ...schemaFiles];
const influences = (files, enabled = true, environment = []) =>
  (enabled ? cache.enabled : cache.disabled)({
    revision: "composio-offline-v1",
    files: ["workflow.mjs", ...files],
    environment,
  });

async function destination(root, value, create = false) {
  assert(typeof value === "string", `${outputEnv} is required only for opted-in publication.`);
  const name = basename(value);
  assert(/^[a-zA-Z0-9_-]+$/.test(name), "Use a simple isolated publication name.");
  const target = join(root, "published", name);
  assert(
    resolve(value) === target,
    "Publication must be an immediate child of this project's published directory.",
  );
  assert(
    (await realpath(root)) === root,
    "Project root aliases are not supported for publication.",
  );
  // Refuse symlinks/junctions at every mutable output component; never follow destination files.
  for (const path of [join(root, "published"), target]) {
    try {
      const info = await lstat(path);
      assert(info.isDirectory() && !info.isSymbolicLink(), "Unsafe publication directory.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      assert(create, "Publication directory is missing.");
      await mkdir(path);
    }
  }
  return target;
}

async function safeFile(path) {
  try {
    const info = await lstat(path);
    assert(info.isFile() && !info.isSymbolicLink(), "Unsafe publication file.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function build(root) {
  const load = defineStage({
    id: "load-capture",
    dependsOn: [],
    inputs: { target: input.string("/target"), refresh: input.string("/refresh") },
    cache: influences([
      "capture/result.json",
      "capture/dataset-context.json",
      "capture/provenance.json",
      "capture/research-capture.json",
    ]),
    run: async ({ inputs }) => {
      const text = await readFile(join(root, "capture/result.json"), "utf8");
      const provenance = JSON.parse(await readFile(join(root, "capture/provenance.json"), "utf8"));
      assert(
        provenance.version === 1 && provenance.target === inputs.target,
        "Capture target/provenance mismatch.",
      );
      assert(hash(text) === provenance.resultSha256, "Capture bytes disagree with provenance.");
      if (provenance.captureManifestSha256) {
        const captureText = await readFile(join(root, "capture/research-capture.json"), "utf8");
        assert(
          hash(captureText) === provenance.captureManifestSha256,
          "Capture manifest identity changed.",
        );
        const captured = JSON.parse(captureText);
        assert(
          captured.status === "completed" &&
            captured.mode === "mock-only" &&
            captured.exported === true &&
            captured.files.some(
              ([name, identity]) => name === "result.json" && identity === hash(text),
            ),
          "Capture result is not bound to its completed export.",
        );
      }
      const contextText = await readFile(join(root, "capture/dataset-context.json"), "utf8");
      assert(
        hash(contextText) === provenance.contextSha256,
        "Dataset context disagrees with provenance.",
      );
      assert(JSON.parse(text).app === inputs.target, "Result target mismatch.");
      return {
        text,
        contextText,
        provenanceText: JSON.stringify(provenance),
        refresh: inputs.refresh,
      };
    },
  });
  const validate = defineStage({
    id: "validate-result",
    dependsOn: [load],
    inputs: {},
    cache: influences(policyFiles),
    run: ({ dependencies }) => {
      const record = appResearchResultSchema.parse(JSON.parse(dependencies["load-capture"].text));
      assert(
        canonicalizeJson(removeUnsupportedClaims(record)) === canonicalizeJson(record),
        "Saved result fails the existing unsupported-claim policy; do not silently repair it.",
      );
      const context = JSON.parse(dependencies["load-capture"].contextText);
      assert(
        Array.isArray(context.records) && context.count === context.records.length,
        "Invalid dataset context count.",
      );
      let replacements = 0;
      const records = context.records.map((item) => {
        const parsed = appResearchResultSchema.parse(item);
        if (parsed.app.toLocaleLowerCase() !== record.app.toLocaleLowerCase()) return parsed;
        replacements++;
        return record;
      });
      assert(replacements === 1, "Selected target must occur exactly once in dataset context.");
      // Do not silently rewrite legacy context. Surface current policy differences as evaluation findings.
      const policyFindings = records
        .filter(
          (item) => canonicalizeJson(removeUnsupportedClaims(item)) !== canonicalizeJson(item),
        )
        .map((item) => item.app);
      return {
        text: JSON.stringify(record),
        recordsText: JSON.stringify(records),
        policyFindings,
        policy: "schema-and-existing-support-policy",
        freshness: "historical-snapshot",
      };
    },
  });
  const dataset = defineStage({
    id: "assemble-dataset",
    dependsOn: [validate],
    inputs: {},
    cache: influences(
      ["upstream/pipeline/batch-research.js", "upstream/pipeline/save-result.js", ...schemaFiles],
      false,
    ),
    run: ({ dependencies }) => ({
      text: JSON.stringify(
        createCombinedDataset(JSON.parse(dependencies["validate-result"].recordsText)),
      ),
    }),
  });
  const analyze = defineStage({
    id: "analyze",
    dependsOn: [dataset],
    inputs: {},
    cache: influences(analysisFiles, false),
    run: ({ dependencies }) => ({
      text: JSON.stringify(analyzeDataset(JSON.parse(dependencies["assemble-dataset"].text))),
    }),
  });
  const report = defineStage({
    id: "render-report",
    dependsOn: [analyze],
    inputs: {},
    cache: influences([...analysisFiles, "report-style.json"]),
    run: async ({ dependencies }) => {
      const analysis = JSON.parse(dependencies.analyze.text);
      const original = renderReport(analysis);
      const style = JSON.parse(await readFile(join(root, "report-style.json"), "utf8"));
      assert(Object.keys(style).length === 1 && "title" in style, "Invalid report style fields.");
      assert(
        style.title === null ||
          (typeof style.title === "string" &&
            style.title.length > 0 &&
            !/[\r\n]/.test(style.title)),
        "Invalid report title.",
      );
      return {
        markdown:
          style.title === null
            ? original
            : original.replace(/^# [^\r\n]+/, () => `# ${style.title}`),
      };
    },
  });
  const publisher = (id, dependency, filename) =>
    defineStage({
      id,
      dependsOn: [dependency],
      inputs: { publish: input.boolean("/publish") },
      cache: influences([], false, [outputEnv]),
      run: async ({ dependencies, inputs, env }) => {
        if (!inputs.publish) return { mode: "disabled", filename };
        const directory = await destination(root, env[outputEnv], true);
        const path = join(directory, filename);
        await safeFile(path);
        const text = `${JSON.stringify(JSON.parse(dependencies[dependency.id].text), null, 2)}\n`;
        await writeFile(path, text, "utf8");
        return { mode: "published", filename, directory, sha256: hash(text) };
      },
    });
  const publishDataset = publisher("publish-dataset", dataset, "research-dataset.json");
  const publishAnalysis = publisher("publish-analysis", analyze, "analysis.json");
  const verify = defineStage({
    id: "verify-site-data",
    dependsOn: [publishDataset, publishAnalysis],
    inputs: {},
    cache: influences([], false, [outputEnv]),
    run: async ({ dependencies, env }) => {
      const receipts = [dependencies["publish-dataset"], dependencies["publish-analysis"]];
      if (receipts.every(({ mode }) => mode === "disabled")) return { mode: "disabled" };
      assert(
        receipts.every(({ mode }) => mode === "published"),
        "Incomplete publication.",
      );
      const directory = await destination(root, env[outputEnv]);
      for (const receipt of receipts) {
        assert(receipt.directory === directory, "Publication destination mismatch.");
        const path = join(directory, receipt.filename);
        await safeFile(path);
        assert(
          hash(await readFile(path)) === receipt.sha256,
          "Published bytes differ from receipt.",
        );
      }
      return { mode: "verified", directory };
    },
  });
  return createWorkflow({
    id: "composio-offline-coarse-v1",
    root,
    stages: [load, validate, dataset, analyze, report, publishDataset, publishAnalysis, verify],
  });
}

export default build(import.meta.dirname);
