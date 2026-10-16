// Opt-in example boundary. No engine/provider registration and no live transport in Step 2.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value);
let active = false;
const nano = (usd) => Math.ceil(usd * 1e9);
const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const stopCodes = new Set([
  "budget_exhausted",
  "attempt_limit",
  "timeout",
  "unsafe_request",
  "request_limit",
  "usage_invalid",
  "usage_overrun",
  "private_export",
  "closed",
  "persistence",
  "unfinished_requests",
]);

export class CaptureStop extends Error {
  constructor(code) {
    super(stopCodes.has(code) ? code : "capture_stopped");
    this.name = "CaptureStop";
    this.code = this.message;
  }
}

function failure(error) {
  if (error instanceof CaptureStop) return error.code;
  if (error?.name === "SyntaxError") return "malformed_json";
  if (error?.name === "ZodError") return "schema_validation";
  if (["TimeoutError", "AbortError"].includes(error?.name)) return "timeout";
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599)
    return `http_${error.status}`;
  return "operation_failed"; // Never persist arbitrary error names, messages, causes or stacks.
}

async function immutable(path, bytes) {
  const file = await open(path, "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

function policyOf(policy) {
  assert(
    policy?.mode === "mock-only",
    "Step 2 accepts mocked transports only; live capture is not implemented.",
  );
  for (const key of [
    "capUsd",
    "priorExposureUsd",
    "inputUsdPerMillion",
    "cachedInputUsdPerMillion",
    "outputUsdPerMillion",
    "toolAttemptUsd",
    "setupAttemptUsd",
  ])
    assert(Number.isFinite(policy[key]) && policy[key] >= 0, "Invalid mock budget policy.");
  for (const key of [
    "inputTokenCeiling",
    "outputTokenCeiling",
    "maxModelAttempts",
    "maxToolAttempts",
    "maxSetupAttempts",
    "maxRequestBytes",
    "maxResponseBytes",
    "attemptTimeoutMs",
    "overallTimeoutMs",
  ])
    assert(Number.isSafeInteger(policy[key]) && policy[key] > 0, "Invalid mock attempt limits.");
  assert(policy.cachedInputUsdPerMillion <= policy.inputUsdPerMillion);
  assert(policy.priorExposureUsd <= policy.capUsd);
  assert(Object.keys(policy).length === 17, "Unknown capture policy fields are forbidden.");
  assert(safeInteger(nano(policy.capUsd)), "Mock budget is outside integer accounting range.");
  return structuredClone(policy);
}

export function reportedUsage(value, policy) {
  const u = value?.usageMetadata;
  if (!u) return null;
  const input = u.promptTokenCount;
  const output = u.candidatesTokenCount;
  const thinking = u.thoughtsTokenCount ?? 0;
  const cached = u.cachedContentTokenCount ?? 0;
  const total = u.totalTokenCount;
  if (
    ![input, output, thinking, cached, total].every(safeInteger) ||
    cached > input ||
    total !== input + output + thinking
  )
    throw new CaptureStop("usage_invalid");
  const costNanoUsd = Math.ceil(
    ((input - cached) * policy.inputUsdPerMillion +
      cached * policy.cachedInputUsdPerMillion +
      (output + thinking) * policy.outputUsdPerMillion) *
      1000,
  );
  if (!safeInteger(costNanoUsd)) throw new CaptureStop("usage_invalid");
  return { input, output, thinking, cached, total, costNanoUsd };
}

function requestKind(url, body, method, context) {
  if (method !== "POST" || url.username || url.password || url.hash)
    throw new CaptureStop("unsafe_request");
  if (
    url.origin === "https://generativelanguage.googleapis.com" &&
    /^\/v1beta\/models\/[a-zA-Z0-9._-]+:generateContent$/.test(url.pathname) &&
    context?.kind === "model"
  )
    return "model";
  if (url.origin !== "https://backend.composio.dev" || url.search)
    throw new CaptureStop("unsafe_request");
  if (/^\/api\/v3(?:\.1)?\/tool_router\/session$/.test(url.pathname) && context?.kind === "setup")
    return "setup";
  if (/^\/api\/v3(?:\.1)?\/tool_router\/session\/[a-zA-Z0-9_-]+\/execute$/.test(url.pathname)) {
    const kind = { COMPOSIO_SEARCH_WEB: "search", COMPOSIO_SEARCH_FETCH_URL_CONTENT: "fetch" }[
      body.tool_slug
    ];
    if (kind && context?.kind === kind) return kind;
  }
  throw new CaptureStop("unsafe_request");
}

function publicResult(value, approval, secrets) {
  if (!approval?.allowPublicResult) throw new CaptureStop("private_export");
  const text = json(value);
  if (
    !text ||
    secrets.some((secret) => secret && text.includes(secret)) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(
      text,
    )
  )
    throw new CaptureStop("private_export");
  const visit = (item) => {
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry);
      return;
    }
    if (item && typeof item === "object") {
      for (const [key, entry] of Object.entries(item)) {
        if (/password|secret|credential|api.?key|authorization|cookie|access.?token/i.test(key))
          throw new CaptureStop("private_export");
        visit(entry);
      }
    } else if (typeof item === "string") {
      if (secrets.some((secret) => secret && item.includes(secret)))
        throw new CaptureStop("private_export");
      for (const match of item.matchAll(/https?:\/\/[^\s"<>]+/g)) {
        const url = new URL(match[0]);
        if (
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !approval.allowedSourceOrigins?.includes(url.origin)
        )
          throw new CaptureStop("private_export");
      }
    }
  };
  visit(value);
  return text;
}

async function auditDirectory(directory) {
  const names = (await readdir(join(directory, "events"))).sort();
  const reservations = new Map();
  for (const name of names) {
    assert(/^\d{6}\.json$/.test(name), "Invalid capture journal.");
    const event = JSON.parse(await readFile(join(directory, "events", name), "utf8"));
    if (event.type === "reserved") {
      assert(
        !reservations.has(event.attemptId) && safeInteger(event.reservationNanoUsd),
        "Invalid reservation journal.",
      );
      reservations.set(event.attemptId, event.reservationNanoUsd);
    } else if (event.type === "settled") {
      assert(
        reservations.has(event.attemptId) && safeInteger(event.chargedNanoUsd),
        "Invalid settlement journal.",
      );
      // Exactly one final settlement, including known usage on malformed/failed responses.
      assert(!reservations.has(`settled:${event.attemptId}`), "Duplicate settlement.");
      reservations.set(`settled:${event.attemptId}`, event.chargedNanoUsd);
    }
  }
  let exposureNanoUsd = 0;
  for (const [key, amount] of reservations)
    if (!key.startsWith("settled:"))
      exposureNanoUsd += reservations.get(`settled:${key}`) ?? amount;
  assert(safeInteger(exposureNanoUsd), "Invalid exposure journal.");
  return exposureNanoUsd;
}

export async function readCapture(directory) {
  const bytes = await readFile(join(directory, "manifest.json"));
  const seal = await readFile(join(directory, "seal.sha256"), "utf8");
  assert(digest(bytes) === seal, "Capture manifest integrity failure.");
  const manifest = JSON.parse(bytes);
  assert(manifest.version === 1 && manifest.mode === "mock-only", "Unsupported capture package.");
  assert(
    Array.isArray(manifest.files) &&
      new Set(manifest.files.map(([name]) => name)).size === manifest.files.length,
    "Duplicate capture references.",
  );
  for (const [name, hash] of manifest.files) {
    assert(
      name === "result.json" || /^events\/\d{6}\.json$/.test(name),
      "Unsafe capture file reference.",
    );
    assert(
      digest(await readFile(join(directory, name))) === hash,
      "Capture file integrity failure.",
    );
  }
  assert(
    (await auditDirectory(directory)) === manifest.exposureNanoUsd,
    "Capture accounting mismatch.",
  );
  const recordedEvents = manifest.files
    .filter(([name]) => name.startsWith("events/"))
    .map(([name]) => name.slice(7))
    .sort();
  assert(
    json(recordedEvents) === json((await readdir(join(directory, "events"))).sort()),
    "Capture journal references changed.",
  );
  if (manifest.exported)
    assert(
      manifest.files.some(([name]) => name === "result.json"),
      "Unbound result export.",
    );
  const result =
    manifest.status === "completed" && manifest.exported
      ? JSON.parse(await readFile(join(directory, "result.json"), "utf8"))
      : null;
  return { manifest, result, manifestSha256: seal };
}

/** Invoked only in a dedicated opt-in worker with an explicitly supplied mocked transport. */
export async function captureResearch({
  directory,
  policy: suppliedPolicy,
  transport,
  execute,
  validateResult,
  approval,
  secrets = [],
  metadata = {},
}) {
  assert(!active, "Concurrent capture scopes in one process are forbidden.");
  const policy = policyOf(suppliedPolicy);
  assert(
    typeof directory === "string" &&
      directory.length > 0 &&
      Array.isArray(secrets) &&
      secrets.every((value) => typeof value === "string"),
    "Invalid capture boundary options.",
  );
  assert(
    Object.keys(metadata).every((key) =>
      ["sourceHashes", "sdkVersions", "modelSettings"].includes(key),
    ),
    "Unsupported capture metadata.",
  );
  if (metadata.sourceHashes)
    assert(
      Array.isArray(metadata.sourceHashes) &&
        metadata.sourceHashes.every(
          ([path, hash]) =>
            /^src\/[a-zA-Z0-9/_.-]+\.ts$/.test(path) &&
            !path.includes("..") &&
            /^[a-f0-9]{64}$/.test(hash),
        ),
      "Invalid source provenance.",
    );
  if (metadata.sdkVersions)
    assert(
      Object.entries(metadata.sdkVersions).every(
        ([name, version]) =>
          ["@google/genai", "@composio/core"].includes(name) &&
          /^[a-zA-Z0-9._-]{1,50}$/.test(version),
      ),
      "Invalid SDK provenance.",
    );
  if (metadata.modelSettings)
    assert(
      Object.keys(metadata.modelSettings).sort().join(",") ===
        "generation,maxResearchSteps,model" &&
        /^[a-zA-Z0-9._-]{1,100}$/.test(metadata.modelSettings.model) &&
        safeInteger(metadata.modelSettings.maxResearchSteps) &&
        metadata.modelSettings.generation === "unchanged-agent-defaults",
      "Invalid model provenance.",
    );
  assert(
    typeof transport === "function" &&
      typeof execute === "function" &&
      typeof validateResult === "function",
  );
  active = true;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  directory = resolve(directory);
  let lock;
  let root;
  let originalFetch;
  const originalConsole = new Map();
  const jobs = new Set();
  const context = new AsyncLocalStorage();
  const salt = randomBytes(32); // Not persisted: raw prompts/queries cannot be dictionary-tested from hashes.
  const identity = (value) => createHmac("sha256", salt).update(json(value)).digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new CaptureStop("timeout")),
    policy.overallTimeoutMs,
  );
  let closed = false;
  let fatal = null;
  let sequence = 0;
  let callSequence = 0;
  let queue = Promise.resolve();
  let prior = nano(policy.priorExposureUsd);
  let exposure = 0;
  const counts = { model: 0, search: 0, fetch: 0, setup: 0 };
  let blockedMaintenanceRequests = 0;
  const attempts = [];
  const events = [];
  const serialized = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  const check = () => {
    if (closed) throw new CaptureStop("closed");
    if (fatal) throw fatal;
    if (controller.signal.aborted) throw new CaptureStop("timeout");
  };
  const event = async (value) => {
    const name = `events/${String(++sequence).padStart(6, "0")}.json`;
    const bytes = json(value);
    try {
      await immutable(join(root, name), bytes);
    } catch {
      fatal = new CaptureStop("persistence");
      throw fatal;
    }
    events.push([name, digest(bytes)]);
  };
  const bounded = (promise, signal) =>
    new Promise((resolvePromise, reject) => {
      if (signal.aborted) {
        reject(new CaptureStop("timeout"));
        return;
      }
      const abort = () => reject(new CaptureStop("timeout"));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(promise)
        .then(resolvePromise, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  try {
    await mkdir(directory, { recursive: true });
    lock = await open(join(directory, "budget.lock"), "wx");
    const policyBytes = json(policy);
    try {
      await immutable(join(directory, "policy.json"), policyBytes);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      assert(
        (await readFile(join(directory, "policy.json"), "utf8")) === policyBytes,
        "Existing capture policy cannot be reset or changed.",
      );
    }
    for (const name of await readdir(directory)) {
      if (!/^capture-[a-f0-9-]+$/.test(name)) continue;
      const path = join(directory, name);
      // Sealed evidence must verify; incomplete/crashed journals retain their reservations.
      try {
        await readFile(join(path, "seal.sha256"));
        await readCapture(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      prior += await auditDirectory(path);
    }
    assert(prior <= nano(policy.capUsd), "Retained mock exposure already exceeds cap.");
    root = join(directory, `capture-${randomUUID()}`);
    await mkdir(join(root, "events"), { recursive: true });
    const guardedFetch = async (input, init = {}) => {
      check();
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (
        url.origin === "https://registry.npmjs.org" &&
        url.pathname === "/@composio/core/latest"
      ) {
        blockedMaintenanceRequests++;
        throw new CaptureStop("unsafe_request"); // Optional SDK upgrade probe; never dispatched or billed.
      }
      const bodyText = init.body ?? (input instanceof Request ? await input.clone().text() : "");
      if (typeof bodyText !== "string" || Buffer.byteLength(bodyText) > policy.maxRequestBytes) {
        fatal = new CaptureStop("request_limit");
        throw fatal;
      }
      let body;
      let kind;
      const call = context.getStore();
      try {
        body = JSON.parse(bodyText);
        kind = requestKind(url, body, init.method ?? input.method ?? "GET", call);
      } catch {
        fatal = new CaptureStop("unsafe_request");
        throw fatal;
      }
      const requestId = identity({ route: kind, path: url.pathname, body }); // No headers/query/API key persisted.
      const entry = await serialized(async () => {
        check();
        const count =
          kind === "model"
            ? counts.model
            : kind === "setup"
              ? counts.setup
              : counts.search + counts.fetch;
        const limit =
          kind === "model"
            ? policy.maxModelAttempts
            : kind === "setup"
              ? policy.maxSetupAttempts
              : policy.maxToolAttempts;
        if (count >= limit) {
          fatal = new CaptureStop("attempt_limit");
          throw fatal;
        }
        const usd =
          kind === "model"
            ? (policy.inputTokenCeiling * policy.inputUsdPerMillion +
                policy.outputTokenCeiling * policy.outputUsdPerMillion) /
              1e6
            : kind === "setup"
              ? policy.setupAttemptUsd
              : policy.toolAttemptUsd;
        const reservationNanoUsd = nano(usd);
        if (prior + exposure + reservationNanoUsd > nano(policy.capUsd)) {
          fatal = new CaptureStop("budget_exhausted");
          throw fatal;
        }
        const item = {
          attemptId: randomUUID(),
          kind,
          callId: call.id,
          requestId,
          reservationNanoUsd,
          startedAt: new Date().toISOString(),
        };
        await event({ type: "reserved", ...item }); // Durable before dispatch; crashes never create free attempts.
        counts[kind]++;
        exposure += reservationNanoUsd;
        attempts.push(item);
        return item;
      });
      const began = performance.now();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(policy.attemptTimeoutMs),
        ...(init.signal ? [init.signal] : []),
      ]);
      let usage = null;
      let status = null;
      let modelVersion = null;
      let response;
      let error = null;
      let responseIdentity = null;
      let toolFailed = false;
      let structuredTextSyntax = "unavailable";
      try {
        check();
        response = await bounded(transport(input, { ...init, signal }), signal);
        status = response.status;
        const text = await bounded(response.clone().text(), signal);
        responseIdentity = identity({ text });
        if (Buffer.byteLength(text) > policy.maxResponseBytes)
          throw new CaptureStop("request_limit");
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          value = null;
        }
        toolFailed = kind !== "model" && Boolean(value?.error || value?.successful === false);
        if (kind === "model") {
          const parts = value?.candidates?.[0]?.content?.parts;
          if (
            body.generationConfig?.responseMimeType === "application/json" &&
            Array.isArray(parts)
          ) {
            const text = parts
              .filter((part) => !part.thought && typeof part.text === "string")
              .map((part) => part.text)
              .join("");
            try {
              JSON.parse(text);
              structuredTextSyntax = "valid_json";
            } catch {
              structuredTextSyntax = "malformed_json";
            }
          }
          usage = reportedUsage(value, policy);
          if (
            typeof value?.modelVersion === "string" &&
            /^[a-zA-Z0-9._-]{1,100}$/.test(value.modelVersion) &&
            !secrets.some((s) => s && value.modelVersion.includes(s))
          )
            modelVersion = value.modelVersion;
          if (
            usage &&
            (usage.input > policy.inputTokenCeiling ||
              usage.output + usage.thinking > policy.outputTokenCeiling)
          )
            throw new CaptureStop("usage_overrun");
        }
      } catch (caught) {
        error = caught;
      }
      await serialized(async () => {
        const chargedNanoUsd = usage
          ? Math.max(
              usage.costNanoUsd,
              error?.code === "usage_overrun" ? entry.reservationNanoUsd : 0,
            )
          : entry.reservationNanoUsd;
        const record = {
          type: "settled",
          attemptId: entry.attemptId,
          chargedNanoUsd,
          usage,
          modelVersion,
          httpStatus: status,
          elapsedMs: performance.now() - began,
          failure: error
            ? failure(error)
            : status >= 400
              ? `http_${status}`
              : toolFailed
                ? "tool_error"
                : null,
          usageKnown: usage !== null,
          responseIdentity,
          structuredTextSyntax,
        };
        await event(record);
        exposure += chargedNanoUsd - entry.reservationNanoUsd;
        Object.assign(entry, record);
      });
      if (
        error instanceof CaptureStop &&
        ["usage_overrun", "usage_invalid", "request_limit", "timeout"].includes(error.code)
      )
        fatal = error;
      if (error) throw error;
      return response; // Original SDK handles status/body and its own retries, unchanged.
    };
    const fetchBoundary = (...args) => {
      // Preserve original provider error objects for the agent/SDK retry predicates.
      // Only the recorded failure enum is sanitized; raw errors never become evidence.
      const promise = guardedFetch(...args);
      jobs.add(promise);
      promise.finally(() => jobs.delete(promise)).catch(() => {});
      return promise;
    };
    const call = (kind, operation) => {
      check();
      return context.run({ kind, id: `call-${++callSequence}` }, operation);
    };
    // Dedicated worker only: the Composio SDK captures global fetch at construction.
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchBoundary;
    for (const name of ["log", "warn", "error", "info", "debug", "trace"]) {
      originalConsole.set(name, console[name]);
      console[name] = () => {};
    }
    const boundary = {
      fetch: fetchBoundary,
      setup: (fn) => call("setup", fn),
      gemini: (gemini) => ({
        ...gemini,
        client: {
          models: {
            generateContent: (request) =>
              call("model", () =>
                gemini.client.models.generateContent({
                  ...request,
                  config: {
                    ...request.config,
                    httpOptions: { ...request.config?.httpOptions, fetch: fetchBoundary },
                  },
                }),
              ),
          },
        },
      }),
      tools: (tools) => ({
        search: (query) => call("search", () => tools.search(query)),
        fetchUrl: (url) => call("fetch", () => tools.fetchUrl(url)),
      }),
      log: () => {},
    };
    let result = null;
    let status = "completed";
    let errorCode = null;
    try {
      result = await bounded(
        Promise.resolve().then(() => execute(boundary)),
        controller.signal,
      );
      check();
      result = validateResult(result);
      assert(
        !result || typeof result.then !== "function",
        "Export schema validation must be synchronous.",
      );
    } catch (error) {
      status = "failed";
      errorCode = failure(fatal ?? error);
    }
    // No new transport work may start after the agent returns, including fire-and-forget work.
    closed = true;
    controller.abort();
    if (status === "completed" && jobs.size > 0) {
      status = "failed";
      errorCode = "unfinished_requests";
    }
    await Promise.allSettled([...jobs]);
    await queue;
    if (fatal && status === "completed") {
      status = "failed";
      errorCode = failure(fatal);
    }
    let exported = false;
    if (status === "completed" && approval?.allowPublicResult) {
      try {
        const bytes = publicResult(result, approval, secrets);
        await immutable(join(root, "result.json"), bytes);
        events.push(["result.json", digest(bytes)]);
        exported = true;
      } catch (error) {
        status = "failed";
        errorCode = failure(error);
      }
    }
    closed = true;
    const manifest = {
      version: 1,
      producerSha256: digest(await readFile(new URL(import.meta.url))),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      mode: "mock-only",
      status,
      failure: errorCode,
      exported,
      completedAt: new Date().toISOString(),
      startedAt,
      elapsedMs: performance.now() - started,
      files: events,
      attempts,
      counts,
      blockedMaintenanceRequests,
      exposureNanoUsd: exposure,
      priorExposureNanoUsd: prior,
      cumulativeExposureNanoUsd: prior + exposure,
      capNanoUsd: nano(policy.capUsd),
      toolBilling: "unknown; configured mock allowances are not real Composio prices",
      ...metadata,
    };
    // Caller metadata is restricted to an explicit non-sensitive provenance subset.
    assert(
      Object.keys(metadata).every((key) =>
        ["sourceHashes", "sdkVersions", "modelSettings"].includes(key),
      ),
      "Unsupported capture metadata.",
    );
    const bytes = json(manifest);
    if (secrets.some((secret) => secret && bytes.includes(secret)))
      throw new CaptureStop("private_export");
    await immutable(join(root, "manifest.json"), bytes);
    await immutable(join(root, "seal.sha256"), digest(bytes));
    return { directory: root, manifest, result: exported ? result : null };
  } finally {
    closed = true;
    clearTimeout(timer);
    controller.abort();
    if (originalFetch) globalThis.fetch = originalFetch;
    for (const [name, method] of originalConsole) console[name] = method;
    if (lock) {
      await lock.close();
      await unlink(join(directory, "budget.lock"));
    }
    active = false;
  }
}
