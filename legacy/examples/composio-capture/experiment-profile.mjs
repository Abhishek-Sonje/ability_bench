// Provider-specific, isolated experiment preparation. Never imported by the core SDK.
import assert from "node:assert/strict";
import { CaptureStop } from "./capture.mjs";

export const EXPERIMENT = Object.freeze({
  id: "salesforce-bounded-v1",
  model: "gemini-3.5-flash-lite",
  steps: 4,
  inputTokens: 8192,
  outputAndThinkingTokens: 2048,
  modelAttempts: 8, // Six healthy calls plus two shared corrections/retries, not two per call.
  toolAttempts: 12, // Four actions, three SDK wire attempts each.
  setupAttempts: 3,
  capNanoUsd: 110000000,
  historicalNanoUsd: 37312850,
  modelAttemptNanoUsd: 7577600,
  toolAttemptNanoUsd: 500000, // Proposed maximum, NOT a verified Composio price.
  setupAttemptNanoUsd: 0,
  requestBytes: 131072,
  responseBytes: 1048576,
  attemptTimeoutMs: 60000,
  overallTimeoutMs: 300000,
});

export function experimentPreflight(additionalExposureNanoUsd = 0) {
  assert(Number.isSafeInteger(additionalExposureNanoUsd) && additionalExposureNanoUsd >= 0);
  const reservationNanoUsd =
    EXPERIMENT.modelAttempts * EXPERIMENT.modelAttemptNanoUsd +
    EXPERIMENT.toolAttempts * EXPERIMENT.toolAttemptNanoUsd;
  const availableNanoUsd =
    EXPERIMENT.capNanoUsd - EXPERIMENT.historicalNanoUsd - additionalExposureNanoUsd;
  return {
    profile: EXPERIMENT.id,
    reservationNanoUsd,
    availableNanoUsd,
    remainingAfterReservationNanoUsd: availableNanoUsd - reservationNanoUsd,
    arithmeticFits: reservationNanoUsd <= availableNanoUsd,
    readyForLive: false,
    blockers: [
      "No audited local input-token upper-bound implementation for the complete REST request, including schema overhead.",
      "Combined output/thinking cutoff requires confirmation for this generateContent endpoint/model, not the Interactions API.",
      "Composio search/fetch price, retry billing and applicable account limits are not verified within the proposed $0.0005/attempt ceiling.",
      "Composio backend redirect/private-destination safety is not enforced by local fetch guards.",
      "A fresh shared-account audit must reconcile all live history before enabling native dispatch.",
    ],
  };
}

export function experimentPolicy() {
  return {
    mode: "mock-only",
    capUsd: 0.11,
    priorExposureUsd: 0.03731285,
    inputUsdPerMillion: 0.3,
    cachedInputUsdPerMillion: 0.03,
    outputUsdPerMillion: 2.5,
    inputTokenCeiling: EXPERIMENT.inputTokens,
    outputTokenCeiling: EXPERIMENT.outputAndThinkingTokens,
    toolAttemptUsd: EXPERIMENT.toolAttemptNanoUsd / 1e9,
    setupAttemptUsd: 0,
    maxModelAttempts: EXPERIMENT.modelAttempts,
    maxToolAttempts: EXPERIMENT.toolAttempts,
    maxSetupAttempts: EXPERIMENT.setupAttempts,
    maxRequestBytes: EXPERIMENT.requestBytes,
    maxResponseBytes: EXPERIMENT.responseBytes,
    attemptTimeoutMs: EXPERIMENT.attemptTimeoutMs,
    overallTimeoutMs: EXPERIMENT.overallTimeoutMs,
  };
}

const origins = new Set(["https://developer.salesforce.com", "https://help.salesforce.com"]);
const tools = ["COMPOSIO_SEARCH_WEB", "COMPOSIO_SEARCH_FETCH_URL_CONTENT"];
const exact = (value, expected) => JSON.stringify(value) === JSON.stringify(expected);
const onlyKeys = (value, keys) => value && Object.keys(value).every((key) => keys.includes(key));
function requireSafe(condition) {
  if (!condition) throw new CaptureStop("unsafe_request");
}

