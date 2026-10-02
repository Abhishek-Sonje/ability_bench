import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FinalizedRunManifest } from "../src/index.js";

const roots: string[] = [];
const executable = resolve("examples/composio-research/demo.mjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench composio demo "));
  roots.push(root);
  const source = join(root, "source");
  const results = join(source, "results");
  const schema = join(source, "src", "agent");
  const output = join(root, "review");
  await mkdir(results, { recursive: true });
  await mkdir(schema, { recursive: true });
  await writeFile(join(source, "package.json"), '{"type":"module"}');
  // This adapter tests the loader boundary, not the external project's Zod schema.
  await writeFile(
    join(schema, "result-schema.ts"),
    `export const appResearchResultSchema = {
      safeParse(value: unknown) {
        if (value !== null && typeof value === "object" && "app" in value) {
          return { success: true, data: value };
        }
        return { success: false, error: { issues: [{ message: "Missing synthetic app" }] } };
      }
    };`,
  );
  const research = (officialCount: number, confidence: string, feasible = true) => ({
    app: "Same app name",
    buildability: feasible ? "buildable" : "blocked",
    blocker: feasible ? null : "No access",
    authMethods: ["API key"],
    accessModel: "self_serve_free",
    apiSurface: { rest: true, graphql: false, other: [] },
    confidence,
    evidence: Array.from({ length: officialCount }, () => ({ sourceType: "official" })),
  });
  for (const [filename, record] of Object.entries({
    "one.json": research(1, "low"),
    "two.json": research(2, "high"),
    "blocked.json": research(2, "high", false),
    "unsupported.json": research(0, "high"),
    "rejected.json": {},
    "analysis.json": { aggregate: true },
  })) {
    await writeFile(join(results, filename), JSON.stringify(record));
  }
  return { source, results, output };
}

function invoke(source: string, output: string) {
  const result = spawnSync(process.execPath, [executable, source, output], {
    encoding: "utf8",
    timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

interface Review {
  captured: { filename: string; sha256: string }[];
  rejected: { filename: string }[];
  baseline: FinalizedRunManifest;
  baselineReport: { candidates: string[] };
  outcomes: {
    scenario: string;
    manifest: FinalizedRunManifest;
    report: { candidates: string[] } | null;
  }[];
}

describe("offline Composio demo process", () => {
  it("proves the real example's branch/join scenarios without external dependencies", async () => {
    const { source, results, output } = await fixture();
    const names = await readdir(results);
    const before = await Promise.all(names.map((name) => readFile(join(results, name))));
    const result = invoke(source, output);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("All scenario assertions passed.");
    expect(result.stdout).toContain(
      "delivery=skipped_dependency_failed[decision=execute; reason=cache_disabled]",
    );
    expect(result.stdout).toContain("report=failed[decision=execute; reason=fingerprint_changed]");
    const review = JSON.parse(await readFile(join(output, "demo-results.json"), "utf8")) as Review;
    expect(review.captured.map(({ filename }) => filename)).toEqual([
      "blocked.json",
      "one.json",
      "two.json",
      "unsupported.json",
    ]);
    expect(review.captured.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256))).toBe(true);
    expect(review.rejected).toMatchObject([{ filename: "rejected.json" }]);
    expect(review.baselineReport.candidates).toEqual(["one.json", "two.json"]);
    expect(review.outcomes.map(({ scenario }) => scenario)).toEqual([
      "unchanged",
      "watched-policy-change",
      "environment-change",
      "manual-invalidation",
      "intentional-failure",
    ]);
    const expectedReasons = [
      [
        "fingerprint_match",
        "fingerprint_match",
        "fingerprint_match",
        "fingerprint_match",
        "fingerprint_match",
        "cache_disabled",
      ],
      [
        "fingerprint_match",
        "fingerprint_changed",
        "fingerprint_match",
        "dependency_executed",
        "dependency_executed",
        "cache_disabled",
      ],
      [
        "fingerprint_match",
        "fingerprint_match",
        "fingerprint_changed",
        "dependency_executed",
        "dependency_executed",
        "cache_disabled",
      ],
      [
        "fingerprint_match",
        "manual_invalidation",
        "fingerprint_match",
        "dependency_executed",
        "dependency_executed",
        "cache_disabled",
      ],
      [
        "fingerprint_match",
        "fingerprint_match",
        "fingerprint_match",
        "fingerprint_match",
        "fingerprint_changed",
        "cache_disabled",
      ],
    ];
    for (const [index, outcome] of review.outcomes.entries()) {
      expect(outcome.manifest.baselineRunId).toBe(review.baseline.id);
      expect(outcome.manifest.stages.map(({ decisionReason }) => decisionReason)).toEqual(
        expectedReasons[index],
      );
      expect(outcome.manifest.evaluationStatus).toBe("not_run");
    }
    expect(review.outcomes.map(({ report }) => report?.candidates ?? null)).toEqual([
      ["one.json", "two.json"],
      ["two.json"],
      ["two.json"],
      ["one.json", "two.json"],
      null,
    ]);
    expect(
      review.outcomes[4]?.manifest.stages.find(({ stageId }) => stageId === "delivery"),
    ).toMatchObject({
      executionStatus: "skipped_dependency_failed",
      outputArtifactHash: null,
    });
    expect(await readdir(results)).toEqual(names);
    expect(await Promise.all(names.map((name) => readFile(join(results, name))))).toEqual(before);
    await expect(readdir(join(source, ".abilitybench"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on malformed JSON without publishing a review", async () => {
    const { source, results, output } = await fixture();
    await writeFile(join(results, "broken.json"), "{");
    const result = invoke(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SyntaxError");
    await expect(readdir(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a dataset with no schema-valid records", async () => {
    const { source, results, output } = await fixture();
    for (const filename of await readdir(results)) {
      await writeFile(join(results, filename), "{}");
    }
    const result = invoke(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No schema-valid per-app research results found.");
    await expect(readdir(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
