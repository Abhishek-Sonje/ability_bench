import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decodeArtifact,
  diffRunManifests,
  FileArtifactStore,
  loadWorkflowConfig,
  planWorkflowRun,
  runWorkflow,
} from "../../dist/index.js";

const sourceRoot = resolve(process.argv[2] ?? "../composio-agent");
const exampleRoot = fileURLToPath(new URL("./", import.meta.url));
const schemaPath = join(sourceRoot, "src", "agent", "result-schema.ts");
const { appResearchResultSchema } = await import(pathToFileURL(schemaPath).href);
const sourceFiles = (await readdir(join(sourceRoot, "results")))
  .filter(
    (name) =>
      name.endsWith(".json") &&
      !["run-manifest.json", "research-dataset.json", "analysis.json"].includes(name),
  )
  .sort();
const captured = [];
const rejected = [];
for (const filename of sourceFiles) {
  const bytes = await readFile(join(sourceRoot, "results", filename));
  const parsed = appResearchResultSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  if (!parsed.success) {
    rejected.push({ filename, issues: parsed.error.issues });
    continue;
  }
  captured.push({
    filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    record: parsed.data,
  });
}
assert(captured.length > 0, "No schema-valid per-app research results found.");
assert.equal(
  new Set(captured.map(({ filename }) => filename)).size,
  captured.length,
  "Duplicate record identities.",
);
const inputs = {
  apps: captured.map(({ filename }) => filename),
  officialMentions: captured.flatMap(({ filename, record }) =>
    record.evidence.filter(({ sourceType }) => sourceType === "official").map(() => filename),
  ),
  feasibleApps: captured
    .filter(
      ({ record }) =>
        record.buildability === "buildable" &&
        record.blocker === null &&
        record.authMethods.length > 0 &&
        record.accessModel.startsWith("self_serve_") &&
        (record.apiSurface.rest === true ||
          record.apiSurface.graphql === true ||
          record.apiSurface.other.length > 0),
    )
    .map(({ filename }) => filename),
  highConfidenceApps: captured
    .filter(({ record }) => record.confidence === "high")
    .map(({ filename }) => filename),
  failReport: false,
};

const demoRoot = await mkdtemp(join(tmpdir(), "abilitybench-composio-"));
try {
  const sdkUrl = pathToFileURL(fileURLToPath(new URL("../../dist/index.js", import.meta.url))).href;
  const workflowSource = await readFile(new URL("./workflow.ts", import.meta.url), "utf8");
  await writeFile(
    join(demoRoot, "workflow.ts"),
    workflowSource.replace('from "abilitybench"', `from ${JSON.stringify(sdkUrl)}`),
  );
  await writeFile(
    join(demoRoot, "abilitybench.config.ts"),
    'export default { workflow: "./workflow.ts" };',
  );
  await writeFile(join(demoRoot, "evidence-policy.json"), '{"minimumOfficialSources":1}');
  const { workflow } = await loadWorkflowConfig(join(demoRoot, "abilitybench.config.ts"));
  const environment = { ABILITYBENCH_REQUIRE_HIGH_CONFIDENCE: "false" };
  const baseline = await runWorkflow(workflow, { inputs, baseline: null, environment });
  assert.equal(baseline.manifest.executionStatus, "completed");
  const baselineSelection = { runId: baseline.manifest.id };
  const plan = await planWorkflowRun(workflow, {
    inputs,
    baseline: baselineSelection,
    environment,
  });
  assert.equal(plan.plan.decisions.filter(({ decision }) => decision === "reuse").length, 5);
  assert.equal(
    plan.plan.decisions.find(({ stageId }) => stageId === "delivery").reason,
    "cache_disabled",
  );
  const outcomes = [];
  const artifacts = new FileArtifactStore(join(demoRoot, ".abilitybench"));
  const reportOutput = async (result) => {
    const hash = result.manifest.stages.find(
      ({ stageId }) => stageId === "report",
    ).outputArtifactHash;
    if (hash === null) return null;
    const artifact = await artifacts.get(hash);
    assert(artifact, "Report artifact must exist.");
    return decodeArtifact(artifact);
  };
  const record = async (scenario, result) => {
    outcomes.push({
      scenario,
      report: await reportOutput(result),
      manifest: result.manifest,
      diff: diffRunManifests(baseline.manifest, result.manifest),
    });
    console.log(
      `${scenario}: ${result.manifest.stages.map((stage) => `${stage.stageId}=${stage.finalDecision}(${stage.decisionReason})`).join(", ")}`,
    );
  };
  const candidate = async (options = {}) =>
    runWorkflow(workflow, { inputs, baseline: baselineSelection, environment, ...options });
  const unchanged = await candidate();
  assert.equal(
    unchanged.manifest.stages.filter(({ finalDecision }) => finalDecision === "reuse").length,
    5,
  );
  await record("unchanged", unchanged);
  await writeFile(join(demoRoot, "evidence-policy.json"), '{"minimumOfficialSources":2}');
  const fileChanged = await candidate();
  assert.equal(
    fileChanged.manifest.stages.find(({ stageId }) => stageId === "feasibility").finalDecision,
    "reuse",
  );
  assert.equal(
    fileChanged.manifest.stages.find(({ stageId }) => stageId === "evidence").decisionReason,
    "fingerprint_changed",
  );
  await record("watched-policy-change", fileChanged);
  await writeFile(join(demoRoot, "evidence-policy.json"), '{"minimumOfficialSources":1}');
  const envChanged = await candidate({
    environment: { ABILITYBENCH_REQUIRE_HIGH_CONFIDENCE: "true" },
  });
  assert.equal(
    envChanged.manifest.stages.find(({ stageId }) => stageId === "evidence").finalDecision,
    "reuse",
  );
  assert.equal(
    envChanged.manifest.stages.find(({ stageId }) => stageId === "feasibility").decisionReason,
    "fingerprint_changed",
  );
  await record("environment-change", envChanged);
  const manual = await candidate({ invalidate: ["evidence"] });
  assert.equal(
    manual.manifest.stages.find(({ stageId }) => stageId === "evidence").decisionReason,
    "manual_invalidation",
  );
  await record("manual-invalidation", manual);
  const failed = await candidate({ inputs: { ...inputs, failReport: true } });
  assert.equal(failed.manifest.executionStatus, "failed");
  assert.equal(
    failed.manifest.stages.find(({ stageId }) => stageId === "delivery").executionStatus,
    "skipped_dependency_failed",
  );
  await record("intentional-failure", failed);
  const persisted = JSON.parse(
    await readFile(join(demoRoot, ".abilitybench", "runs", `${baseline.manifest.id}.json`), "utf8"),
  );
  assert.deepEqual(persisted, baseline.manifest);
  const outputRoot = join(exampleRoot, ".abilitybench");
  await mkdir(outputRoot, { recursive: true });
  await writeFile(
    join(outputRoot, "demo-results.json"),
    `${JSON.stringify(
      {
        sourceRoot,
        capturedAt: new Date().toISOString(),
        schemaSha256: createHash("sha256")
          .update(await readFile(schemaPath))
          .digest("hex"),
        captured,
        rejected,
        inputs,
        baseline: baseline.manifest,
        baselineReport: await reportOutput(baseline),
        plan: plan.plan,
        outcomes,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Validated ${captured.length} captured research records. All scenario assertions passed.`,
  );
  console.log(`Review: ${join(outputRoot, "demo-results.json")}`);
} finally {
  await rm(demoRoot, { recursive: true, force: true });
}
