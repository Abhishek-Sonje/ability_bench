import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureResearch, readCapture } from "../../examples/composio-capture/capture.mjs";
import {
  experimentPolicy,
  experimentPreflight,
  offlineExperiment,
} from "../../examples/composio-capture/experiment-profile.mjs";

const [scenario, root] = process.argv.slice(2);
const modelUrl =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";
const setupUrl = "https://backend.composio.dev/api/v3.1/tool_router/session";
const toolUrl = `${setupUrl}/test-session/execute`;
const setupBody = {
  user_id: "phase-1-research-agent",
  toolkits: { enable: ["composio_search"] },
  tools: {
    composio_search: { enable: ["COMPOSIO_SEARCH_WEB", "COMPOSIO_SEARCH_FETCH_URL_CONTENT"] },
  },
  workbench: { enable: false },
  manage_connections: { enable: true },
};
let calls = 0;
let cancelled = false;
let disabledSdkRetries = false;
let manualRedirect = false;
let responseBytes = 0;
const policy = experimentPolicy();
if (["stream-timeout", "aborted"].includes(scenario)) policy.attemptTimeoutMs = 20;
if (scenario === "overall-timeout") policy.overallTimeoutMs = 1000;
if (scenario === "stream-size") policy.maxResponseBytes = 32;
if (scenario === "policy-expansion") policy.maxModelAttempts = 9;
const experiment = offlineExperiment({
  countCompleteInputTokens:
    scenario === "missing-counter"
      ? undefined
      : (body) => {
          assert(body.generationConfig.responseJsonSchema.properties.ok);
          if (scenario === "counter-timeout") return new Promise(() => {});
          return scenario === "input-overrun" ? 8193 : scenario === "invalid-counter" ? NaN : 100;
        },
});
if (scenario === "counter-timeout") policy.overallTimeoutMs = 20;
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const transport = async (url, init) => {
  calls++;
  manualRedirect = init.redirect === "manual";
  assert(manualRedirect);
  if (scenario === "redirect")
    return new Response(null, { status: 302, headers: { location: "https://evil.invalid" } });
  if (scenario === "stream-size")
    return new Response(
      new ReadableStream(
        {
          pull(controller) {
            responseBytes += 33;
            controller.enqueue(new Uint8Array(33));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    );
  if (scenario === "stream-timeout")
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    );
  if (scenario === "overall-timeout") return new Promise(() => {});
  if (url === setupUrl) return response({ session_id: "test-session" });
  if (url === toolUrl) return response({ data: {}, error: null });
  if (scenario === "hidden-retry" && calls === 1) return response({ error: {} }, 503);
  const value = {
    candidates: [
      { content: { parts: [{ text: scenario === "malformed" ? "{truncated" : '{"ok":true}' }] } },
    ],
  };
  if (!["all-unknown", "model-cap", "concurrency", "hidden-retry"].includes(scenario))
    value.usageMetadata = {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: scenario === "thinking-overrun" ? 2048 : 0,
      totalTokenCount: scenario === "thinking-overrun" ? 2198 : 150,
    };
  return response(value);
};
const client = {
  model: "gemini-3.5-flash-lite",
  client: {
    models: {
      async generateContent(request) {
        disabledSdkRetries = request.config.httpOptions.retryOptions.attempts === 1;
        assert(disabledSdkRetries);
        assert.equal(request.config.maxOutputTokens, 2048);
        const { httpOptions, ...generationConfig } = request.config;
        const body = {
          contents: [{ role: "user", parts: [{ text: request.contents }] }],
          generationConfig,
        };
        let url = modelUrl;
        let headers = { "x-goog-api-key": "mock-key" };
        if (scenario === "wrong-model") url = url.replace("3.5-flash-lite", "3.8-flash");
        if (scenario === "destination")
          url = "https://evil.invalid/v1beta/models/gemini-3.5-flash-lite:generateContent";
        if (scenario === "query-key") url += "?key=mock-key";
        if (scenario === "credentials") headers = { ...headers, authorization: "Bearer mock-key" };
        if (scenario === "unsafe-config") body.generationConfig.tools = [{ googleSearch: {} }];
        if (scenario === "multimodal") body.contents[0].parts = [{ inlineData: { data: "x" } }];
        if (scenario === "request-size") body.contents[0].parts[0].text = "x".repeat(131073);
        const abort = new AbortController();
        if (scenario === "aborted") abort.abort();
        const init = { method: "POST", body: JSON.stringify(body), headers, signal: abort.signal };
        let result = await httpOptions.fetch(
          scenario === "request-object" ? new Request(url, init) : url,
          init,
        );
        if (scenario === "hidden-retry") result = await httpOptions.fetch(url, init);
        const value = await result.json();
        JSON.parse(value.candidates[0].content.parts[0].text);
        return value;
      },
    },
  },
};
const directory = join(root, "account");
if (scenario === "retained-preflight") {
  const eventDir = join(directory, "capture-00000000-0000-0000-0000-000000000000", "events");
  await mkdir(eventDir, { recursive: true });
  await writeFile(
    join(eventDir, "000001.json"),
    JSON.stringify({ type: "reserved", attemptId: "crashed", reservationNanoUsd: 10000000 }),
  );
}
let outcome;
try {
  const capture = await captureResearch({
    directory,
    policy,
    experiment,
    transport,
    validateResult: (x) => x,
    execute: async (boundary) => {
      const model = boundary.gemini(client);
      const generate = () =>
        model.client.models.generateContent({
          model: client.model,
          contents: "Salesforce official documentation",
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: { properties: { ok: { type: "boolean" } } },
          },
        });
      const setup = () =>
        boundary.fetch(setupUrl, { method: "POST", body: JSON.stringify(setupBody) });
      if (
        [
          "tool-cap",
          "setup-cap",
          "unsafe-tool",
          "session-binding",
          "private-url",
          "all-unknown",
          "unsafe-setup",
        ].includes(scenario)
      ) {
        if (scenario === "unsafe-setup") setupBody.workbench.enable = true;
        for (
          let i = 0;
          i < (scenario === "setup-cap" ? 4 : scenario === "all-unknown" ? 3 : 1);
          i++
        )
          await boundary.setup(setup);
        const search = () =>
          boundary.fetch(
            scenario === "session-binding"
              ? toolUrl.replace("test-session", "other-session")
              : toolUrl,
            {
              method: "POST",
              body: JSON.stringify({
                tool_slug:
                  scenario === "unsafe-tool"
                    ? "DELETE_FILE"
                    : scenario === "private-url"
                      ? "COMPOSIO_SEARCH_FETCH_URL_CONTENT"
                      : "COMPOSIO_SEARCH_WEB",
                arguments:
                  scenario === "private-url"
                    ? { url: "https://127.0.0.1/private" }
                    : { query: "Salesforce official documentation" },
              }),
            },
          );
        if (scenario !== "setup-cap" && scenario !== "unsafe-setup") {
          if (scenario === "private-url")
            await boundary.tools({ fetchUrl: search }).fetchUrl("unused");
          else
            for (
              let i = 0;
              i < (scenario === "tool-cap" ? 13 : scenario === "all-unknown" ? 12 : 1);
              i++
            )
              await boundary.tools({ search }).search("Salesforce official documentation");
        }
        if (scenario !== "all-unknown") return {};
      }
      if (scenario === "concurrency") await Promise.all(Array.from({ length: 9 }, generate));
      else
        for (
          let i = 0;
          i <
          (["model-cap", "all-unknown"].includes(scenario)
            ? scenario === "model-cap"
              ? 9
              : 8
            : 1);
          i++
        )
          await generate();
      return {};
    },
  });
  const verified = await readCapture(capture.directory);
  outcome = { manifest: verified.manifest };
} catch {
  outcome = { preflightRejected: true };
}
process.stdout.write(
  JSON.stringify({
    ...outcome,
    calls,
    disabledSdkRetries,
    manualRedirect,
    cancelled,
    responseBytes,
    preflight: experimentPreflight(),
  }),
);
