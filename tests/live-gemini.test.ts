import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Preserve historical Flash/$0.10 regression coverage alongside the approved Lite profile.
async function fixture(fastRetries = false, capUsd = 0.1, modelProfile = "flash") {
  const root = await mkdtemp(join(tmpdir(), "abilitybench-gemini-offline-"));
  roots.push(root);
  const sdk = pathToFileURL(resolve("dist/index.js")).href;
  for (const name of ["adapter.mjs", "run.mjs"]) {
    const source = await readFile(resolve("examples/live-gemini", name), "utf8");
    let imported = source
      .replace('"../../dist/index.js"', JSON.stringify(sdk))
      .replace("export const BUDGET_CAP_USD = 0.11;", `export const BUDGET_CAP_USD = ${capUsd};`);
    if (modelProfile === "flash" && name === "adapter.mjs") {
      imported = imported
        .replace('model: "gemini-3.5-flash-lite"', 'model: "gemini-3.8-flash"')
        .replace("inputPerMillion: 0.3,", "inputPerMillion: 0.75,")
        .replace("cachedInputPerMillion: 0.03,", "cachedInputPerMillion: 0.075,")
        .replace("outputPerMillion: 2.5,", "outputPerMillion: 3.75,");
    }
    await writeFile(
      join(root, name),
      fastRetries && name === "run.mjs"
        ? imported.replace("await delay(waitMs);", "await Promise.resolve();")
        : imported,
    );
  }
  return root;
}

