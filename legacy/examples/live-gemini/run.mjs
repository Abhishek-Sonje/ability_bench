import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
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
  createGeminiGenerator,
  digest,
  GRAPH,
  outputFromSnapshot,
  PRICING,
  PROTOCOL_CALLS,
  requestBody,
  retainedExposure,
  SETTINGS,
} from "./adapter.mjs";
import {
  CHANGED_PROMPT,
  EXAMPLE_VERSION,
  PROMPTS,
  SOURCE_CATALOG,
  validateCatalog,
  validateStageInputs,
} from "./grounding.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--env-file"))
  throw new Error("Usage: node examples/live-gemini/run.mjs [--env-file <file>]");
const environment = args[1] ? parseEnv(await readFile(resolve(args[1]), "utf8")) : process.env;
const apiKey = environment.GEMINI_API_KEY ?? environment.GOOGLE_API_KEY;
if (!apiKey)
  throw new Error("Set GEMINI_API_KEY or supply --env-file. Never paste keys into chat.");
const evidenceParent = join(import.meta.dirname, ".abilitybench");
await mkdir(evidenceParent, { recursive: true });
// Fail closed on concurrent invocations or a stale lock; never reset spending history.
const lockPath = join(evidenceParent, "budget.lock");
const budgetLock = await open(lockPath, "wx");
try {
  let priorReservedUsd = 0;
  for (const name of await readdir(evidenceParent)) {
    if (!name.startsWith("experiment-")) continue;
    try {
      const previous = JSON.parse(
        await readFile(join(evidenceParent, name, "usage-ledger.json"), "utf8"),
      );
      priorReservedUsd += retainedExposure(previous);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const budget = new Budget(priorReservedUsd);
  budget.preflight();
  const evidence = await mkdtemp(join(evidenceParent, "experiment-"));
  const ledger = [];
  const measurements = [];
  const executionResults = [];
  const syntheticCatalog = SOURCE_CATALOG;
  const prompts = PROMPTS;
  const changedPrompt = CHANGED_PROMPT;
  async function persist() {
    await writeFile(
      join(evidence, "usage-ledger.json"),
      JSON.stringify(
        { settings: SETTINGS, pricing: PRICING, budget, ledger, measurements },
        null,
        2,
      ),
    );
  }

  const provider = createGeminiGenerator({ apiKey, evidence, budget, ledger, persist });

  async function engine(operation) {
    try {
      return await operation();
    } catch (error) {
      error.failureOrigin = "abilitybench";
      throw error;
    }
  }

  function failureSummary(error = null) {
    const finalFailure = error
      ? {
          origin: error.failureOrigin ?? "adapter",
          message: error.message.includes(apiKey) ? "Diagnostic redacted." : error.message,
        }
      : null;
    return {
      finalFailure,
      providerFailures: ledger
        .filter((entry) => entry.failureOrigin === "provider")
        .map(({ scenario, stageId, attempt, httpStatus, failure, retryDelayMs }) => ({
          scenario,
          stageId,
          attempt,
          httpStatus,
          message: failure,
          retryDelayMs,
        })),
      abilityBenchFailures: finalFailure?.origin === "abilitybench" ? [finalFailure] : [],
      adapterOrGuardFailures:
        finalFailure && !["abilitybench", "provider"].includes(finalFailure.origin)
          ? [finalFailure]
          : [],
      executionResults,
    };
  }

  async function prepareProject(scenario, baselineRoot = null, changed = false) {
    const root = join(evidence, scenario);
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(root, "snapshots"));
    await copyFile(join(import.meta.dirname, "adapter.mjs"), join(root, "adapter.mjs"));
    await copyFile(join(import.meta.dirname, "grounding.mjs"), join(root, "grounding.mjs"));
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
    const workflow = await engine(() => buildWorkflow(root, toolMetrics));
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
    const preliminary = await engine(() => planWorkflowRun(workflow, options));
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
        outputs.catalog = validateCatalog(
          JSON.parse(await readFile(join(root, "catalog.json"), "utf8")),
        );
        continue;
      }
      const dependencyIds = GRAPH.find(([id]) => id === stageId)[1];
      const dependencies = Object.fromEntries(dependencyIds.map((id) => [id, outputs[id]]));
      validateStageInputs(stageId, dependencies);
      const prompt = await readFile(join(root, "prompts", `${stageId}.txt`), "utf8");
      const body = requestBody(prompt, dependencies, stageId);
      const snapshot = await provider.generate(stageId, body, scenario, dependencies, prompt);
      await writeFile(join(root, "snapshots", `${stageId}.json`), canonicalizeJson(snapshot));
      outputs[stageId] = outputFromSnapshot(snapshot, body);
    }
    const result = await engine(() => runWorkflow(workflow, options));
    executionResults.push({
      scenario,
      runId: result.manifest.id,
      status: result.manifest.executionStatus,
    });
    if (result.manifest.executionStatus !== "completed") {
      const error = new Error(
        "AbilityBench execution did not complete; inspect the recorded manifest.",
      );
      error.failureOrigin = "abilitybench";
      throw error;
    }
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
        if (entry.usage === null) return sum;
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
      unknownUsageAttempts: calls.filter((entry) => entry.usage === null).length,
      unknownUsageReservedUsd:
        calls.filter((entry) => entry.usage === null).length * budget.reservations[0].amountUsd,
      retryWaitMs: calls.reduce((sum, entry) => sum + (entry.retryDelayMs ?? 0), 0),
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
      `Evidence directory: ${evidence}\nModel ${SETTINGS.model}; maximum 15 attempts; budget $${budget.capUsd.toFixed(2)}; bounded 503 retries.`,
    );
    const baselineRoot = await prepareProject("baseline");
    const baseline = await runScenario("baseline", baselineRoot);
    const baselinePath = join(
      baselineRoot,
      ".abilitybench",
      "runs",
      `${baseline.manifest.id}.json`,
    );
    const baselineBytes = await readFile(baselinePath);
    const candidateRoot = await prepareProject("incremental", baselineRoot, true);
    const candidate = await runScenario("incremental", candidateRoot, baseline);
    assert.equal(baseline.measurement.generationSuccesses, 5);
    assert.equal(candidate.measurement.generationSuccesses, 2);
    const fullRoot = await prepareProject("full-control", null, true);
    const full = await runScenario("full-control", fullRoot);
    assert.equal(full.measurement.generationSuccesses, 5);
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
          (reference.measurement.unknownUsageAttempts > 0 ||
            candidate.measurement.unknownUsageAttempts > 0) &&
          [
            "inputTokens",
            "outputTokens",
            "thinkingTokens",
            "totalTokens",
            "estimatedCostUsd",
          ].includes(key)
            ? {
                available: false,
                reason:
                  "Provider usage is unknown for one or more attempts; actual savings cannot be calculated.",
              }
            : {
                available: true,
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
      exampleVersion: EXAMPLE_VERSION,
      ...failureSummary(),
      usageComplete: ledger.every((entry) => entry.usage !== null),
      savingsAreKnownUsageOnly: ledger.some((entry) => entry.usage === null),
      runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch },
      priorReservedUsd,
      settings: SETTINGS,
      resolvedModelVersion: provider.resolvedModelVersion,
      pricing: PRICING,
      measurements,
      savings,
      baselineUnchanged: true,
      totalEstimatedCostUsd: budget.measuredUsd,
      knownUsageEstimatedCostUsd: budget.measuredUsd,
      accountedExposureUsd: budget.reservedUsd,
      grossNewReservationsUsd: budget.grossReservedUsd,
      scope:
        "Plan-directed live capture adapter with deterministic snapshot-consuming engine stages; not native live-provider purity or tool replay.",
    };
    await writeFile(join(evidence, "results.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await persist();
    const report = {
      status: "incomplete",
      exampleVersion: EXAMPLE_VERSION,
      ...failureSummary(error),
      settings: SETTINGS,
      measurements,
      accountedExposureUsd: budget.reservedUsd,
      knownUsageEstimatedCostUsd: budget.measuredUsd,
      unknownUsageAttempts: ledger.filter((entry) => entry.usage === null).length,
      unexecutedScenariosAreNotCompleted: true,
    };
    await writeFile(join(evidence, "results.json"), JSON.stringify(report, null, 2));
    console.error(
      `Experiment stopped (${report.finalFailure.origin}): ${report.finalFailure.message}\nEvidence retained at ${evidence}. No budget reset.`,
    );
    process.exitCode = 1;
  }
} finally {
  await budgetLock.close();
  await unlink(lockPath);
}
