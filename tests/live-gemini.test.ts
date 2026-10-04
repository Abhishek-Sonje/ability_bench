import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench-gemini-offline-"));
  roots.push(root);
  const sdk = pathToFileURL(resolve("dist/index.js")).href;
  for (const name of ["adapter.mjs", "run.mjs"]) {
    const source = await readFile(resolve("examples/live-gemini", name), "utf8");
    await writeFile(join(root, name), source.replace('"../../dist/index.js"', JSON.stringify(sdk)));
  }
  return root;
}

describe("live Gemini adapter offline guardrails", () => {
  it("checks canonical request binding, usage math, spend reservation, attempts, and time", async () => {
    const root = await fixture();
    const adapter = pathToFileURL(join(root, "adapter.mjs")).href;
    const source = `
      import assert from 'node:assert/strict';
      import { Budget, digest, outputFromSnapshot, requestBody, SETTINGS, usageFromResponse } from ${JSON.stringify(adapter)};
      const body = requestBody('short prompt', { source: { text: 'synthetic' } });
      const snapshot = { requestHash: digest({ model: SETTINGS.model, body }), text: 'captured answer', modelVersion: 'test-version' };
      assert.equal(outputFromSnapshot(snapshot, body).text, 'captured answer');
      assert.throws(() => outputFromSnapshot(snapshot, requestBody('changed prompt', {})));
      const usage = usageFromResponse({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150, cachedContentTokenCount: 10 } });
      assert.equal(usage.totalTokens, 150);
      assert.ok(Math.abs(usage.estimatedCostUsd - (90 * .75 + 10 * .075 + 50 * 3.75) / 1000000) < 1e-12);
      assert.equal(usageFromResponse({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 150 } }).thinkingTokens, 30);
      for (const value of [{}, { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 90 } }, { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120, cachedContentTokenCount: 101 } }]) assert.throws(() => usageFromResponse(value));
      const budget = new Budget(); for (let i = 0; i < 12; i++) budget.reserve(body);
      assert.ok(budget.reservedUsd < .10); assert.throws(() => budget.reserve(body), /12-request/);
      const oversized = new Budget(); assert.throws(() => oversized.reserve({ text: 'x'.repeat(2049) }), /2,048/); assert.equal(oversized.attempts, 0);
      const unknown = new Budget(); unknown.unknownUsage = true; assert.throws(() => unknown.reserve(body), /unknown usage/);
      const expired = new Budget(); expired.started -= 300001; assert.throws(() => expired.reserve(body), /Five-minute/);
      const spent = new Budget(); spent.reservedUsd = .099; assert.throws(() => spent.reserve(body), /reservation/);
      const exceeded = new Budget(); assert.throws(() => exceeded.record({ ...usage, inputTokens: 4097 }), /exceeded/); assert.equal(exceeded.unknownUsage, true);
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
      let calls = 0;
      globalThis.fetch = async (url, options) => {
        if (!url.startsWith('https://generativelanguage.googleapis.com/') || options.headers['x-goog-api-key'] !== process.env.GEMINI_API_KEY) throw new Error('unexpected request');
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
    expect(await readdir(evidence)).not.toContain("results.json");
  });
});