describe("live Gemini adapter offline guardrails", () => {
  it("runs the unchanged 5/2/5 protocol with Lite pricing and retains historical Flash exposure", async () => {
    const root = await fixture(false, 0.11, "lite");
    await mkdir(join(root, ".abilitybench", "experiment-flash"), { recursive: true });
    const previous = JSON.stringify({
      settings: { model: "gemini-3.8-flash", maxOutputTokens: 1024 },
      pricing: { inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 3.75 },
      budget: { attempts: 1 },
      ledger: [{ status: "failed", usage: null }],
    });
    await writeFile(join(root, ".abilitybench", "experiment-flash", "usage-ledger.json"), previous);
    await writeFile(
      join(root, "lite.mjs"),
      `
      process.env.GEMINI_API_KEY='offline-key';let calls=0;
      globalThis.fetch=async(url,options)=>{if(!url.endsWith('/gemini-3.5-flash-lite:generateContent'))throw new Error('wrong model');const body=JSON.parse(options.body);if(body.generationConfig.maxOutputTokens!==1024||body.generationConfig.thinkingConfig.thinkingLevel!=='LOW')throw new Error('changed allowances');calls++;return new Response(JSON.stringify({modelVersion:'mock-lite',candidates:[{finishReason:'STOP',content:{parts:[{text:'Answer '+calls}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:10,totalTokenCount:130}}),{status:200});};
      await import('./run.mjs');if(calls!==12||process.exitCode)throw new Error('protocol failed');
    `,
    );
    const result = spawnSync(process.execPath, [join(root, "lite.mjs")], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const name = (await readdir(join(root, ".abilitybench"))).find(
      (item) => item.startsWith("experiment-") && item !== "experiment-flash",
    );
    const report = JSON.parse(
      await readFile(join(root, ".abilitybench", name ?? "missing", "results.json"), "utf8"),
    );
    expect(report.settings.model).toBe("gemini-3.5-flash-lite");
    expect(
      report.measurements.map(
        (value: { generationSuccesses: number }) => value.generationSuccesses,
      ),
    ).toEqual([5, 2, 5]);
    expect(report.priorReservedUsd).toBeCloseTo(0.006912, 12);
    expect(report.grossNewReservationsUsd).toBeCloseTo(0.0454656, 12);
    expect(report.totalEstimatedCostUsd).toBeCloseTo((12 * (100 * 0.3 + 30 * 2.5)) / 1_000_000, 12);
    expect(report.baselineUnchanged).toBe(true);
    expect(
      await readFile(join(root, ".abilitybench", "experiment-flash", "usage-ledger.json"), "utf8"),
    ).toBe(previous);
  });
  it("uses the approved $0.11 default without removing reservation or protocol guards", async () => {
    const root = await fixture(false, 0.11);
    const adapter = pathToFileURL(join(root, "adapter.mjs")).href;
    await writeFile(
      join(root, "approved-cap.mjs"),
      `
      import assert from 'node:assert/strict';import {Budget,BUDGET_CAP_USD,requestReservation} from ${JSON.stringify(adapter)};
      assert.equal(BUDGET_CAP_USD,.11);
      const budget=new Budget(.02314875);budget.preflight();
      budget.reserve({});assert.throws(()=>budget.preflight(),/Complete validation/);
      const spent=new Budget(.109);assert.throws(()=>spent.reserve({}),/reservation/);assert.equal(spent.attempts,0);
      assert.ok(.02314875+12*requestReservation()<.11);
    `,
    );
    const result = spawnSync(process.execPath, [join(root, "approved-cap.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
  });
  it("bounds exponential delays and honors seconds/date Retry-After without retrying early", async () => {
    const root = await fixture();
    const adapter = pathToFileURL(join(root, "adapter.mjs")).href;
    await writeFile(
      join(root, "delays.mjs"),
      `
      import assert from 'node:assert/strict'; import {retryDelay} from ${JSON.stringify(adapter)};
      const now=Date.parse('2026-10-13T10:00:00Z');
      assert.equal(retryDelay(1,null,now,()=>0),1000);
      assert.equal(retryDelay(2,null,now,()=>0),2000);
      assert.equal(retryDelay(1,'5',now,()=>0),5000);
      assert.equal(retryDelay(2,'Tue, 13 Oct 2026 10:00:08 GMT',now,()=>0),8000);
      assert.equal(retryDelay(1,'Tue, 13 Oct 2026 09:59:00 GMT',now,()=>0),1000);
      assert.equal(retryDelay(1,'invalid',now,()=>0),1000);
      assert.throws(()=>retryDelay(1,'31',now,()=>0),/bounded wait/);
      assert.throws(()=>retryDelay(1,'Tue, 13 Oct 2026 10:01:00 GMT',now,()=>0),/bounded wait/);
      assert.throws(()=>retryDelay(3,null,now,()=>0),/retry limit/);
    `,
    );
    const result = spawnSync(process.execPath, [join(root, "delays.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("recovers from a 503 without completing that failed attempt or hiding unknown costs", async () => {
    const root = await fixture(true);
    await writeFile(
      join(root, "recovery.mjs"),
      `
      process.env.GEMINI_API_KEY='offline-key'; let calls=0;
      globalThis.fetch=async()=>{calls++; if(calls===1)return new Response(JSON.stringify({error:{status:'UNAVAILABLE',message:'High demand.'}}),{status:503,headers:{'Retry-After':'2'}});return new Response(JSON.stringify({modelVersion:'mock',candidates:[{finishReason:'STOP',content:{parts:[{text:'Answer '+calls}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:10,totalTokenCount:130}}),{status:200});};
      await import('./run.mjs'); if(calls!==13||process.exitCode)throw new Error('recovery failed');
    `,
    );
    const result = spawnSync(process.execPath, [join(root, "recovery.mjs")], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const names = await readdir(join(root, ".abilitybench"));
    const evidence = join(
      root,
      ".abilitybench",
      names.find((name) => name.startsWith("experiment-")) ?? "missing",
    );
    const ledger = JSON.parse(await readFile(join(evidence, "usage-ledger.json"), "utf8"));
    expect(ledger.ledger[0]).toMatchObject({
      status: "failed",
      httpStatus: 503,
      usage: null,
      retryDelayMs: 2000,
    });
    expect(ledger.ledger[1]).toMatchObject({ status: "completed", attempt: 2 });
    const report = JSON.parse(await readFile(join(evidence, "results.json"), "utf8"));
    expect(report.status).toBe("completed");
    expect(report.providerFailures).toHaveLength(1);
    expect(report.abilityBenchFailures).toEqual([]);
    expect(report.usageComplete).toBe(false);
    expect(report.savingsAreKnownUsageOnly).toBe(true);
    expect(report.savings.baseline.estimatedCostUsd.available).toBe(false);
    expect(report.accountedExposureUsd).toBeCloseTo(0.006912 + report.totalEstimatedCostUsd, 12);
    expect(
      report.measurements.map((value: { generationAttempts: number }) => value.generationAttempts),
    ).toEqual([6, 2, 5]);
    expect(
      report.executionResults.every((value: { status: string }) => value.status === "completed"),
    ).toBe(true);
  });

  it("stops after three 503 attempts and publishes no completed engine run", async () => {
    const root = await fixture(true);
    await writeFile(
      join(root, "unavailable.mjs"),
      `
      process.env.GEMINI_API_KEY='offline-key';let calls=0;
      globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{status:'UNAVAILABLE',message:'Unavailable.'}}),{status:503});};
      await import('./run.mjs');if(calls!==3)throw new Error('unbounded retries');
    `,
    );
    const result = spawnSync(process.execPath, [join(root, "unavailable.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    const names = await readdir(join(root, ".abilitybench"));
    const evidence = join(
      root,
      ".abilitybench",
      names.find((name) => name.startsWith("experiment-")) ?? "missing",
    );
    const report = JSON.parse(await readFile(join(evidence, "results.json"), "utf8"));
    expect(report.status).toBe("incomplete");
    expect(report.providerFailures).toHaveLength(3);
    expect(report.executionResults).toEqual([]);
    expect(report.abilityBenchFailures).toEqual([]);
    expect(report.accountedExposureUsd).toBeCloseTo(3 * 0.006912, 12);
    expect(await readdir(join(evidence, "baseline"))).not.toContain(".abilitybench");
  });

  it("releases known reservations, preserves unknown exposure, and fails closed on invalid history", async () => {
    const root = await fixture();
    const adapter = pathToFileURL(join(root, "adapter.mjs")).href;
    await writeFile(
      join(root, "accounting.mjs"),
      `
      import assert from 'node:assert/strict';
      import {Budget, PRICING, SETTINGS, retainedExposure, requestReservation, usageFromResponse} from ${JSON.stringify(adapter)};
      const worst=requestReservation();
      const usage=usageFromResponse({usageMetadata:{promptTokenCount:92,candidatesTokenCount:37,thoughtsTokenCount:588,totalTokenCount:717}});
      const b=new Budget(.006912); b.reserve({}); b.record(usage);
      assert.ok(Math.abs(b.reservedUsd-(.006912+.00241275))<1e-12);
      assert.ok(Math.abs(b.grossReservedUsd-worst)<1e-12);
      assert.throws(()=>b.record(usage), /unsettled/);
      b.reserve({}); b.unknownUsage=true;
      assert.ok(Math.abs(b.reservedUsd-(.006912+.00241275+worst))<1e-12);
      assert.throws(()=>b.reserve({}), /unknown usage/);
      const old={settings:SETTINGS,pricing:PRICING,budget:{attempts:2,priorReservedUsd:.013824,reservedUsd:.027648},ledger:[{status:'completed',usage},{status:'failed',usage:null}]};
      assert.ok(Math.abs(retainedExposure(old)-(.00241275+worst))<1e-12);
      assert.equal(retainedExposure({...old,budget:{attempts:1},ledger:[{status:'dispatched',usage:null}]}),worst);
      assert.equal(retainedExposure({...old,budget:{attempts:1},ledger:[{status:'failed',usage}]}),usage.estimatedCostUsd);
      assert.throws(()=>retainedExposure({...old,budget:{attempts:3}}), /ledger/);
      assert.throws(()=>retainedExposure({...old,ledger:[{status:'completed',usage:{...usage,estimatedCostUsd:0}},{status:'failed',usage:null}]}), /violates/);
      const prior=.00241275+3*worst;
      const guarded=new Budget(prior); assert.throws(()=>guarded.preflight(), /Complete validation/); assert.equal(guarded.attempts,0);
      const exhausted=new Budget(.099); assert.throws(()=>exhausted.reserve({}), /reservation/); assert.equal(exhausted.attempts,0);
      const within=new Budget(.01); within.preflight();
      for(let i=0;i<12;i++){within.reserve({});within.record(usage);assert.ok(within.reservedUsd<=.1);}
      for(let i=12;i<15;i++){within.reserve({});within.record(usage);}
      assert.throws(()=>within.reserve({}), /15-request/);
      const proposed=new Budget(prior,.11); proposed.preflight(); proposed.reserve({});
      assert.throws(()=>proposed.preflight(), /Complete validation/);
    `,
    );
    const result = spawnSync(process.execPath, [join(root, "accounting.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("denies a 503 retry when it would consume remaining protocol headroom", async () => {
    const root = await fixture(true);
    await mkdir(join(root, ".abilitybench", "experiment-prior"), { recursive: true });
    await writeFile(
      join(root, ".abilitybench", "experiment-prior", "usage-ledger.json"),
      JSON.stringify({
        settings: { maxOutputTokens: 1024 },
        pricing: { inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 3.75 },
        budget: { attempts: 2 },
        ledger: [
          { status: "failed", usage: null },
          { status: "failed", usage: null },
        ],
      }),
    );
    await writeFile(
      join(root, "denied.mjs"),
      `process.env.GEMINI_API_KEY='offline-key';let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{}',{status:503});};await import('./run.mjs');if(calls!==1)throw new Error('budget bypass');`,
    );
    const result = spawnSync(process.execPath, [join(root, "denied.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    const name = (await readdir(join(root, ".abilitybench"))).find(
      (item) => item.startsWith("experiment-") && item !== "experiment-prior",
    );
    const report = JSON.parse(
      await readFile(join(root, ".abilitybench", name ?? "missing", "results.json"), "utf8"),
    );
    expect(report.status).toBe("incomplete");
    expect(report.finalFailure.origin).toBe("retry_guard");
    expect(report.providerFailures).toHaveLength(1);
    expect(report.executionResults).toEqual([]);
    expect(report.accountedExposureUsd).toBeCloseTo(0.020736, 12);
  });

  it("separates engine failures from successfully captured provider responses", async () => {
    const root = await fixture(true);
    const path = join(root, "run.mjs");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace(
        "runWorkflow(workflow, options)",
        "Promise.reject(new Error('Synthetic engine failure'))",
      ),
    );
    await writeFile(
      join(root, "engine-failure.mjs"),
      `process.env.GEMINI_API_KEY='offline-key';globalThis.fetch=async()=>new Response(JSON.stringify({modelVersion:'mock',candidates:[{finishReason:'STOP',content:{parts:[{text:'Short answer'}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:10,totalTokenCount:130}}),{status:200});await import('./run.mjs');`,
    );
    const result = spawnSync(process.execPath, [join(root, "engine-failure.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    const name = (await readdir(join(root, ".abilitybench"))).find((item) =>
      item.startsWith("experiment-"),
    );
    const report = JSON.parse(
      await readFile(join(root, ".abilitybench", name ?? "missing", "results.json"), "utf8"),
    );
    expect(report.finalFailure.origin).toBe("abilitybench");
    expect(report.abilityBenchFailures).toHaveLength(1);
    expect(report.providerFailures).toEqual([]);
    expect(report.status).toBe("incomplete");
    expect(report.executionResults).toEqual([]);
  });

  it("accounts explicit retry attempts cumulatively and rejects a retry before fetch when the cap cannot fit", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "retry.mjs"),
      `
      process.env.GEMINI_API_KEY='offline-key'; let calls=0;
      globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{status:'UNAVAILABLE',message:'High demand.'}}),{status:503,headers:{'Retry-After':'31'}});};
      try { await import('./run.mjs'); } catch(error) { console.error(error.message); process.exitCode=1; }
      console.log('fetch-count='+calls);
    `,
    );
    for (let attempt = 1; attempt <= 4; attempt++) {
      const result = spawnSync(process.execPath, [join(root, "retry.mjs")], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`fetch-count=${attempt <= 3 ? 1 : 0}`);
      if (attempt === 4) expect(result.stderr).toContain("Complete validation cannot fit");
    }
    const names = (await readdir(join(root, ".abilitybench"))).filter((name) =>
      name.startsWith("experiment-"),
    );
    expect(names).toHaveLength(3);
    const ledgers = await Promise.all(
      names.map(async (name) =>
        JSON.parse(await readFile(join(root, ".abilitybench", name, "usage-ledger.json"), "utf8")),
      ),
    );
    expect(
      ledgers.map((value) => value.budget.priorReservedUsd).sort((a: number, b: number) => a - b),
    ).toEqual([0, 0.006912, 0.013824]);
    expect(
      ledgers.every(
        (value) => value.ledger[0].httpStatus === 503 && value.ledger[0].usage === null,
      ),
    ).toBe(true);
    expect(await readdir(join(root, ".abilitybench"))).not.toContain("budget.lock");
  });

  it("does not dispatch while another invocation holds the cumulative-budget lock", async () => {
    const root = await fixture();
    await mkdir(join(root, ".abilitybench"));
    await writeFile(join(root, ".abilitybench", "budget.lock"), "");
    await writeFile(
      join(root, "locked.mjs"),
      `process.env.GEMINI_API_KEY='offline-key';globalThis.fetch=()=>{throw new Error('must not dispatch');};await import('./run.mjs');`,
    );
    const result = spawnSync(process.execPath, [join(root, "locked.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("EEXIST");
    expect(await readdir(join(root, ".abilitybench"))).toEqual(["budget.lock"]);
  });

  it("checks canonical request binding, usage math, spend reservation, attempts, and time", async () => {
    const root = await fixture();
    const adapter = pathToFileURL(join(root, "adapter.mjs")).href;
    const source = `
      import assert from 'node:assert/strict';
      import { Budget, digest, outputFromSnapshot, providerFailure, requestBody, SETTINGS, usageFromResponse } from ${JSON.stringify(adapter)};
      assert.match(providerFailure(503, { error: { status: 'UNAVAILABLE', message: 'Service overloaded.' } }, 'secret'), /HTTP 503 \\(UNAVAILABLE\\): Service overloaded/);
      const safe = providerFailure(403, { error: { status: 'PERMISSION_DENIED', message: 'secret https://example.com/?key=secret', details: [{ key: 'secret' }] } }, 'secret');
      assert.ok(!safe.includes('secret')); assert.ok(!safe.includes('example.com'));
      assert.ok(providerFailure(503, null, 'secret').includes('UNKNOWN'));
      const body = requestBody('short prompt', { source: { text: 'synthetic' } });
      const snapshot = { requestHash: digest({ model: SETTINGS.model, body }), text: 'captured answer', modelVersion: 'test-version' };
      assert.equal(outputFromSnapshot(snapshot, body).text, 'captured answer');
      assert.throws(() => outputFromSnapshot(snapshot, requestBody('changed prompt', {})));
      const usage = usageFromResponse({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150, cachedContentTokenCount: 10 } });
      assert.equal(usage.totalTokens, 150);
      assert.ok(Math.abs(usage.estimatedCostUsd - (90 * .75 + 10 * .075 + 50 * 3.75) / 1000000) < 1e-12);
      assert.equal(usageFromResponse({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 150 } }).thinkingTokens, 30);
      for (const value of [{}, { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 90 } }, { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120, cachedContentTokenCount: 101 } }]) assert.throws(() => usageFromResponse(value));
      const budget = new Budget(); for (let i = 0; i < 14; i++) budget.reserve(body);
      assert.ok(budget.reservedUsd < .10); assert.throws(() => budget.reserve(body), /reservation/);
      const oversized = new Budget(); assert.throws(() => oversized.reserve({ text: 'x'.repeat(2049) }), /2,048/); assert.equal(oversized.attempts, 0);
      const unknown = new Budget(); unknown.unknownUsage = true; assert.throws(() => unknown.reserve(body), /unknown usage/);
      const expired = new Budget(); expired.started -= 300001; assert.throws(() => expired.reserve(body), /Five-minute/);
      const spent = new Budget(); spent.reservedUsd = .099; assert.throws(() => spent.reserve(body), /reservation/);
      const carried = new Budget(.099); assert.equal(carried.priorReservedUsd, .099); assert.throws(() => carried.reserve(body), /reservation/);
      assert.throws(() => new Budget(-1), /Invalid prior/);
      const exceeded = new Budget(); exceeded.reserve(body); const excessive = usageFromResponse({usageMetadata:{promptTokenCount:4097,candidatesTokenCount:20,thoughtsTokenCount:30,totalTokenCount:4147}}); assert.throws(() => exceeded.record(excessive), /exceeded/); assert.equal(exceeded.unknownUsage, true);
      console.log('guardrails passed');
    `;
    await writeFile(join(root, "guardrails.mjs"), source);
    const result = spawnSync(process.execPath, [join(root, "guardrails.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("guardrails passed");
  });

  it("runs the complete baseline/incremental/full-control protocol with no network or credential leakage", async () => {
    const root = await fixture();
    const wrapper = `
      process.env.GEMINI_API_KEY = 'offline-test-key-not-for-network';
      process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite';
      let calls = 0;
      globalThis.fetch = async (url, options) => {
        if (url !== 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent' || options.headers['x-goog-api-key'] !== process.env.GEMINI_API_KEY) throw new Error('unexpected request/model');
        calls++;
        return new Response(JSON.stringify({ modelVersion: 'mock-gemini-version', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Synthetic answer number ' + calls }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 10, totalTokenCount: 130 } }), { status: 200 });
      };
      await import('./run.mjs');
      if (calls !== 12 || process.exitCode) throw new Error('protocol failed');
    `;
    await writeFile(join(root, "offline.mjs"), wrapper);
    const result = spawnSync(process.execPath, [join(root, "offline.mjs")], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("offline-test-key-not-for-network");
    const names = await readdir(join(root, ".abilitybench"));
    const evidence = join(root, ".abilitybench", names[0] ?? "missing");
    const report = JSON.parse(await readFile(join(evidence, "results.json"), "utf8")) as {
      baselineUnchanged: boolean;
      measurements: {
        scenario: string;
        generationAttempts: number;
        localCatalogLookupCalls: number;
        providerToolCalls: number;
        stageDecisions: { stageId: string; executionStatus: string }[];
      }[];
    };
    expect(report.baselineUnchanged).toBe(true);
    expect(report.measurements.map((item) => item.generationAttempts)).toEqual([5, 2, 5]);
    expect(report.measurements.map((item) => item.localCatalogLookupCalls)).toEqual([1, 0, 1]);
    expect(report.measurements.every((item) => item.providerToolCalls === 0)).toBe(true);
    const candidate = report.measurements[1];
    expect(
      candidate?.stageDecisions
        .filter((stage) => stage.executionStatus === "reused")
        .map((stage) => stage.stageId),
    ).toEqual(["catalog", "facts", "options", "risks"]);
    for (const file of await readdir(evidence, { recursive: true, withFileTypes: true }))
      if (file.isFile())
        expect(await readFile(join(file.parentPath, file.name), "utf8")).not.toContain(
          "offline-test-key-not-for-network",
        );
  });

  it("reconciles legacy success evidence on an explicit retry without resetting unknown failures", async () => {
    const root = await fixture();
    const oldRoot = join(root, ".abilitybench", "experiment-legacy");
    await mkdir(oldRoot, { recursive: true });
    await writeFile(
      join(oldRoot, "usage-ledger.json"),
      JSON.stringify({
        settings: { maxOutputTokens: 1024 },
        pricing: { inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 3.75 },
        budget: { attempts: 2, reservedUsd: 0.013824 },
        ledger: [
          {
            status: "completed",
            usage: {
              inputTokens: 92,
              outputTokens: 37,
              thinkingTokens: 588,
              cachedInputTokens: 0,
              totalTokens: 717,
              estimatedCostUsd: 0.00241275,
            },
          },
          { status: "failed", usage: null },
        ],
      }),
    );
    await writeFile(
      join(root, "reconciled.mjs"),
      `
      process.env.GEMINI_API_KEY='offline-key'; let calls=0;
      globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({modelVersion:'mock',candidates:[{finishReason:'STOP',content:{parts:[{text:'Short answer '+calls}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:10,totalTokenCount:130}}),{status:200});};
      await import('./run.mjs'); if(calls!==12||process.exitCode)throw new Error('retry failed');
    `,
    );
    const result = spawnSync(process.execPath, [join(root, "reconciled.mjs")], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const name = (await readdir(join(root, ".abilitybench"))).find(
      (item) => item.startsWith("experiment-") && item !== "experiment-legacy",
    );
    const report = JSON.parse(
      await readFile(join(root, ".abilitybench", name ?? "missing", "results.json"), "utf8"),
    );
    expect(report.priorReservedUsd).toBeCloseTo(0.00241275 + 0.006912, 12);
    expect(report.accountedExposureUsd).toBeCloseTo(
      report.priorReservedUsd + report.totalEstimatedCostUsd,
      12,
    );
    expect(report.grossNewReservationsUsd).toBeCloseTo(0.082944, 12);
    expect(report.accountedExposureUsd).toBeLessThan(0.1);
  });

  it("stops after one failed provider attempt, retains unknown accounting, and never retries", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "failure.mjs"),
      `process.env.GEMINI_API_KEY='offline-key'; let calls=0; globalThis.fetch=async()=>{calls++; return new Response('{}',{status:429});}; await import('./run.mjs'); if(calls!==1) throw new Error('unexpected retry');`,
    );
    const result = spawnSync(process.execPath, [join(root, "failure.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HTTP 429");
    const names = await readdir(join(root, ".abilitybench"));
    const evidence = join(root, ".abilitybench", names[0] ?? "missing");
    const ledger = JSON.parse(await readFile(join(evidence, "usage-ledger.json"), "utf8")) as {
      budget: { unknownUsage: boolean; attempts: number };
      ledger: { status: string; usage: unknown }[];
    };
    expect(ledger.budget).toMatchObject({ unknownUsage: true, attempts: 1 });
    expect(ledger.ledger).toEqual([expect.objectContaining({ status: "failed", usage: null })]);
    const report = JSON.parse(await readFile(join(evidence, "results.json"), "utf8"));
    expect(report.status).toBe("incomplete");
    expect(report.finalFailure.origin).toBe("provider");
    expect(report.abilityBenchFailures).toEqual([]);
    expect(report.executionResults).toEqual([]);
  });
});
