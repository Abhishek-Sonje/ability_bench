import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkflow, prepare, stage } from "abilitybench";
import {
  CHANGED_PROMPT,
  FACTS_JSON_SCHEMA,
  PROMPTS,
  SOURCE_CATALOG,
  validateCatalog,
  validateStageInputs,
} from "./examples/live-gemini/grounding.mjs";
import {
  Budget,
  createGeminiGenerator,
  outputFromSnapshot,
  PRICING,
  requestBody,
  SETTINGS,
} from "./examples/live-gemini/provider.mjs";

const [historyDirectory, diagnostics, publication] = process.argv.slice(2);
await mkdir(diagnostics);
const callbacks = [];
const transportCalls = [];
const ledger = [];
const budget = new Budget(0);
budget.preflight();

const responses = {
  facts: '{"budgetUsd":70,"teamSize":3,"dailyTickets":40,"humanReviewRequired":["B"]}',
  options:
    "A: $20 monthly manual tags; human review unspecified.\nB: $60 monthly automated triage; human review required.",
  risks:
    "A: Hypothesis: manual tagging may slow handling.\nB: Hypothesis: human review could bottleneck triage.",
  report: "Recommend Option A for budget fit. Proposed safeguard: review escalations.",
  summary: "Recommend Option A. Proposed escalation review.",
};
const fixtureModel = "offline-flash-lite-fixture-v1";
const ledgerFile = join(diagnostics, "usage-ledger.json");
const provider = createGeminiGenerator({
  apiKey: "offline-fixture-key",
  evidence: diagnostics,
  budget,
  ledger,
  persist: () =>
    writeFile(
      ledgerFile,
      JSON.stringify({ settings: SETTINGS, pricing: PRICING, budget, ledger }, null, 2),
    ),
  async transport(url, init) {
    assert.equal(
      url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
    assert.equal(init.method, "POST");
    assert.deepEqual(init.headers, {
      "Content-Type": "application/json",
      "x-goog-api-key": "offline-fixture-key",
    });
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    const stageId = /^\[([a-z]+)\]/.exec(body.contents[0].parts[0].text)?.[1];
    assert.ok(Object.hasOwn(responses, stageId));
    transportCalls.push(stageId);
    assert.equal(body.generationConfig.maxOutputTokens, 1024);
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "LOW");
    assert.deepEqual(
      body.generationConfig.responseFormat,
      stageId === "facts"
        ? { text: { mimeType: "application/json", schema: FACTS_JSON_SCHEMA } }
        : undefined,
    );
    return Response.json({
      modelVersion: fixtureModel,
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { thought: true, text: "Provider thought ignored by the original response handler" },
              { text: responses[stageId] },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 75 },
    });
  },
});

function build(reportPrompt, scenario) {
  const catalog = stage({
    id: "catalog",
    inputs: { value: SOURCE_CATALOG },
    reuse: { revision: "catalog-validation-v1" },
    run: ({ inputs }) => {
      callbacks.push("catalog");
      return validateCatalog(inputs.value);
    },
  });
  const modelStage = (id, dependencies, prompt) =>
    stage({
      id,
      dependencies,
      inputs: { prompt, settings: SETTINGS },
      reuse: { revision: "provider-and-validation-v1" },
      run: async ({ dependencies, inputs }) => {
        callbacks.push(id);
        assert.deepEqual(inputs.settings, SETTINGS);
        validateStageInputs(id, dependencies);
        const body = requestBody(inputs.prompt, dependencies, id);
        const response = await provider.generate(id, body, scenario, dependencies, inputs.prompt);
        return outputFromSnapshot(response, body);
      },
    });
  const facts = modelStage("facts", { catalog }, PROMPTS.facts);
  const options = modelStage("options", { catalog, facts }, PROMPTS.options);
  const risks = modelStage("risks", { catalog, facts }, PROMPTS.risks);
  const report = modelStage("report", { catalog, options, risks }, reportPrompt);
  const summary = modelStage("summary", { catalog, report }, PROMPTS.summary);
  return createWorkflow({
    id: "gemini-iteration",
    root: import.meta.dirname,
    stages: [catalog, facts, options, risks, report, summary],
  });
}

