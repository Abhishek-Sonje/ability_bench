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
  checkedAt: "2026-10-13",
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
/** Only retain bounded public error fields, never provider details or credentials. */
export function providerFailure(httpStatus, value, apiKey) {
  const error = value?.error;
  const status =
    typeof error?.status === "string" && /^[A-Z_]{1,64}$/.test(error.status)
      ? error.status
      : "UNKNOWN";
  let message = typeof error?.message === "string" ? error.message : "No diagnostic message.";
  if (apiKey) message = message.split(apiKey).join("[redacted]");
  message = message
    .replace(/AIza[\w-]+/g, "[redacted]")
    .replace(/https?:\/\/\S+/g, "[redacted URL]")
    .split("")
    .map((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character,
    )
    .join("")
    .slice(0, 600);
  return `Gemini HTTP ${httpStatus} (${status}): ${message}`;
}
export const RETRY_POLICY = Object.freeze({
  maxAttemptsPerStage: 3,
  maxTotalAttempts: 15,
  maxDelayMs: 30_000,
});
/** Retry-After is a minimum, never clamped into an earlier request. */
export function retryDelay(attempt, retryAfter, now = Date.now(), random = Math.random) {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt >= RETRY_POLICY.maxAttemptsPerStage)
    throw new Error("503 retry limit reached.");
  let minimum = 0;
  if (typeof retryAfter === "string") {
    const value = retryAfter.trim();
    if (/^\d+$/.test(value)) minimum = Number(value) * 1000;
    else {
      const date = Date.parse(value);
      if (Number.isFinite(date)) minimum = Math.max(0, date - now);
    }
  }
  const delay = Math.max(1000 * 2 ** (attempt - 1) + Math.floor(random() * 251), minimum);
  if (!Number.isFinite(delay) || delay > RETRY_POLICY.maxDelayMs)
    throw new Error("Retry-After exceeds the bounded wait limit; stop instead of retrying early.");
  return delay;
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
export function usageFromResponse(response, pricing = PRICING) {
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
    ((input - cached) * pricing.inputPerMillion +
      cached * pricing.cachedInputPerMillion +
      (output + thinking) * pricing.outputPerMillion) /
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

export const BUDGET_CAP_USD = 0.1;
export const PROTOCOL_CALLS = 12;
export function requestReservation(settings = SETTINGS, pricing = PRICING) {
  if (
    !Number.isSafeInteger(settings.maxOutputTokens) ||
    settings.maxOutputTokens <= 0 ||
    ![pricing.inputPerMillion, pricing.cachedInputPerMillion, pricing.outputPerMillion].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  )
    throw new Error("Invalid retained reservation settings/pricing.");
  return (
    (4096 * pricing.inputPerMillion + settings.maxOutputTokens * pricing.outputPerMillion) /
    1_000_000
  );
}

/** Recompute exposure from original per-attempt evidence, not cumulative ledger totals. */
export function retainedExposure(previous) {
  if (!Array.isArray(previous.ledger) || previous.budget?.attempts !== previous.ledger.length)
    throw new Error("Invalid retained attempt ledger; budget reconciliation stopped.");
  const worst = requestReservation(previous.settings, previous.pricing);
  return previous.ledger.reduce((total, entry) => {
    if (!["dispatched", "completed", "failed"].includes(entry.status))
      throw new Error("Invalid retained request status.");
    if (entry.usage === null) return total + worst;
    const usage = entry.usage;
    if (!usage || !Number.isSafeInteger(usage.thinkingTokens))
      throw new Error("Invalid retained usage.");
    const verified = usageFromResponse(
      {
        usageMetadata: {
          promptTokenCount: usage.inputTokens,
          candidatesTokenCount: usage.outputTokens,
          thoughtsTokenCount: usage.thinkingTokens,
          cachedContentTokenCount: usage.cachedInputTokens,
          totalTokenCount: usage.totalTokens,
        },
      },
      previous.pricing,
    );
    if (
      !Number.isFinite(usage.estimatedCostUsd) ||
      Math.abs(usage.estimatedCostUsd - verified.estimatedCostUsd) > 1e-12 ||
      usage.inputTokens > 4096 ||
      usage.outputTokens + usage.thinkingTokens > previous.settings.maxOutputTokens
    )
      throw new Error("Retained usage violates reservation assumptions; reconciliation stopped.");
    return total + verified.estimatedCostUsd;
  }, 0);
}

/** Hard attempt/output/time limits plus conservative client-side spend reservations. */
export class Budget {
  constructor(priorReservedUsd = 0, capUsd = BUDGET_CAP_USD) {
    if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error("Invalid experiment budget cap.");
    if (!Number.isFinite(priorReservedUsd) || priorReservedUsd < 0 || priorReservedUsd > capUsd)
      throw new Error("Invalid prior experiment reservation.");
    this.started = performance.now();
    this.capUsd = capUsd;
    this.attempts = 0;
    this.priorReservedUsd = priorReservedUsd;
    this.reservedUsd = priorReservedUsd;
    this.measuredUsd = 0;
    this.unknownUsage = false;
    this.reservations = [];
    this.grossReservedUsd = 0;
  }
  preflight(attempts = PROTOCOL_CALLS) {
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > PROTOCOL_CALLS)
      throw new Error("Invalid protocol attempt count.");
    if (this.reservedUsd + attempts * requestReservation() > this.capUsd)
      throw new Error(
        `Complete validation cannot fit the $${this.capUsd.toFixed(2)} worst-case reservation cap; no further requests dispatched.`,
      );
  }
  reserve(body) {
    if (this.unknownUsage)
      throw new Error("An earlier request has unknown usage; no further requests allowed.");
    if (this.attempts >= RETRY_POLICY.maxTotalAttempts)
      throw new Error("15-request experiment limit reached.");
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 2048)
      throw new Error("Request exceeds the 2,048-byte prompt envelope limit.");
    const remainingMs = 300_000 - (performance.now() - this.started);
    if (remainingMs <= 0) throw new Error("Five-minute experiment limit reached.");
    const worst = requestReservation();
    if (this.reservedUsd + worst > this.capUsd)
      throw new Error(`Estimated $${this.capUsd.toFixed(2)} reservation limit reached.`);
    this.reservedUsd += worst;
    this.grossReservedUsd += worst;
    this.attempts++;
    this.reservations.push({ id: this.attempts, amountUsd: worst, settled: false });
    return Math.min(45_000, remainingMs);
  }
  record(usage, reservationId = this.attempts) {
    const reservation = this.reservations.find((item) => item.id === reservationId);
    if (!reservation || reservation.settled)
      throw new Error("Usage requires one unsettled request reservation.");
    const verified = usageFromResponse({
      usageMetadata: {
        promptTokenCount: usage.inputTokens,
        candidatesTokenCount: usage.outputTokens,
        thoughtsTokenCount: usage.thinkingTokens,
        cachedContentTokenCount: usage.cachedInputTokens,
        totalTokenCount: usage.totalTokens,
      },
    });
    if (
      !Number.isFinite(usage.estimatedCostUsd) ||
      usage.estimatedCostUsd < 0 ||
      Math.abs(usage.estimatedCostUsd - verified.estimatedCostUsd) > 1e-12 ||
      usage.estimatedCostUsd > reservation.amountUsd ||
      usage.inputTokens > 4096 ||
      usage.outputTokens + usage.thinkingTokens > SETTINGS.maxOutputTokens
    ) {
      this.unknownUsage = true;
      throw new Error("Measured usage exceeded the experiment reservation assumptions; stop.");
    }
    this.measuredUsd += usage.estimatedCostUsd;
    this.reservedUsd = this.reservedUsd - reservation.amountUsd + usage.estimatedCostUsd;
    reservation.settled = true;
    reservation.actualCostUsd = usage.estimatedCostUsd;
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
