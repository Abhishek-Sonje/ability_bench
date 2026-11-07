import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type EvaluationReceipt, FileEvaluationReceiptStore } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("compiled evaluation demo process", () => {
  it("runs the actual walkthrough with retained, verifiable receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "abilitybench evaluation demo "));
    roots.push(root);
    const sdkUrl = pathToFileURL(resolve("dist/index.js")).href;
    for (const name of ["workflow.ts", "evaluation.ts", "abilitybench.config.ts", "run.mjs"]) {
      const source = await readFile(resolve("examples/evaluation-regression", name), "utf8");
      await writeFile(
        join(root, name),
        source.replaceAll('from "abilitybench"', `from ${JSON.stringify(sdkUrl)}`),
      );
    }
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    const result = spawnSync(process.execPath, [join(root, "run.mjs")], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "intentional-regression: execution=completed; evaluation=failed; comparison=regressed",
    );
    expect(result.stdout).toContain(
      "both-fail-stricter-criterion: execution=completed; evaluation=failed; comparison=no_regressions",
    );
    expect(result.stdout).toContain("All demo assertions passed.");
    const review = JSON.parse(
      await readFile(join(root, ".abilitybench", "demo-results.json"), "utf8"),
    ) as { baseline: { id: string }; outcomes: { scenario: string; receipt: EvaluationReceipt }[] };
    expect(review.outcomes.map(({ scenario }) => scenario)).toEqual([
      "unchanged",
      "intentional-regression",
      "both-fail-stricter-criterion",
    ]);
    const store = new FileEvaluationReceiptStore(join(root, ".abilitybench"));
    for (const { receipt } of review.outcomes) {
      expect(receipt.baseline.runId).toBe(review.baseline.id);
      expect(await store.get(receipt.id)).toEqual(receipt);
    }
    const regression = review.outcomes[1]?.receipt;
    const stricter = review.outcomes[2]?.receipt;
    expect(regression?.candidate.runId).toBe(stricter?.candidate.runId);
    expect(regression?.criteriaArtifactHash).not.toBe(stricter?.criteriaArtifactHash);
    expect(stricter?.summary.unchangedFail).toBe(1);
  });
});
