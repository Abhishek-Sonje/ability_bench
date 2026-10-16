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
import { setTimeout as delay } from "node:timers/promises";
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
  PROTOCOL_CALLS,
  providerFailure,
  RETRY_POLICY,
  requestBody,
  retainedExposure,
  retryDelay,
  SETTINGS,
  usageFromResponse,
} from "./adapter.mjs";
import {
  CHANGED_PROMPT,
  EXAMPLE_VERSION,
  PROMPTS,
  SOURCE_CATALOG,
  validateCatalog,
  validateStageInputs,
  validateStageOutput,
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
  let completedCaptures = 0;
  let resolvedModelVersion = null;
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

  async function generate(stageId, body, scenario, dependencies, prompt) {
    for (let attempt = 1; attempt <= RETRY_POLICY.maxAttemptsPerStage; attempt++) {
      // Leave worst-case headroom for every still-required successful capture.
      try {
        budget.preflight(PROTOCOL_CALLS - completedCaptures);
      } catch (error) {
        error.failureOrigin = "budget_guard";
        throw error;
      }
      let timeout;
      try {
        timeout = budget.reserve(body);
      } catch (error) {
        error.failureOrigin = "budget_guard";
        throw error;
      }
      const entry = {
        scenario,
        stageId,
        attempt,
        requestHash: digest({ model: SETTINGS.model, body }),
        status: "dispatched",
        startedAt: new Date().toISOString(),
        usage: null,
        elapsedMs: null,
      };
      ledger.push(entry);
      await persist();
      const started = performance.now();
      let attemptFailure;
      let retryAfter = null;
      let failureOrigin = "provider";
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
        entry.httpStatus = response.status;
        if (!response.ok) {
          retryAfter = response.headers.get("Retry-After");
          const diagnostic = await response.json().catch(() => null);
          throw new Error(providerFailure(response.status, diagnostic, apiKey));
        }
        const value = await response.json();
        const usage = usageFromResponse(value);
        entry.usage = usage;
        failureOrigin = "budget_guard";
        budget.record(usage);
        failureOrigin = "provider";
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
        const snapshot = {
          requestHash: entry.requestHash,
          modelVersion: value.modelVersion,
          text,
          usageMetadata: value.usageMetadata,
        };
        failureOrigin = "adapter";
        await writeFile(
          join(evidence, `${scenario}-${stageId}-request.json`),
          canonicalizeJson({ model: SETTINGS.model, body }),
        );
        await writeFile(
          join(evidence, `${scenario}-${stageId}-response.json`),
          JSON.stringify(value, null, 2),
        );
        failureOrigin = "grounding_validation";
        validateStageOutput(stageId, text, dependencies, prompt);
        entry.status = "completed";
        completedCaptures++;
        return snapshot;
      } catch (error) {
        entry.status = "failed";
        // A 503 remains fully reserved, but may be retried under the bounded policy.
        if (entry.usage === null && entry.httpStatus !== 503) budget.unknownUsage = true;
        // Preserve a safe diagnostic only; fetch's cause may contain request internals.
        entry.failure =
          error instanceof Error && !error.message.includes(apiKey)
            ? error.message
            : "Provider call failed.";
        entry.failureOrigin = failureOrigin;
        attemptFailure = new Error(entry.failure);
        attemptFailure.failureOrigin = failureOrigin;
      } finally {
        entry.elapsedMs = performance.now() - started;
        await persist();
      }
      if (entry.httpStatus !== 503 || attempt >= RETRY_POLICY.maxAttemptsPerStage)
        throw attemptFailure;
      let waitMs;
      try {
        waitMs = retryDelay(attempt, retryAfter);
        budget.preflight(PROTOCOL_CALLS - completedCaptures);
        if (performance.now() - budget.started + waitMs >= 300_000)
          throw new Error("Retry wait exceeds the five-minute experiment deadline.");
      } catch (error) {
        error.failureOrigin = "retry_guard";
        throw error;
      }
      entry.retryDelayMs = waitMs;
      await persist();
      await delay(waitMs);
    }
  }

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
      const body = requestBody(prompt, dependencies);
      const snapshot = await generate(stageId, body, scenario, dependencies, prompt);
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
      resolvedModelVersion,
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
