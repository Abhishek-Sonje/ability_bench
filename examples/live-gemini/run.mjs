import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  canonicalizeJson,
  decodeArtifact,
  FileArtifactStore,
  planWorkflowRun,
  runWorkflow,
} from "../../dist/index.js";
import {
  Budget,
  buildWorkflow,
  digest,
  GRAPH,
  outputFromSnapshot,
  PRICING,
  requestBody,
  SETTINGS,
  usageFromResponse,
} from "./adapter.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--env-file"))
  throw new Error("Usage: node examples/live-gemini/run.mjs [--env-file <file>]");
const environment = args[1] ? parseEnv(await readFile(resolve(args[1]), "utf8")) : process.env;
const apiKey = environment.GEMINI_API_KEY ?? environment.GOOGLE_API_KEY;
if (!apiKey)
  throw new Error("Set GEMINI_API_KEY or supply --env-file. Never paste keys into chat.");
const evidenceParent = join(import.meta.dirname, ".abilitybench");
await mkdir(evidenceParent, { recursive: true });
const evidence = await mkdtemp(join(evidenceParent, "experiment-"));
const budget = new Budget();
const ledger = [];
const measurements = [];
let resolvedModelVersion = null;
const syntheticCatalog = {
  text: "Synthetic scenario: a fictional three-person support team handles 40 tickets daily. Option A: shared inbox, $20 monthly, manual tags. Option B: automated triage, $60 monthly, needs human review. No customer data or real company claims. Budget $70 monthly.",
};
const prompts = {
  facts:
    "Extract the budget and operational constraints. Use only provided facts. At most 25 words.",
  options:
    "Compare the two options against the constraints. Use only provided facts. At most 25 words.",
  risks: "Identify one operational risk for each option from supplied facts. At most 25 words.",
  report:
    "Recommend one option using the supplied options and risks. Give one reason. At most 25 words.",
  summary: "Summarize the recommendation without adding claims. At most 20 words.",
};
const changedPrompt =
  "Recommend one option using the supplied options and risks. Include one reason AND one human-review safeguard. At most 30 words.";
async function persist() {
  await writeFile(
    join(evidence, "usage-ledger.json"),
    JSON.stringify({ settings: SETTINGS, pricing: PRICING, budget, ledger, measurements }, null, 2),
  );
}

async function generate(stageId, body, scenario) {
  const timeout = budget.reserve(body);
  const entry = {
    scenario,
    stageId,
    requestHash: digest({ model: SETTINGS.model, body }),
    status: "dispatched",
    startedAt: new Date().toISOString(),
    usage: null,
    elapsedMs: null,
  };
  ledger.push(entry);
  await persist();
  const started = performance.now();
  try {
    // Header only: never place credentials in a URL, log, artifact, or error diagnostic.
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${SETTINGS.model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.ceil(timeout)),
      },
    );
    if (!response.ok)
      throw new Error(
        `Gemini HTTP ${response.status}; request stopped without retry. Provider diagnostic body is deliberately not logged.`,
      );
    const value = await response.json();
    const usage = usageFromResponse(value);
    entry.usage = usage;
    budget.record(usage);
    if (typeof value.modelVersion !== "string" || !value.modelVersion)
      throw new Error("Response did not record a resolved model version.");
    resolvedModelVersion ??= value.modelVersion;
    if (value.modelVersion !== resolvedModelVersion)
      throw new Error("Provider model version changed during the experiment.");
    const candidate = value.candidates?.[0];
    const text = candidate?.content?.parts
      ?.filter((part) => !part.thought && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (candidate?.finishReason !== "STOP" || !text?.trim())
      throw new Error("Response was blocked, truncated, or empty. No retry.");
    entry.status = "completed";
    const snapshot = {
      requestHash: entry.requestHash,
      modelVersion: value.modelVersion,
      text,
      usageMetadata: value.usageMetadata,
    };
    await writeFile(
      join(evidence, `${scenario}-${stageId}-request.json`),
      canonicalizeJson({ model: SETTINGS.model, body }),
    );
    await writeFile(
      join(evidence, `${scenario}-${stageId}-response.json`),
      JSON.stringify(value, null, 2),
    );
    return snapshot;
  } catch (error) {
    entry.status = "failed";
    if (entry.usage === null) budget.unknownUsage = true;
    // Preserve a safe diagnostic only; fetch's cause may contain request internals.
    entry.failure =
      error instanceof Error && !error.message.includes(apiKey)
        ? error.message
        : "Provider call failed.";
    throw new Error(entry.failure);
  } finally {
    entry.elapsedMs = performance.now() - started;
    await persist();
  }
}

