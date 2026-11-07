import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  decodeArtifact,
  evaluateRunPair,
  FileArtifactStore,
  runWorkflow,
} from "../../dist/index.js";
import { captureResearch, readCapture } from "../../examples/composio-capture/capture.mjs";
import { MOCK_POLICY } from "../../examples/composio-capture/mock-provider.mjs";
import {
  openProject,
  prepareProject,
  SOURCE_FILES,
  sha256,
  treeHashes,
} from "../../examples/composio-offline/prepare.mjs";

const [scenario, rootArg, sourceArg] = process.argv.slice(2);
const root = resolve(rootArg);
const sensitive = "sensitive-fixture-canary";
const urls = {
  model: "https://generativelanguage.googleapis.com/v1beta/models/mock-model:generateContent",
  session: "https://backend.composio.dev/api/v3.1/tool_router/session",
  tool: "https://backend.composio.dev/api/v3.1/tool_router/session/mock-session/execute",
};
const policy = { ...MOCK_POLICY };
if (scenario === "timeout" || scenario === "late-timeout") policy.attemptTimeoutMs = 15;
if (scenario === "overall-timeout") policy.overallTimeoutMs = 15;
if (scenario === "concurrent-requests") policy.maxModelAttempts = 1;
if (["budget", "cumulative-budget", "crash-reservation"].includes(scenario))
  policy.capUsd = policy.priorExposureUsd + 0.004;