// Required publication is an application operation after each successful execution.
async function publish(runId) {
  await writeFile(publication, runId);
  assert.equal(await readFile(publication, "utf8"), runId);
}

const ids = ["catalog", "facts", "options", "risks", "report", "summary"];
const first = await prepare(build(PROMPTS.report, "first"), { historyDirectory, baseline: null });
assert.deepEqual(callbacks, []);
assert.deepEqual(transportCalls, []);
const a = await first.execute();
assert.equal(a.status, "completed", JSON.stringify(a.stages));
assert.deepEqual(callbacks, ids);
assert.deepEqual(transportCalls, ids.slice(1));
assert.ok(
  a.stages.every(({ preview, actual }) => preview.reason === "fresh" && actual.reason === "fresh"),
);
await publish(a.runId);

const changed = await prepare(build(CHANGED_PROMPT, "changed"), {
  historyDirectory,
  baseline: { runId: a.runId },
});
assert.deepEqual(callbacks, ids);
assert.deepEqual(transportCalls, ids.slice(1));
assert.deepEqual(
  changed.preview.stages.map(({ decision, reason }) => [decision, reason]),
  [
    ...Array.from({ length: 4 }, () => ["reuse", "reused"]),
    ["execute", "influences_changed"],
    ["conditional", "reused"],
  ],
);
assert.deepEqual(changed.preview.stages.at(-1).details.unresolvedStages, ["report"]);
const b = await changed.execute();
assert.equal(b.status, "completed", JSON.stringify(b.stages));
assert.equal(b.baseline.runId, a.runId);
assert.deepEqual(callbacks.slice(6), ["report", "summary"]);
assert.deepEqual(transportCalls.slice(5), ["report", "summary"]);
assert.deepEqual(
  b.stages.map(({ actual }) => [actual.decision, actual.reason]),
  [
    ...Array.from({ length: 4 }, () => ["reuse", "reused"]),
    ["execute", "influences_changed"],
    ["execute", "influences_changed"],
  ],
);
for (const [i, row] of b.stages.entries()) {
  assert.deepEqual(row.dependencies, a.stages[i].dependencies);
  const { stageId, ...preview } = changed.preview.stages[i];
  assert.equal(row.stageId, stageId);
  assert.deepEqual(row.preview, preview);
  if (i < 4) assert.deepEqual(row.output, a.stages[i].output);
}
assert.deepEqual(
  b.stages[4].actual.details.changedComponents.map(({ name }) => name),
  ["inputs"],
);
assert.deepEqual(
  b.stages[5].actual.details.changedComponents.map(({ name }) => name),
  ["dependencies"],
);
assert.deepEqual(b.stages[5].actual.details.changedBindings, ["report"]);
assert.notEqual(a.stages[4].output.hash, b.stages[4].output.hash);
await publish(b.runId);

const persisted = JSON.parse(await readFile(ledgerFile, "utf8"));
assert.equal(persisted.budget.attempts, 7);
assert.equal(persisted.budget.unknownUsage, false);
assert.deepEqual(
  persisted.ledger.map(({ stageId }) => stageId),
  transportCalls,
);
assert.ok(
  persisted.ledger.every(
    ({ status, attempt, usage }) =>
      status === "completed" && attempt === 1 && usage.totalTokens === 75,
  ),
);
const diagnosticsFiles = (await readdir(diagnostics)).filter(
  (name) => name !== "usage-ledger.json",
);
assert.deepEqual(
  diagnosticsFiles,
  [...ids.slice(1).map((id) => ["first", id]), ["changed", "report"], ["changed", "summary"]]
    .flatMap(([scenario, id]) =>
      ["request", "response"].map((kind) => `${[scenario, id, kind].join("-")}.json`),
    )
    .sort(),
);
const counts = (calls) =>
  Object.fromEntries(ids.map((id) => [id, calls.filter((item) => item === id).length]));
console.log(
  JSON.stringify({
    a,
    b,
    responses,
    fixtureModel,
    diagnosticsFiles,
    ledger: persisted.ledger,
    fresh: {
      callbacks: counts(callbacks.slice(0, 6)),
      transport: counts(transportCalls.slice(0, 5)),
    },
    changed: { callbacks: counts(callbacks.slice(6)), transport: counts(transportCalls.slice(5)) },
  }),
);