/** Offline SDK oracle only. No heuristic tokenizer or caller attestation can unlock live mode. */
export function offlineExperiment({ countCompleteInputTokens }) {
  let sessionId = null;
  const counts = new Map();
  return {
    completeReservation(policy) {
      const expected = experimentPolicy();
      const reducible = [
        "maxRequestBytes",
        "maxResponseBytes",
        "attemptTimeoutMs",
        "overallTimeoutMs",
      ];
      for (const key of Object.keys(expected)) {
        requireSafe(
          reducible.includes(key) ? policy[key] <= expected[key] : policy[key] === expected[key],
        );
      }
      return experimentPreflight().reservationNanoUsd;
    },
    configureRequest(request) {
      requireSafe(request.model === EXPERIMENT.model);
      return {
        ...request,
        config: {
          ...request.config,
          candidateCount: 1,
          maxOutputTokens: EXPERIMENT.outputAndThinkingTokens,
          thinkingConfig: { thinkingLevel: "MINIMAL" },
        },
      };
    },
    async inspectRequest(url, body, init, call) {
      requireSafe(
        url.protocol === "https:" && !url.search && !url.hash && !url.username && !url.password,
      );
      const headers = new Headers(init.headers);
      requireSafe(
        !headers.has("cookie") &&
          !headers.has("authorization") &&
          !headers.has("proxy-authorization"),
      );
      const google = url.origin === "https://generativelanguage.googleapis.com";
      requireSafe(!headers.has(google ? "x-api-key" : "x-goog-api-key"));
      if (google) {
        requireSafe(
          url.pathname === `/v1beta/models/${EXPERIMENT.model}:generateContent` &&
            call.kind === "model",
        );
        requireSafe(onlyKeys(body, ["contents", "generationConfig", "model"]));
        const config = body.generationConfig;
        requireSafe(
          config?.maxOutputTokens === EXPERIMENT.outputAndThinkingTokens &&
            config.candidateCount === 1 &&
            exact(config.thinkingConfig, { thinkingLevel: "MINIMAL" }) &&
            config.responseMimeType === "application/json",
        );
        requireSafe(
          onlyKeys(config, [
            "candidateCount",
            "maxOutputTokens",
            "thinkingConfig",
            "responseMimeType",
            "responseJsonSchema",
            "responseSchema",
          ]),
        );
        requireSafe(
          Array.isArray(body.contents) &&
            body.contents.every(
              (content) =>
                onlyKeys(content, ["role", "parts"]) &&
                Array.isArray(content.parts) &&
                content.parts.every(
                  (part) => onlyKeys(part, ["text"]) && typeof part.text === "string",
                ),
            ),
        );
        if (typeof countCompleteInputTokens !== "function") throw new CaptureStop("input_limit");
        const tokens = await countCompleteInputTokens(structuredClone(body));
        if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > EXPERIMENT.inputTokens)
          throw new CaptureStop("input_limit");
      } else {
        requireSafe(url.origin === "https://backend.composio.dev");
        if (call.kind === "setup") {
          requireSafe(url.pathname === "/api/v3.1/tool_router/session");
          requireSafe(
            onlyKeys(body, ["user_id", "toolkits", "tools", "workbench", "manage_connections"]),
          );
          requireSafe(
            body.user_id === "phase-1-research-agent" &&
              exact(body.toolkits, { enable: ["composio_search"] }) &&
              exact(body.tools, { composio_search: { enable: tools } }) &&
              exact(body.workbench, { enable: false }),
          );
          requireSafe(exact(body.manage_connections, { enable: true })); // Original SDK default, never execute management endpoints.
        } else {
          requireSafe(
            sessionId && url.pathname === `/api/v3.1/tool_router/session/${sessionId}/execute`,
          );
          requireSafe(onlyKeys(body, ["tool_slug", "arguments"]) && tools.includes(body.tool_slug));
          if (body.tool_slug === tools[0]) {
            requireSafe(call.kind === "search" && exact(Object.keys(body.arguments), ["query"]));
            const query = body.arguments.query;
            requireSafe(
              typeof query === "string" &&
                query.length <= 500 &&
                /salesforce/i.test(query) &&
                /official|documentation|developer|authentication|oauth|access/i.test(query) &&
                !/[\r\n]|@|https?:|\b(?:password|secret|bearer)\b/i.test(query),
            );
          } else {
            requireSafe(call.kind === "fetch" && exact(Object.keys(body.arguments), ["url"]));
            const target = new URL(body.arguments.url);
            requireSafe(
              origins.has(target.origin) &&
                !target.username &&
                !target.password &&
                !target.search &&
                !target.hash &&
                target.href.length <= 2048,
            );
          }
        }
      }
      const key = call.id;
      const attempts = (counts.get(key) ?? 0) + 1;
      requireSafe(attempts <= (google ? 1 : 3)); // App retries get new call IDs; hidden Gemini retries are disabled.
      counts.set(key, attempts);
    },
    inspectResponse(url, _body, status, text) {
      if (url.pathname === "/api/v3.1/tool_router/session" && status >= 200 && status < 300) {
        const value = JSON.parse(text);
        requireSafe(
          typeof value.session_id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value.session_id),
        );
        requireSafe(sessionId === null || sessionId === value.session_id);
        sessionId = value.session_id;
      }
    },
  };
}
