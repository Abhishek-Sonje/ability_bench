import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizeJson, defineWorkflow } from "../../dist/index.js";

export const SETTINGS = Object.freeze({
  model: "gemini-3.8-flash",
  thinkingLevel: "LOW",
  maxOutputTokens: 1024,
});
export const PRICING = Object.freeze({
  inputPerMillion: 0.75,
  cachedInputPerMillion: 0.075,
  outputPerMillion: 3.75,
  checkedAt: "2026-10-04",
  source: "https://ai.google.dev/gemini-api/docs/pricing",
});
export const GRAPH = Object.freeze([
  ["catalog", []],
  ["facts", ["catalog"]],
  ["options", ["facts"]],
  ["risks", ["facts"]],
  ["report", ["options", "risks"]],
  ["summary", ["report"]],
]);
export function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalizeJson(value)).digest("hex")}`;
}
export function requestBody(prompt, dependencies) {
  return {
    contents: [
      {
        role: "user",
        parts: [
          { text: `${prompt}\n\nDeclared dependency outputs:\n${canonicalizeJson(dependencies)}` },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: SETTINGS.maxOutputTokens,
      thinkingConfig: { thinkingLevel: SETTINGS.thinkingLevel },
    },
  };
}
export function outputFromSnapshot(snapshot, body) {
  if (
    snapshot.requestHash !== digest({ model: SETTINGS.model, body }) ||
    typeof snapshot.text !== "string" ||
    !snapshot.text.trim() ||
    typeof snapshot.modelVersion !== "string"
  )
    throw new Error("Captured response does not match its declared request/dependencies.");
  return {
    text: snapshot.text,
    requestHash: snapshot.requestHash,
    modelVersion: snapshot.modelVersion,
  };
}
export function usageFromResponse(response) {
  const usage = response.usageMetadata;
  if (
    !usage ||
    !Number.isSafeInteger(usage.promptTokenCount) ||
    !Number.isSafeInteger(usage.totalTokenCount) ||
    !Number.isSafeInteger(usage.candidatesTokenCount)
  )
    throw new Error("Provider usage is missing or ambiguous; stop, do not assume zero cost.");
  const input = usage.promptTokenCount;
  const output = usage.candidatesTokenCount;
  const total = usage.totalTokenCount;
  const thinking = usage.thoughtsTokenCount ?? total - input - output;
  const cached = usage.cachedContentTokenCount ?? 0;
  if (
    ![input, output, total, thinking, cached].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    cached > input ||
    total !== input + output + thinking ||
    (usage.toolUsePromptTokenCount ?? 0) !== 0
  )
    throw new Error("Provider token accounting is inconsistent.");
  const estimatedCostUsd =
    ((input - cached) * PRICING.inputPerMillion +
      cached * PRICING.cachedInputPerMillion +
      (output + thinking) * PRICING.outputPerMillion) /
    1_000_000;
  return {
    inputTokens: input,
    outputTokens: output,
    thinkingTokens: thinking,
    cachedInputTokens: cached,
    totalTokens: total,
    estimatedCostUsd,
  };
}

/** Hard attempt/output/time limits plus conservative client-side spend reservations. */
export class Budget {
  constructor() {
    this.started = performance.now();
    this.attempts = 0;
    this.reservedUsd = 0;
    this.measuredUsd = 0;
    this.unknownUsage = false;
  }
  reserve(body) {
    if (this.unknownUsage)
      throw new Error("An earlier request has unknown usage; no further requests allowed.");
    if (this.attempts >= 12) throw new Error("12-request experiment limit reached.");
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 2048)
      throw new Error("Request exceeds the 2,048-byte prompt envelope limit.");
    const remainingMs = 300_000 - (performance.now() - this.started);
    if (remainingMs <= 0) throw new Error("Five-minute experiment limit reached.");
    const worst =
      (4096 * PRICING.inputPerMillion + SETTINGS.maxOutputTokens * PRICING.outputPerMillion) /
      1_000_000;
    if (this.reservedUsd + worst > 0.1)
      throw new Error("Estimated $0.10 reservation limit reached.");
    this.reservedUsd += worst;
    this.attempts++;
    return Math.min(45_000, remainingMs);
  }
  record(usage) {
    this.measuredUsd += usage.estimatedCostUsd;
    if (
      this.measuredUsd > 0.1 ||
      usage.inputTokens > 4096 ||
      usage.outputTokens + usage.thinkingTokens > SETTINGS.maxOutputTokens
    ) {
      this.unknownUsage = true;
      throw new Error("Measured usage exceeded the experiment reservation assumptions; stop.");
    }
  }
}

export async function buildWorkflow(root, toolMetrics) {
  const builder = defineWorkflow({ id: "live-gemini-validation", root });
  for (const [id, dependencies] of GRAPH) {
    builder.stage({
      id,
      dependsOn: dependencies,
      implementation: `snapshot-${id}-v1`,
      inputs: [],
      env: [],
      cache: true,
      watch:
        id === "catalog"
          ? ["adapter.mjs", "catalog.json"]
          : ["adapter.mjs", "settings.json", `prompts/${id}.txt`, `snapshots/${id}.json`],
      run: async ({ dependencies: outputs }) => {
        if (id === "catalog") {
          const value = JSON.parse(await readFile(join(root, "catalog.json"), "utf8"));
          toolMetrics.localCatalogLookupCalls++;
          return value;
        }
        const prompt = await readFile(join(root, "prompts", `${id}.txt`), "utf8");
        const snapshot = JSON.parse(await readFile(join(root, "snapshots", `${id}.json`), "utf8"));
        const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
        if (canonicalizeJson(settings) !== canonicalizeJson(SETTINGS))
          throw new Error("Loaded settings differ from declared request settings.");
        return outputFromSnapshot(snapshot, requestBody(prompt, outputs));
      },
    });
  }
  return builder.build();
}