async function prepareProject(scenario, baselineRoot = null, changed = false) {
  const root = join(evidence, scenario);
  await mkdir(join(root, "prompts"), { recursive: true });
  await mkdir(join(root, "snapshots"));
  await copyFile(join(import.meta.dirname, "adapter.mjs"), join(root, "adapter.mjs"));
  await writeFile(join(root, "catalog.json"), canonicalizeJson(syntheticCatalog));
  await writeFile(join(root, "settings.json"), canonicalizeJson(SETTINGS));
  for (const [id] of GRAPH.slice(1)) {
    await writeFile(
      join(root, "prompts", `${id}.txt`),
      changed && id === "report" ? changedPrompt : prompts[id],
    );
    if (baselineRoot)
      await copyFile(
        join(baselineRoot, "snapshots", `${id}.json`),
        join(root, "snapshots", `${id}.json`),
      );
    else await writeFile(join(root, "snapshots", `${id}.json`), "{}");
  }
  return root;
}

async function runScenario(scenario, root, baseline = null) {
  const started = performance.now();
  const ledgerStart = ledger.length;
  const toolMetrics = { localCatalogLookupCalls: 0, providerToolCalls: 0 };
  const workflow = await buildWorkflow(root, toolMetrics);
  const options = { inputs: {}, baseline: baseline ? { runId: baseline.manifest.id } : null };
  if (baseline) {
    // Publish byte-identical baseline history into this isolated project. Original history remains untouched.
    const origin = join(baseline.root, ".abilitybench");
    const target = join(root, ".abilitybench");
    for (const folder of ["runs", "objects/sha256"]) {
      await mkdir(join(target, folder), { recursive: true });
      for (const name of await readdir(join(origin, folder)))
        await copyFile(join(origin, folder, name), join(target, folder, name));
    }
  }
  const preliminary = await planWorkflowRun(workflow, options);
  const outputs = {};
  const artifacts = baseline ? new FileArtifactStore(join(baseline.root, ".abilitybench")) : null;
  for (const stageId of workflow.topologicalOrder) {
    const decision = preliminary.plan.decisions.find((stage) => stage.stageId === stageId);
    if (decision.decision === "reuse") {
      const old = baseline.manifest.stages.find((stage) => stage.stageId === stageId);
      const artifact = await artifacts.get(old.outputArtifactHash);
      if (!artifact) throw new Error("Reusable artifact unavailable.");
      outputs[stageId] = decodeArtifact(artifact);
      continue;
    }
    if (stageId === "catalog") {
      outputs.catalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8"));
      continue;
    }
    const dependencyIds = GRAPH.find(([id]) => id === stageId)[1];
    const dependencies = Object.fromEntries(dependencyIds.map((id) => [id, outputs[id]]));
    const body = requestBody(
      await readFile(join(root, "prompts", `${stageId}.txt`), "utf8"),
      dependencies,
    );
    const snapshot = await generate(stageId, body, scenario);
    await writeFile(join(root, "snapshots", `${stageId}.json`), canonicalizeJson(snapshot));
    outputs[stageId] = outputFromSnapshot(snapshot, body);
  }
  const result = await runWorkflow(workflow, options);
  assert.equal(result.manifest.executionStatus, "completed");
  assert.deepEqual(
    result.plan.decisions.map(({ stageId, decision }) => [stageId, decision]),
    preliminary.plan.decisions.map(({ stageId, decision }) => [stageId, decision]),
  );
  if (baseline) {
    assert.equal(result.manifest.baselineRunId, baseline.manifest.id);
    for (const id of ["catalog", "facts", "options", "risks"]) {
      const current = result.manifest.stages.find((stage) => stage.stageId === id);
      const old = baseline.manifest.stages.find((stage) => stage.stageId === id);
      assert.equal(current.executionStatus, "reused");
      assert.equal(current.outputArtifactHash, old.outputArtifactHash);
      assert.equal(current.fingerprint, old.fingerprint);
    }
    assert.equal(
      result.manifest.stages.find((stage) => stage.stageId === "report").decisionReason,
      "fingerprint_changed",
    );
    assert.equal(
      result.manifest.stages.find((stage) => stage.stageId === "summary").decisionReason,
      "dependency_executed",
    );
  }
  const calls = ledger.slice(ledgerStart);
  const usage = calls.reduce(
    (sum, entry) => {
      for (const key of Object.keys(sum)) sum[key] += entry.usage[key];
      return sum;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    },
  );
  const measurement = {
    scenario,
    runId: result.manifest.id,
    baselineRunId: result.manifest.baselineRunId,
    generationAttempts: calls.length,
    generationSuccesses: calls.filter((entry) => entry.status === "completed").length,
    ...toolMetrics,
    ...usage,
    providerElapsedMs: calls.reduce((sum, entry) => sum + entry.elapsedMs, 0),
    elapsedMs: performance.now() - started,
    stageDecisions: result.manifest.stages.map(
      ({ stageId, executionStatus, decisionReason, decisionDetails }) => ({
        stageId,
        executionStatus,
        decisionReason,
        decisionDetails,
      }),
    ),
  };
  measurements.push(measurement);
  await persist();
  return { root, ...result, measurement };
}