if (scenario === "request-limit") policy.maxRequestBytes = 10;
let calls = 0;
const rawCalls = [];
const response = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const usage = {
  promptTokenCount: 100,
  candidatesTokenCount: 50,
  thoughtsTokenCount: 20,
  cachedContentTokenCount: 10,
  totalTokenCount: 170,
};
const transport = async (url, init) => {
  calls++;
  rawCalls.push(JSON.parse(init.body));
  if (scenario === "timeout")
    return new Promise((_, reject) =>
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
    );
  if (scenario === "late-timeout") await new Promise((done) => setTimeout(done, 40));
  if (scenario === "concurrent-requests" || scenario === "same-process-concurrency")
    await new Promise((done) => setTimeout(done, 10));
  if ((scenario === "hidden-retry" || scenario === "failed-usage") && calls === 1)
    return response({ error: { message: sensitive } }, 503);
  if (scenario === "known-failed-usage" && calls === 1)
    return response({ error: { message: sensitive }, usageMetadata: usage }, 503);
  if (scenario === "provider-exception") throw new Error(`private error ${sensitive}`);
  if (url === urls.tool)
    return response({
      data: { private: sensitive },
      error: scenario === "tool-error" ? sensitive : null,
    });
  const value = {
    candidates: [
      { content: { parts: [{ text: scenario === "malformed" ? "{bad" : '{"ok":true}' }] } },
    ],
    modelVersion: "mock-version",
  };
  if (!["unknown-usage", "failed-usage", "budget", "cumulative-budget"].includes(scenario))
    value.usageMetadata =
      scenario === "invalid-usage"
        ? { ...usage, totalTokenCount: -1 }
        : scenario === "overrun"
          ? { ...usage, promptTokenCount: 5000, totalTokenCount: 5070 }
          : usage;
  return response(value);
};
const client = {
  model: "mock-model",
  client: {
    models: {
      generateContent: async (request) => {
        // SDK mock contains a retry loop beneath generateContent, not an agent rewrite.
        let received;
        for (let attempt = 0; attempt < (scenario === "hidden-retry" ? 2 : 1); attempt++) {
          received = await request.config.httpOptions.fetch(urls.model, {
            method: "POST",
            body: JSON.stringify({
              contents: request.contents,
              generationConfig: { responseMimeType: request.config.responseMimeType },
            }),
            headers: { "x-goog-api-key": sensitive },
          });
          if (received.status !== 503) break;
        }
        const value = await received.json();
        if (!received.ok) {
          const error = new Error(sensitive);
          error.status = received.status;
          throw error;
        }
        return { text: value.candidates[0].content.parts[0].text };
      },
    },
  },
};
const request = {
  model: "mock-model",
  contents: sensitive,
  config: { responseMimeType: "application/json" },
};
let rejectedConcurrent = false;
const execute = async (boundary) => {
  const model = boundary.gemini(client);
  const generate = () => model.client.models.generateContent(request);
  if (scenario === "worker-hold") {
    await writeFile(join(root, "ready"), "ready", { flag: "wx" });
    while (true) {
      try {
        await readFile(join(root, "release"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
  }
  if (scenario === "same-process-concurrency") {
    try {
      await captureResearch({
        directory: join(root, "other"),
        policy,
        transport,
        execute: async () => ({}),
        validateResult: (v) => v,
      });
    } catch {
      rejectedConcurrent = true;
    }
  }
  if (scenario === "overall-timeout") return new Promise(() => {});
  if (scenario === "unfinished-requests") {
    void generate().catch(() => {});
    return { note: "approved public result" };
  }
  if (scenario === "unsafe-tool")
    return boundary
      .tools({
        search: () =>
          boundary.fetch(urls.tool, {
            method: "POST",
            body: JSON.stringify({ tool_slug: "SEND_EMAIL", arguments: { private: sensitive } }),
          }),
      })
      .search("query");
  if (scenario === "tool-error" || scenario === "tool-retries") {
    const tools = boundary.tools({
      search: async () => {
        for (let i = 0; i < (scenario === "tool-retries" ? 2 : 1); i++) {
          const value = await (
            await boundary.fetch(urls.tool, {
              method: "POST",
              body: JSON.stringify({
                tool_slug: "COMPOSIO_SEARCH_WEB",
                arguments: { query: sensitive },
              }),
            })
          ).json();
          if (value.error) throw new Error(sensitive);
        }
        return {};
      },
    });
    await tools.search("private query");
  }
  if (scenario === "concurrent-requests") await Promise.all([generate(), generate()]);
  else {
    const output = await generate();
    JSON.parse(output.text);
    if (scenario === "budget" || scenario === "reconcile") await generate();
  }
  if (scenario === "private-result") return { note: sensitive };
  if (scenario === "private-url")
    return { evidence: [{ url: "https://public.example/docs?api_key=private" }] };
  if (scenario === "private-email") return { note: "name@example.com" };
  if (scenario === "adopt")
    return JSON.parse(await readFile(join(sourceArg, "results/salesforce.json"), "utf8"));
  return { note: "approved public result" };
};
let metadata = {};
if (scenario === "adopt") {
  const paths = [
    ...SOURCE_FILES,
    "agent/gemini-model.ts",
    "agent/prompt.ts",
    "agent/evidence-mapping.ts",
  ];
  metadata = {
    sourceHashes: await Promise.all(
      paths.map(async (file) => [
        `src/${file}`,
        sha256(await readFile(join(sourceArg, "src", file))),
      ]),
    ),
  };
}
const options = {
  directory: join(root, "budget"),
  policy,
  transport,
  execute,
  validateResult: (v) => v,
  secrets: [sensitive],
  approval:
    scenario === "metadata-only"
      ? undefined
      : {
          allowPublicResult: true,
          allowedSourceOrigins: ["https://public.example", "https://example.com"],
        },
  metadata,
};
let result;
if (scenario === "crash-reservation") {
  const journal = join(options.directory, "capture-deadbeef/events");
  await mkdir(journal, { recursive: true });
  await writeFile(
    join(journal, "000001.json"),
    JSON.stringify({ type: "reserved", attemptId: "orphan", reservationNanoUsd: 3788800 }),
  );
}
if (scenario === "cross-process-lock" || scenario === "worker-contend") {
  await mkdir(options.directory, { recursive: true });
  if (scenario === "cross-process-lock")
    await writeFile(join(options.directory, "budget.lock"), "held");
  try {
    await captureResearch(options);
  } catch {
    result = { lockRejected: true };
  }
} else {
  result = await captureResearch(options);
  const verified = await readCapture(result.directory);
  assert.equal(verified.manifest.exposureNanoUsd, result.manifest.exposureNanoUsd);
  if (scenario === "late-timeout" || scenario === "unfinished-requests") {
    const before = await treeHashes(result.directory);
    await new Promise((done) => setTimeout(done, 70));
    assert.deepEqual(await treeHashes(result.directory), before);
  }
  if (scenario === "cumulative-budget") {
    const first = result;
    result = await captureResearch(options);
    result.previous = first.manifest;
  }
  if (scenario === "policy-reset") {
    try {
      await captureResearch({ ...options, policy: { ...policy, priorExposureUsd: 0 } });
    } catch {
      result.resetRejected = true;
    }
  }
  if (scenario === "immutability") {
    const before = await treeHashes(result.directory);
    await captureResearch(options);
    assert.deepEqual(await treeHashes(result.directory), before);
    const corrupt = join(root, "corrupt-copy");
    await cp(result.directory, corrupt, { recursive: true });
    await writeFile(join(corrupt, "result.json"), '{"tampered":true}');
    try {
      await readCapture(corrupt);
    } catch {
      result.corruptionRejected = true;
    }
  }
  if (scenario === "adopt") {
    const project = await prepareProject(sourceArg, "salesforce.json", join(root, "adopted"), {
      capturePackage: result.directory,
    });
    const workflow = await openProject(project.root);
    const input = { target: "Salesforce", refresh: "mock-captured-v1", publish: false };
    const baseline = await runWorkflow(workflow, {
      inputs: input,
      baseline: null,
      environment: {},
    });
    const candidate = await runWorkflow(workflow, {
      inputs: input,
      baseline: { runId: baseline.manifest.id },
      environment: {},
    });
    const artifacts = new FileArtifactStore(candidate.storageDir);
    const stage = candidate.manifest.stages.find((s) => s.stageId === "analyze");
    const analysis = decodeArtifact(await artifacts.get(stage.outputArtifactHash));
    const suite = (await import(pathToFileURL(join(project.root, "evaluation.mjs")).href)).default;
    const evaluation = await evaluateRunPair(suite, {
      baselineRunId: baseline.manifest.id,
      candidateRunId: candidate.manifest.id,
      criteria: { analysisText: analysis.text },
    });
    result.adopted = {
      root: project.root,
      executionStatus: candidate.manifest.executionStatus,
      stages: candidate.manifest.stages,
      evaluation,
      provenance: JSON.parse(await readFile(join(project.root, "capture/provenance.json"))),
    };
    const copied = join(root, "changed-adoption");
    await cp(project.root, copied, { recursive: true });
    await writeFile(join(copied, "capture/research-capture.json"), "{}");
    const corrupted = await runWorkflow(await openProject(copied), {
      inputs: input,
      baseline: { runId: baseline.manifest.id },
      environment: {},
    });
    result.adopted.changedCaptureRejected = corrupted.manifest.executionStatus === "failed";
  }
  const texts = await Promise.all(
    (await readdir(join(result.directory, "events"))).map((name) =>
      readFile(join(result.directory, "events", name), "utf8"),
    ),
  );
  texts.push(await readFile(join(result.directory, "manifest.json"), "utf8"));
  assert(
    !texts.some(
      (text) =>
        text.includes(sensitive) ||
        text.includes("private query") ||
        text.includes("private error"),
    ),
  );
}
console.log(
  JSON.stringify({
    ...result,
    calls,
    rejectedConcurrent,
    requestUnchanged:
      JSON.stringify(request) ===
      JSON.stringify({
        model: "mock-model",
        contents: sensitive,
        config: { responseMimeType: "application/json" },
      }),
    dispatchedBodies: rawCalls.length,
  }),
);
