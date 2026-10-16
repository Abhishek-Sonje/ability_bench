// Offline-only wire fixture. This file never calls fetch or imports a provider client.
export const MOCK_POLICY = Object.freeze({
  mode: "mock-only",
  capUsd: 0.11,
  priorExposureUsd: 0.03731285,
  inputUsdPerMillion: 0.3,
  cachedInputUsdPerMillion: 0.03,
  outputUsdPerMillion: 2.5,
  inputTokenCeiling: 4096,
  outputTokenCeiling: 1024,
  toolAttemptUsd: 0.0001,
  setupAttemptUsd: 0.0001,
  maxModelAttempts: 24,
  maxToolAttempts: 12,
  maxSetupAttempts: 3,
  maxRequestBytes: 131072,
  maxResponseBytes: 131072,
  attemptTimeoutMs: 5000,
  overallTimeoutMs: 20000,
});
export const SOURCE_URL = "https://www.salesforce.com/docs";
export const MOCK_RESULT = {
  app: "Salesforce",
  category: "Customer Relationship Management (CRM)",
  description: "Public Salesforce fixture.",
  authMethods: ["OAuth 2.0"],
  accessModel: "self_serve_free",
  apiSurface: { rest: true, graphql: null, other: [], summary: "Documented REST API." },
  mcp: { status: "unknown" },
  buildability: "buildable",
  blocker: null,
  confidence: "medium",
  unknownFields: ["apiSurface.graphql", "mcp"],
  evidence: [
    {
      title: "Official fixture",
      url: SOURCE_URL,
      sourceType: "official",
      supports: ["authMethods", "accessModel", "apiSurface.rest"],
    },
  ],
  researchNotes: [],
};
export function mockTransport(scenario = "success") {
  let models = 0;
  let toolAttempts = 0;
  let synthesis = 0;
  let mapping = 0;
  const calls = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : (input.url ?? input));
      const body = JSON.parse(init.body);
      calls.push({ route: url.pathname, body }); // In-memory test oracle only; never exported into evidence.
      const response = (value, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      if (url.hostname === "generativelanguage.googleapis.com") {
        models++;
        if (scenario === "provider-retry" && models === 1)
          return response(
            { error: { code: 503, status: "UNAVAILABLE", message: "Mock availability failure" } },
            503,
          );
        if (scenario === "timeout" && models === 1)
          return new Promise((_, reject) =>
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
          );
        const schema =
          body.generationConfig?.responseJsonSchema ?? body.generationConfig?.responseSchema;
        let result;
        if (schema?.properties?.action) {
          const prompt = JSON.stringify(body.contents);
          const fetchAction =
            /Prefer action \\"fetch_url\\"|Prefer action "fetch_url"/.test(prompt) ||
            /"action":"search"/.test(prompt.replaceAll('\\"', '"'));
          result = {
            action: fetchAction ? "fetch_url" : "search",
            query: "Salesforce official documentation",
            url: SOURCE_URL,
            purpose: "Inspect official public evidence",
            reason: null,
          };
          if (scenario === "action-correction" && models === 1)
            result = {
              action: "finish",
              query: null,
              url: null,
              purpose: null,
              reason: "Premature fixture finish",
            };
        } else if (schema?.properties?.apiSurface) {
          synthesis++;
          result = structuredClone(MOCK_RESULT);
          if (scenario === "malformed" && synthesis === 1) result = "__MALFORMED__";
          if (scenario === "private-result") result.description = "Private user jane@example.com";
        } else {
          mapping++;
          result = Object.fromEntries(
            [
              "app",
              "category",
              "description",
              "authMethods",
              "accessModel",
              "apiSurfaceRest",
              "apiSurfaceGraphql",
              "apiSurfaceOther",
              "mcp",
              "buildability",
              "blocker",
            ].map((key) => [
              key,
              [
                "app",
                "category",
                "description",
                "authMethods",
                "accessModel",
                "apiSurfaceRest",
              ].includes(key)
                ? [SOURCE_URL]
                : [],
            ]),
          );
          if (scenario === "mapping-malformed" && mapping === 1) result = "__MALFORMED__";
        }
        const text = result === "__MALFORMED__" ? "{truncated" : JSON.stringify(result);
        return response({
          candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
          modelVersion: "mock-model-version",
          ...(scenario === "unknown-usage"
            ? {}
            : {
                usageMetadata: {
                  promptTokenCount: 100,
                  candidatesTokenCount: 50,
                  thoughtsTokenCount: 0,
                  cachedContentTokenCount: 0,
                  totalTokenCount: 150,
                },
              }),
        });
      }
      if (url.hostname === "backend.composio.dev") {
        if (!url.pathname.endsWith("/execute"))
          return response({
            session_id: "mock-session",
            mcp: { url: "https://backend.composio.dev/mock", type: "http" },
            toolkits: [],
            config: {},
          });
        toolAttempts++;
        if (scenario === "tool-retry" && toolAttempts === 1)
          return response({ error: { message: "Mock retry" } }, 503);
        if (scenario === "tool-failure")
          return response({
            data: {},
            error: "Mock tool failure",
            log_id: "mock-log",
            successful: false,
          });
        return response({
          data: {
            content: "OAuth 2.0. Free account. REST API. Salesforce official documentation.",
            url: SOURCE_URL,
          },
          error: null,
          log_id: "mock-log",
          successful: true,
        });
      }
      throw new Error("Mock transport rejects unknown routes");
    },
  };
}
