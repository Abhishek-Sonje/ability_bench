import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflow, openHistory, prepare, stage } from "../../../dist/index.js";
import {
  Budget,
  createGeminiGenerator,
  outputFromSnapshot,
  requestBody,
} from "../../examples/live-gemini/adapter.mjs";
import { expectedFacts, PROMPTS, SOURCE_CATALOG } from "../../examples/live-gemini/grounding.mjs";

const root = await mkdtemp(join(tmpdir(), "abilitybench offline Gemini SDK "));
const history = join(root, ".abilitybench");
const originalFetch = globalThis.fetch;
const ledger = [];
let callbacks = 0;
let requests = 0;
const apiKey = "offline-fixture";
const text = JSON.stringify(expectedFacts(SOURCE_CATALOG));
globalThis.fetch = async (url, options) => {
  requests++;
  assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\//);
  assert.equal(options.headers["x-goog-api-key"], apiKey);
  if (requests === 1) {
    return Response.json(
      { error: { status: "UNAVAILABLE", message: "Offline 503" } },
      { status: 503 },
    );
  }
  assert.equal(requests, 2);
  return Response.json({
    modelVersion: "offline-fixture-model",
    candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
  });
};

try {
  const provider = createGeminiGenerator({
    apiKey,
    evidence: root,
    budget: new Budget(0),
    ledger,
    persist: () => writeFile(join(root, "ledger.json"), JSON.stringify(ledger)),
  });
  const catalog = stage({ id: "catalog", reuse: { revision: "one" }, run: () => SOURCE_CATALOG });
  const facts = stage({
    id: "facts",
    reuse: { revision: "one" },
    dependencies: { catalog },
    inputs: { prompt: PROMPTS.facts },
    run: async ({ dependencies, inputs: { prompt } }) => {
      callbacks++;
      const body = requestBody(prompt, dependencies, "facts");
      const snapshot = await provider.generate("facts", body, "sdk", dependencies, prompt);
      return outputFromSnapshot(snapshot, body);
    },
  });
  const workflow = createWorkflow({ id: "gemini-retry", root, stages: [catalog, facts] });
  const fresh = await prepare(workflow, { baseline: null });
  assert.deepEqual([callbacks, requests], [0, 0]);
  const result = await fresh.execute();
  assert.equal(result.status, "completed", JSON.stringify(result.stages[1]?.error));
  assert.deepEqual([callbacks, requests], [1, 2]);
  assert.deepEqual(
    ledger.map(({ attempt, httpStatus, status }) => [attempt, httpStatus, status]),
    [
      [1, 503, "failed"],
      [2, 200, "completed"],
    ],
  );
  assert.equal((await openHistory(history).output(result.runId, "facts")).text, text);
  const retained = await prepare(workflow, { baseline: { runId: result.runId } });
  assert.equal(retained.preview.stages[1]?.decision, "reuse");
  assert.equal((await retained.execute()).stages[1]?.status, "reused");
  assert.deepEqual([callbacks, requests], [1, 2]);
  console.log("Gemini offline retry: 1 SDK callback, 2 transport requests, 0 additional on reuse");
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
