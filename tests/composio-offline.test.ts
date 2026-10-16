import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaluationReceipt, FinalizedRunManifest, WorkflowPlan } from "../src/index.js";

interface Evidence {
  root: string;
  baselineRunId: string;
  modelCalls: number;
  composioCalls: number;
  networkAttempts: number;
  originalSourceUnchanged: boolean;
  compatibility: {
    datasetOrderAndValues: boolean;
    analysisOrderAndValues: boolean;
    reportByteEquality: boolean;
  };
  policyFindings: string[];
  outcomes: { name: string; manifest: FinalizedRunManifest; plan: WorkflowPlan }[];
  evaluations: { name: string; receipt: EvaluationReceipt }[];
}

let temporary: string;
let source: string;
let output: string;
let evidence: Evidence;
const entry = resolve("examples/composio-offline/run.mjs");

function invoke(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

async function put(path: string, text: string) {
  const directory = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
  await mkdir(directory, { recursive: true });
  await writeFile(path, text);
}

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "abilitybench coarse integration "));
  source = join(temporary, "source");
  output = join(temporary, "output");
  await put(join(source, "package.json"), '{"type":"module"}');
  // A small independent fixture for CI; the retained real-project exercise separately
  // uses the unmodified upstream Zod schema, evidence policy and 100-record analyzer.
  await put(
    join(source, "node_modules/zod/package.json"),
    '{"name":"zod","version":"fixture","type":"module","exports":{"./package.json":"./package.json"}}',
  );
  await put(
    join(source, "src/agent/result-schema.ts"),
    `export const appResearchResultSchema = { parse(value: any) {
    if (!value || typeof value.app !== "string" || !["high", "medium", "low"].includes(value.confidence)) throw Error("Invalid result schema");
    return structuredClone(value);
  } };`,
  );
  await put(
    join(source, "src/agent/research-agent.ts"),
    `export function removeUnsupportedClaims(value: any) {
    return value.authMethods.length && !value.evidence.length ? {...value, authMethods: []} : structuredClone(value);
  }`,
  );
  await put(join(source, "src/pipeline/save-result.ts"), "export const unused = true;");
  for (const name of ["gemini-model", "prompt", "evidence-mapping"])
    await put(join(source, `src/agent/${name}.ts`), "export const provenanceFixture = true;");
  await put(
    join(source, "src/data/assessment-categories.ts"),
    "export const categories = ['Z', 'A'];",
  );
  await put(
    join(source, "src/pipeline/batch-research.ts"),
    `import { appResearchResultSchema } from "../agent/result-schema.js";
  export function createCombinedDataset(values: any[]) {
    const records = values.map(value => appResearchResultSchema.parse(value));
    if (new Set(records.map(value => value.app.toLowerCase())).size !== records.length) throw Error("Duplicate app");
    return {generatedAt: new Date().toISOString(), count: records.length, records};
  }`,
  );
  await put(
    join(source, "src/analysis.ts"),
    `import { categories } from "./data/assessment-categories.js";
  export function analyzeDataset(dataset: any) { return {
    generatedAt: new Date().toISOString(), source: {datasetGeneratedAt: dataset.generatedAt},
    records: dataset.records, distribution: {Zulu: 1, Alpha: 1},
    buckets: Object.fromEntries(categories.map(name => [name, [dataset.records[0].app]]))
  }; }
  export function renderReport(analysis: any) { return '# Original report\\n' + Object.keys(analysis.distribution).join(',') + '\\n' + Object.keys(analysis.buckets).join(',') + '\\n'; }`,
  );
  const record = (app: string, supported = true) => ({
    app,
    confidence: "high",
    authMethods: ["OAuth"],
    evidence: supported ? [{ url: "https://example.com/docs", supports: ["authMethods"] }] : [],
  });
  const target = record("Salesforce");
  await put(join(source, "results/salesforce.json"), JSON.stringify(target));
  await put(
    join(source, "results/research-dataset.json"),
    JSON.stringify({
      generatedAt: "2026-10-01T00:00:00.000Z",
      count: 3,
      records: [record("Zulu", false), target, record("Alpha")],
    }),
  );
  const result = invoke(resolve("examples/composio-offline/verify.mjs"), [
    source,
    "salesforce.json",
    output,
  ]);
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const [name] = await readdir(output);
  assert(name);
  evidence = JSON.parse(
    await readFile(join(output, name, "verification.json"), "utf8"),
  ) as Evidence;
}, 120_000);

afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

function outcome(name: string) {
  const result = evidence.outcomes.find((row) => row.name === name);
  expect(result, name).toBeDefined();
  assert(result);
  return result;
}
function stage(name: string, id: string) {
  const result = outcome(name).manifest.stages.find((row) => row.stageId === id);
  assert(result);
  return result;
}

describe("offline coarse agent adapter", () => {
  it("adopts sealed mock capture evidence while retaining historical evaluation failures", async () => {
    const destination = join(temporary, "capture-adoption");
    const result = invoke(resolve("tests/fixtures/capture-exercise.mjs"), [
      "adopt",
      destination,
      source,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const captured = JSON.parse(result.stdout);
    expect(captured.adopted).toMatchObject({
      executionStatus: "completed",
      changedCaptureRejected: true,
      provenance: { origin: "mock-capture" },
      evaluation: { evaluationStatus: "failed", comparisonStatus: "no_regressions" },
    });
    expect(captured.adopted.provenance.captureManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(captured.adopted.provenance.acquisitionTime).not.toBeNull();
    expect(
      captured.adopted.stages
        .filter((stage: { executionStatus: string }) => stage.executionStatus === "reused")
        .map((stage: { stageId: string }) => stage.stageId),
    ).toEqual(["load-capture", "validate-result"]);
  });
  it("declares the whole branch/join DAG with explicit dependencies", () => {
    const rows = outcome("baseline").manifest.stages;
    expect(rows.map(({ stageId }) => stageId)).toHaveLength(8);
    expect(rows.find(({ stageId }) => stageId === "verify-site-data")?.dependencyIds).toEqual([
      "publish-dataset",
      "publish-analysis",
    ]);
    expect(rows.find(({ stageId }) => stageId === "render-report")?.dependencyIds).toEqual([
      "analyze",
    ]);
  });

  it("reuses captured research but reruns volatile computations, never providers", () => {
    expect(evidence).toMatchObject({
      modelCalls: 0,
      composioCalls: 0,
      networkAttempts: 0,
      originalSourceUnchanged: true,
    });
    for (const name of ["unchanged", "report-only"]) {
      expect(stage(name, "load-capture").executionStatus).toBe("reused");
      expect(stage(name, "validate-result").executionStatus).toBe("reused");
      expect(stage(name, "assemble-dataset").decisionReason).toBe("cache_disabled");
      expect(stage(name, "analyze").decisionReason).toBe("cache_disabled");
      expect(stage(name, "render-report").decisionReason).toBe("dependency_executed");
    }
    expect(stage("report-only", "render-report").componentHashes?.watchedFiles).not.toEqual(
      stage("baseline", "render-report").componentHashes?.watchedFiles,
    );
  });

  it("preserves native ordering/values and reports existing policy findings separately", () => {
    expect(evidence.compatibility).toMatchObject({
      datasetOrderAndValues: true,
      analysisOrderAndValues: true,
      reportByteEquality: true,
    });
    expect(evidence.policyFindings).toEqual(["Zulu"]);
    const unchanged = evidence.evaluations.find(({ name }) => name === "unchanged")?.receipt;
    expect(unchanged).toMatchObject({
      evaluationStatus: "failed",
      comparisonStatus: "no_regressions",
    });
    const formatting = evidence.evaluations.find(
      ({ name }) => name === "intentional-format-change",
    )?.receipt;
    expect(formatting).toMatchObject({ evaluationStatus: "failed", comparisonStatus: "regressed" });
    expect(outcome("unchanged").manifest.executionStatus).toBe("completed");
  });

  it("invalidates watched capture, schema, policy, explicit selection, and manual refresh", () => {
    expect(stage("manual-invalidation", "load-capture").decisionReason).toBe("manual_invalidation");
    for (const name of ["watched-capture", "refresh-selection"]) {
      expect(stage(name, "load-capture").decisionReason).toBe("fingerprint_changed");
      expect(stage(name, "validate-result").decisionReason).toBe("dependency_executed");
    }
    for (const name of ["watched-schema", "watched-policy"]) {
      expect(stage(name, "load-capture").executionStatus).toBe("reused");
      expect(stage(name, "validate-result").decisionReason).toBe("fingerprint_changed");
    }
  });

  it("refuses corrupt artifacts and retains one immutable baseline", () => {
    expect(stage("corrupt-artifact-copy", "load-capture")).toMatchObject({
      decisionReason: "baseline_artifact_unavailable",
      executionStatus: "failed",
    });
    expect(
      evidence.outcomes
        .filter(({ name }) => name !== "baseline")
        .every(({ manifest }) => manifest.baselineRunId === evidence.baselineRunId),
    ).toBe(true);
  });

  it("isolates opt-in publication, restores missing files and distinguishes failure skips", () => {
    for (const name of [
      "opt-in-publication",
      "missing-publication-restored",
      "publication-environment-change",
    ]) {
      expect(stage(name, "verify-site-data").executionStatus).toBe("succeeded");
    }
    expect(stage("publication-failure", "publish-dataset").executionStatus).toBe("failed");
    expect(stage("publication-failure", "verify-site-data").executionStatus).toBe(
      "skipped_dependency_failed",
    );
    expect(stage("publication-failure", "render-report").executionStatus).toBe(
      "skipped_run_stopped",
    );
    for (const name of [
      "reject-original-destination",
      "reject-linked-destination",
      "invalid-capture",
    ])
      expect(outcome(name).manifest.executionStatus).toBe("failed");
    expect(stage("invalid-capture", "validate-result").executionStatus).toBe("failed");
  });

  it("rejects source-project outputs and aliases before creating project files", async () => {
    let result = invoke(entry, ["prepare", source, "salesforce.json", join(source, "unsafe")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("outside the original project");
    const alias = join(temporary, "source-alias");
    await symlink(source, alias, process.platform === "win32" ? "junction" : "dir");
    result = invoke(entry, ["prepare", source, "salesforce.json", join(alias, "unsafe")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("aliases the original project");
  });

  it("runs and plans through the separate CLI with publication off by default", async () => {
    const before = await readdir(evidence.root);
    let result = invoke(entry, ["plan", evidence.root, evidence.baselineRunId]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).decisions).toHaveLength(8);
    expect(await readdir(evidence.root)).toEqual(before);
    result = invoke(entry, ["run", evidence.root, evidence.baselineRunId]);
    expect(result.status, result.stderr).toBe(0);
    const review = JSON.parse(result.stdout);
    expect(review.publication).toBe("disabled");
    expect(review.executionStatus).toBe("completed");
    const report = await readFile(join(review.reviewDirectory, `${review.runId}.md`), "utf8");
    expect(report).toBe("# Original report\nZulu,Alpha\nZ,A\n");
    const config = join(evidence.root, "abilitybench.config.ts");
    result = invoke(resolve("dist/cli.js"), [
      "inspect",
      evidence.baselineRunId,
      "--config",
      config,
      "--json",
    ]);
    expect(result.status, result.stderr).toBe(0);
    result = invoke(resolve("dist/cli.js"), [
      "evaluate",
      evidence.baselineRunId,
      review.runId,
      "--config",
      config,
      "--criteria",
      join(review.reviewDirectory, `${review.runId}-criteria.json`),
      "--json",
    ]);
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      receipt: { evaluationStatus: "failed", comparisonStatus: "no_regressions" },
    });
  });
});