try {
  console.log(
    `Evidence directory: ${evidence}\nMaximum 12 generation requests; estimated budget $0.10; no retries.`,
  );
  const baselineRoot = await prepareProject("baseline");
  const baseline = await runScenario("baseline", baselineRoot);
  const baselinePath = join(baselineRoot, ".abilitybench", "runs", `${baseline.manifest.id}.json`);
  const baselineBytes = await readFile(baselinePath);
  const candidateRoot = await prepareProject("incremental", baselineRoot, true);
  const candidate = await runScenario("incremental", candidateRoot, baseline);
  assert.equal(baseline.measurement.generationAttempts, 5);
  assert.equal(candidate.measurement.generationAttempts, 2);
  const fullRoot = await prepareProject("full-control", null, true);
  const full = await runScenario("full-control", fullRoot);
  assert.equal(full.measurement.generationAttempts, 5);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  const savings = {};
  for (const reference of [baseline, full]) {
    savings[reference.measurement.scenario] = Object.fromEntries(
      [
        "generationAttempts",
        "localCatalogLookupCalls",
        "inputTokens",
        "outputTokens",
        "thinkingTokens",
        "totalTokens",
        "estimatedCostUsd",
        "providerElapsedMs",
        "elapsedMs",
      ].map((key) => [
        key,
        {
          avoided: reference.measurement[key] - candidate.measurement[key],
          percent:
            reference.measurement[key] === 0
              ? null
              : ((reference.measurement[key] - candidate.measurement[key]) /
                  reference.measurement[key]) *
                100,
        },
      ]),
    );
  }
  const report = {
    status: "completed",
    runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch },
    settings: SETTINGS,
    resolvedModelVersion,
    pricing: PRICING,
    measurements,
    savings,
    baselineUnchanged: true,
    totalEstimatedCostUsd: budget.measuredUsd,
    reservedUpperEstimateUsd: budget.reservedUsd,
    scope:
      "Plan-directed live capture adapter with deterministic snapshot-consuming engine stages; not native live-provider purity or tool replay.",
  };
  await writeFile(join(evidence, "results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await persist();
  console.error(
    `Experiment stopped: ${error.message}\nEvidence retained at ${evidence}. No automatic retry or budget reset.`,
  );
  process.exitCode = 1;
}
