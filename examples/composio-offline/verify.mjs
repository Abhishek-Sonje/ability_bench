import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  decodeArtifact,
  diffRunManifests,
  evaluateRunPair,
  FileArtifactStore,
  FileRunManifestStore,
  planWorkflowRun,
  runWorkflow,
} from "../../dist/index.js";
import { openProject, prepareProject, sha256, treeHashes } from "./prepare.mjs";

const [sourceArg, resultFile = "salesforce.json", outputArg] = process.argv.slice(2);
assert(
  sourceArg && outputArg,
  "Usage: node examples/composio-offline/verify.mjs <source> <result.json> <output-parent>",
);
const source = resolve(sourceArg);
// Test evidence must not depend on a provider connection, even if credentials happen to exist.
let networkAttempts = 0;
const deny = () => {
  networkAttempts++;
  throw new Error("Offline verification forbids network/provider access.");
};
globalThis.fetch = deny;
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.startsWith("@google/") ||
      specifier.startsWith("@composio/") ||
      /^node:(?:https?|net|tls)$/.test(specifier)
    )
      return deny();
    return next(specifier, context);
  },
});
const originalPaths = ["src", "results", "package.json", "package-lock.json"].filter(Boolean);
const originals = async () => {
  const entries = [];
  for (const path of originalPaths) {
    try {
      if (path.includes(".")) entries.push([path, sha256(await readFile(join(source, path)))]);
      else
        entries.push(
          ...(await treeHashes(join(source, path))).map(([name, hash]) => [
            `${path}/${name}`,
            hash,
          ]),
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return entries;
};
const sourceBefore = await originals();
const project = await prepareProject(source, resultFile, resolve(outputArg));
const { root } = project;
const workflow = await openProject(root);
const { createCombinedDataset } = await import(
  pathToFileURL(join(root, "upstream/pipeline/batch-research.js")).href
);
const { analyzeDataset, renderReport } = await import(
  pathToFileURL(join(root, "upstream/analysis.js")).href
);
const inputs = { target: project.target, refresh: "saved-v1", publish: false };
const options = { inputs, baseline: null, environment: {} };
const artifacts = new FileArtifactStore(join(root, ".abilitybench"));
async function output(result, id) {
  const hash = result.manifest.stages.find(({ stageId }) => stageId === id).outputArtifactHash;
  assert(hash, `${id} has no output.`);
  return decodeArtifact(await artifacts.get(hash));
}
const outcomes = [];
const baseline = await runWorkflow(workflow, options);
assert.equal(baseline.manifest.executionStatus, "completed");
const selection = { runId: baseline.manifest.id };
const manifestPath = join(root, ".abilitybench/runs", `${selection.runId}.json`);
const baselineBytes = await readFile(manifestPath);
const baselineObjects = await treeHashes(join(root, ".abilitybench/objects"));
const baselineAnalysis = await output(baseline, "analyze");
const baselineDataset = await output(baseline, "assemble-dataset");
const policyFindings = (await output(baseline, "validate-result")).policyFindings;
const suite = (await import(pathToFileURL(join(root, "evaluation.mjs")).href)).default;
const evaluations = [];
async function record(name, result) {
  assert.equal(result.manifest.baselineRunId, name === "baseline" ? null : selection.runId);
  outcomes.push({
    name,
    manifest: result.manifest,
    plan: result.plan,
    diff: name === "baseline" ? null : diffRunManifests(baseline.manifest, result.manifest),
  });
  assert.deepEqual(await readFile(manifestPath), baselineBytes, "Baseline manifest changed.");
  for (const [name, hash] of baselineObjects)
    assert.equal(
      sha256(await readFile(join(root, ".abilitybench/objects", name))),
      hash,
      "Baseline artifact changed.",
    );
  console.log(
    `${name}: ${result.manifest.stages.map((s) => `${s.stageId}=${s.executionStatus}[${s.decisionReason}]`).join(", ")}`,
  );
}
const stage = (result, id) => result.manifest.stages.find(({ stageId }) => stageId === id);
async function candidate(name, overrides = {}) {
  const result = await runWorkflow(workflow, { ...options, baseline: selection, ...overrides });
  await record(name, result);
  return result;
}
await record("baseline", baseline);
assert.deepEqual((await readdir(root)).includes("published"), false);
// Original functions are the oracle, with only their fresh timestamps aligned for comparison.
const records = JSON.parse((await output(baseline, "validate-result")).recordsText);
const expectedDataset = createCombinedDataset(records);
expectedDataset.generatedAt = JSON.parse(baselineDataset.text).generatedAt;
assert.equal(baselineDataset.text, JSON.stringify(expectedDataset));
const expectedAnalysis = analyzeDataset(JSON.parse(baselineDataset.text));
expectedAnalysis.generatedAt = JSON.parse(baselineAnalysis.text).generatedAt;
assert.equal(
  baselineAnalysis.text,
  JSON.stringify(expectedAnalysis),
  "Analysis values/order differ.",
);
assert.equal(
  (await output(baseline, "render-report")).markdown,
  renderReport(JSON.parse(baselineAnalysis.text)),
);
const beforePlan = await treeHashes(root);
const planned = await planWorkflowRun(workflow, {
  ...options,
  baseline: selection,
  environment: { ABILITYBENCH_SITE_OUTPUT_DIRECTORY: join(source, "site/data") },
});
assert.deepEqual(await treeHashes(root), beforePlan, "Planning wrote files.");
assert.equal(planned.plan.decisions.filter(({ decision }) => decision === "reuse").length, 2);
const unchanged = await candidate("unchanged", {
  environment: { ABILITYBENCH_SITE_OUTPUT_DIRECTORY: join(source, "site/data") },
});
for (const id of ["load-capture", "validate-result"])
  assert.equal(stage(unchanged, id).executionStatus, "reused");
for (const id of ["assemble-dataset", "analyze"])
  assert.equal(stage(unchanged, id).decisionReason, "cache_disabled");
assert.equal(stage(unchanged, "render-report").decisionReason, "dependency_executed");
assert.equal((await output(unchanged, "verify-site-data")).mode, "disabled");
assert.equal(
  (await readdir(root)).includes("published"),
  false,
  "Disabled publication touched destinations.",
);
evaluations.push({
  name: "unchanged",
  receipt: await evaluateRunPair(suite, {
    baselineRunId: selection.runId,
    candidateRunId: unchanged.manifest.id,
    criteria: { analysisText: baselineAnalysis.text },
  }),
});

const stylePath = join(root, "report-style.json");
const styleBefore = await readFile(stylePath);
await writeFile(stylePath, JSON.stringify({ title: "Adapter report-only change" }));
const reportChanged = await candidate("report-only");
assert.equal(stage(reportChanged, "load-capture").executionStatus, "reused");
assert.equal(stage(reportChanged, "validate-result").executionStatus, "reused");
assert.equal(stage(reportChanged, "render-report").decisionReason, "dependency_executed");
assert.notEqual(
  stage(reportChanged, "render-report").componentHashes.watchedFiles,
  stage(baseline, "render-report").componentHashes.watchedFiles,
);
assert.equal(
  (await output(reportChanged, "render-report")).markdown,
  renderReport(JSON.parse((await output(reportChanged, "analyze")).text)).replace(
    /^# [^\r\n]+/,
    "# Adapter report-only change",
  ),
);
evaluations.push({
  name: "intentional-format-change",
  receipt: await evaluateRunPair(suite, {
    baselineRunId: selection.runId,
    candidateRunId: reportChanged.manifest.id,
    criteria: { analysisText: baselineAnalysis.text },
  }),
});
await writeFile(stylePath, styleBefore);
const manual = await candidate("manual-invalidation", { invalidate: ["load-capture"] });
assert.equal(stage(manual, "load-capture").decisionReason, "manual_invalidation");
const refreshed = await candidate("refresh-selection", {
  inputs: { ...inputs, refresh: "explicit-selection-v2" },
});
assert.equal(stage(refreshed, "load-capture").decisionReason, "fingerprint_changed");
for (const file of ["upstream/agent/result-schema.js", "upstream/agent/research-agent.js"]) {
  const path = join(root, file);
  const before = await readFile(path);
  await writeFile(path, `${before}\n// Watched-boundary verification (no semantic change).\n`);
  const changed = await candidate(
    file.includes("result-schema") ? "watched-schema" : "watched-policy",
  );
  assert.equal(stage(changed, "load-capture").executionStatus, "reused");
  assert.equal(stage(changed, "validate-result").decisionReason, "fingerprint_changed");
  await writeFile(path, before);
}
const capturePath = join(root, "capture/result.json");
const provenancePath = join(root, "capture/provenance.json");
const captureBefore = await readFile(capturePath);
const provenanceBefore = await readFile(provenancePath);
const changedBytes = `${captureBefore}\n`;
await writeFile(capturePath, changedBytes);
await writeFile(
  provenancePath,
  JSON.stringify({ ...JSON.parse(provenanceBefore), resultSha256: sha256(changedBytes) }),
);
const captureChanged = await candidate("watched-capture");
assert.equal(stage(captureChanged, "load-capture").decisionReason, "fingerprint_changed");
assert.equal(stage(captureChanged, "validate-result").decisionReason, "dependency_executed");
await writeFile(capturePath, captureBefore);
await writeFile(provenancePath, provenanceBefore);
// Corruption probes use a separate copy; original baseline objects are never damaged or repaired.
await cp(join(root, ".abilitybench"), join(root, "corruption-history"), { recursive: true });
const corruptedHash = stage(baseline, "load-capture").outputArtifactHash;
const corruptPath = join(root, "corruption-history/objects/sha256", corruptedHash.slice(7));
await writeFile(corruptPath, "corrupt artifact");
const corruptPlan = await planWorkflowRun(workflow, {
  ...options,
  baseline: selection,
  storageDir: "corruption-history",
});
assert.equal(
  corruptPlan.plan.decisions.find(({ stageId }) => stageId === "load-capture").reason,
  "baseline_artifact_unavailable",
);
const corruptRun = await runWorkflow(workflow, {
  ...options,
  baseline: selection,
  storageDir: "corruption-history",
});
assert.equal(stage(corruptRun, "load-capture").executionStatus, "failed");
assert.equal(corruptRun.manifest.executionStatus, "failed");
await record("corrupt-artifact-copy", corruptRun);
await cp(join(root, ".abilitybench"), join(root, "missing-history"), { recursive: true });
await rm(join(root, "missing-history/objects/sha256", corruptedHash.slice(7)));
const missing = await runWorkflow(workflow, {
  ...options,
  baseline: selection,
  storageDir: "missing-history",
});
assert.equal(stage(missing, "load-capture").decisionReason, "baseline_artifact_unavailable");
assert.equal(missing.manifest.executionStatus, "completed");
await record("missing-artifact-recomputed", missing);

const site = join(root, "published/site-a");
const publication = {
  inputs: { ...inputs, publish: true },
  environment: { ABILITYBENCH_SITE_OUTPUT_DIRECTORY: site },
};
const published = await candidate("opt-in-publication", publication);
assert.equal((await output(published, "verify-site-data")).mode, "verified");
for (const [filename, id] of [
  ["research-dataset.json", "assemble-dataset"],
  ["analysis.json", "analyze"],
]) {
  const text = (await output(published, id)).text;
  assert.equal(
    await readFile(join(site, filename), "utf8"),
    `${JSON.stringify(JSON.parse(text), null, 2)}\n`,
  );
}
await rm(join(site, "research-dataset.json"));
const repaired = await candidate("missing-publication-restored", publication);
assert.equal((await output(repaired, "verify-site-data")).mode, "verified");
const siteB = join(root, "published/site-b");
const moved = await candidate("publication-environment-change", {
  ...publication,
  environment: { ABILITYBENCH_SITE_OUTPUT_DIRECTORY: siteB },
});
assert.notEqual(
  stage(published, "publish-dataset").componentHashes.environment,
  stage(moved, "publish-dataset").componentHashes.environment,
);
await rm(join(site, "research-dataset.json"));
await mkdir(join(site, "research-dataset.json"));
const failedCopy = await candidate("publication-failure", publication);
assert.equal(stage(failedCopy, "publish-dataset").executionStatus, "failed");
assert.equal(stage(failedCopy, "verify-site-data").executionStatus, "skipped_dependency_failed");
assert.equal(stage(failedCopy, "render-report").executionStatus, "skipped_run_stopped");
const escaped = await candidate("reject-original-destination", {
  ...publication,
  environment: { ABILITYBENCH_SITE_OUTPUT_DIRECTORY: join(source, "site/data") },
});
assert.equal(escaped.manifest.executionStatus, "failed");
await symlink(
  siteB,
  join(root, "published/alias"),
  process.platform === "win32" ? "junction" : "dir",
);
const alias = await candidate("reject-linked-destination", {
  ...publication,
  environment: { ABILITYBENCH_SITE_OUTPUT_DIRECTORY: join(root, "published/alias") },
});
assert.equal(alias.manifest.executionStatus, "failed");
// A schema-invalid captured result fails before downstream work; checksum still matches the fixture.
const invalid = JSON.parse(captureBefore);
delete invalid.confidence;
const invalidBytes = JSON.stringify(invalid);
await writeFile(capturePath, invalidBytes);
await writeFile(
  provenancePath,
  JSON.stringify({ ...JSON.parse(provenanceBefore), resultSha256: sha256(invalidBytes) }),
);
const invalidRun = await candidate("invalid-capture");
assert.equal(invalidRun.manifest.executionStatus, "failed");
assert.equal(stage(invalidRun, "validate-result").executionStatus, "failed");
await writeFile(capturePath, captureBefore);
await writeFile(provenancePath, provenanceBefore);
assert.deepEqual(await originals(), sourceBefore, "Original project files changed.");
assert.equal(networkAttempts, 0);
const manifests = await new FileRunManifestStore(join(root, ".abilitybench")).list();
const summary = {
  root,
  project,
  baselineRunId: selection.runId,
  baselineManifestSha256: sha256(baselineBytes),
  modelCalls: 0,
  composioCalls: 0,
  networkAttempts,
  originalFilesVerified: sourceBefore.length,
  originalSourceUnchanged: true,
  compatibility: {
    datasetOrderAndValues: true,
    analysisOrderAndValues: true,
    reportByteEquality: true,
    timestamps:
      "Only generatedAt aligned for oracle comparison; original clock reads remain non-cacheable.",
  },
  policyFindings,
  outcomes,
  evaluations,
  verifiedManifests: manifests.length,
};
await writeFile(join(root, "verification.json"), JSON.stringify(summary, null, 2));
console.log(`Offline integration verified. Evidence: ${join(root, "verification.json")}`);
