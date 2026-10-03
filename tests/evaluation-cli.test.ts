import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { EvaluationReceipt } from "../src/index.js";

const roots: string[] = [];
const cli = resolve("dist/cli.js");
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function command(root: string, args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}
async function project() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench evaluation cli "));
  roots.push(root);
  const sdk = pathToFileURL(resolve("dist/index.js")).href;
  for (const name of ["workflow.ts", "evaluation.ts"]) {
    const source = await readFile(resolve("examples/evaluation-regression", name), "utf8");
    await writeFile(
      join(root, name),
      source.replaceAll('from "abilitybench"', `from ${JSON.stringify(sdk)}`),
    );
  }
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await config(root, "./evaluation.ts");
  await writeFile(
    join(root, "criteria.json"),
    JSON.stringify({ minimumEvidence: 2, minimumCandidates: 2 }),
  );
  return root;
}
async function config(root: string, evaluation?: unknown) {
  await writeFile(
    join(root, "abilitybench.config.ts"),
    `export default ${JSON.stringify({ workflow: "./workflow.ts", ...(evaluation === undefined ? {} : { evaluation }) })};`,
  );
}
async function run(root: string, trusted: string[], baseline?: string) {
  await writeFile(
    join(root, "inputs.json"),
    JSON.stringify({ records: ["a", "b", "c"], trusted, eligible: ["a", "b", "c"] }),
  );
  const result = command(root, [
    "run",
    "--inputs",
    "inputs.json",
    "--json",
    ...(baseline ? ["--baseline", baseline] : []),
  ]);
  expect(result.status, result.stderr).toBe(0);
  return (JSON.parse(result.stdout) as { runId: string }).runId;
}
function evaluate(root: string, baseline: string, candidate: string) {
  return command(root, ["evaluate", baseline, candidate, "--criteria", "criteria.json", "--json"]);
}
function receipt(result: ReturnType<typeof command>) {
  expect(result.stderr).toBe("");
  const value = JSON.parse(result.stdout) as { schemaVersion: string; receipt: EvaluationReceipt };
  expect(value.schemaVersion).toBe("phase2-cli-evaluate-v1");
  return value.receipt;
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else result[child] = (await readFile(child)).toString("hex");
    }
  }
  await visit(root);
  return result;
}
function failure(result: ReturnType<typeof command>, code: string) {
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toMatchObject({
    schemaVersion: "phase1-cli-error-v1",
    error: { code },
  });
}

describe("built evaluation CLI", () => {
  it("evaluates branches and joins, preserves manifests, and inspects without evaluator code", async () => {
    const root = await project();
    const baseline = await run(root, ["a", "b", "c"]);
    const same = await run(root, ["a", "b", "c"], baseline);
    const candidate = await run(root, ["a"], baseline);
    const before = await snapshot(join(root, ".abilitybench", "runs"));
    const pass = evaluate(root, baseline, same);
    expect(pass.status).toBe(0);
    expect(receipt(pass).evaluationStatus).toBe("passed");
    const regression = evaluate(root, baseline, candidate);
    expect(regression.status).toBe(1);
    const stored = receipt(regression);
    expect(stored.comparisonStatus).toBe("regressed");
    await writeFile(join(root, "criteria.json"), '{"minimumEvidence":4,"minimumCandidates":4}');
    const strict = evaluate(root, baseline, candidate);
    expect(strict.status).toBe(1);
    expect(receipt(strict).comparisonStatus).toBe("no_regressions");
    await writeFile(join(root, "criteria.json"), "{}");
    const errors = evaluate(root, baseline, candidate);
    expect(errors.status).toBe(3);
    expect(receipt(errors).evaluationStatus).toBe("error");
    expect(await snapshot(join(root, ".abilitybench", "runs"))).toEqual(before);
    await writeFile(join(root, "evaluation.ts"), 'throw new Error("must never import");');
    const storage = await snapshot(join(root, ".abilitybench"));
    const lookup = command(root, ["evaluation", stored.id, "--json"]);
    expect(lookup.status, lookup.stderr).toBe(0);
    expect(JSON.parse(lookup.stdout)).toEqual({
      schemaVersion: "phase2-cli-evaluation-v1",
      receipt: stored,
    });
    await config(root);
    expect(command(root, ["evaluation", stored.id]).stdout).toContain("comparison: regressed");
    expect(await snapshot(join(root, ".abilitybench"))).toEqual(storage);
    failure(evaluate(root, baseline, candidate), "evaluation_not_configured");
  }, 30_000);

  it("rejects invalid criteria, options, configuration, lineage, and corrupt receipts", async () => {
    const root = await project();
    const baseline = await run(root, ["a", "b", "c"]);
    const candidate = await run(root, ["a"], baseline);
    const stored = receipt(evaluate(root, baseline, candidate));
    for (const [text, code] of [
      ["[]", "criteria_not_object"],
      ["{", "criteria_invalid_json"],
      ['{"value":1e999}', "invalid_criteria"],
    ]) {
      await writeFile(join(root, "criteria.json"), text as string);
      failure(evaluate(root, baseline, candidate), code as string);
    }
    await rm(join(root, "criteria.json"));
    failure(evaluate(root, baseline, candidate), "criteria_read_failed");
    await writeFile(join(root, "criteria.json"), "{}");
    failure(evaluate(root, baseline, baseline), "run_pair_same_run");
    failure(evaluate(root, candidate, baseline), "run_pair_lineage_mismatch");
    failure(command(root, ["evaluate", baseline, candidate, "--json"]), "invalid_usage");
    failure(
      command(root, ["evaluation", stored.id, "--criteria", "criteria.json", "--json"]),
      "invalid_arguments",
    );
    failure(command(root, ["evaluation", stored.id, "--json", "--json"]), "invalid_usage");
    failure(
      command(root, ["evaluation", `eval_${"0".repeat(64)}`, "--json"]),
      "evaluation_not_found",
    );
    await config(root, "./absent.ts");
    failure(evaluate(root, baseline, candidate), "evaluation_not_found");
    await config(root, "../outside.ts");
    failure(evaluate(root, baseline, candidate), "path_escaped");
    await config(root, 1);
    failure(evaluate(root, baseline, candidate), "invalid_config");
    await config(root, "./evaluation.ts");
    await writeFile(join(root, "evaluation.ts"), "export default Object.freeze({});");
    failure(evaluate(root, baseline, candidate), "invalid_evaluation_export");
    await writeFile(join(root, ".abilitybench", "evaluations", `${stored.id}.json`), "{}");
    failure(command(root, ["evaluation", stored.id, "--json"]), "corrupt_receipt");
  }, 30_000);

  it("does not create storage on lookup and prints help without loading a project", async () => {
    const root = await project();
    failure(
      command(root, ["evaluation", `eval_${"0".repeat(64)}`, "--json"]),
      "evaluation_not_found",
    );
    expect(await readdir(root)).not.toContain(".abilitybench");
    expect(command(root, ["evaluate", "--help"]).status).toBe(0);
  });

  it("rejects failed executions and corrupt source artifacts before publishing", async () => {
    const root = await project();
    const baseline = await run(root, ["a", "b", "c"]);
    const candidate = await run(root, ["a"], baseline);
    const stored = receipt(evaluate(root, baseline, candidate));
    await writeFile(join(root, "inputs.json"), '{"records":false,"trusted":[],"eligible":[]}');
    const failed = command(root, [
      "run",
      "--inputs",
      "inputs.json",
      "--baseline",
      baseline,
      "--json",
    ]);
    expect(failed.status).toBe(1);
    failure(evaluate(root, baseline, JSON.parse(failed.stdout).runId), "run_pair_not_completed");
    const hash = stored.checks[0]?.candidate.sourceArtifactHash;
    expect(hash).toBeDefined();
    await writeFile(
      join(root, ".abilitybench", "objects", "sha256", (hash as string).slice(7)),
      "tampered",
    );
    const before = await snapshot(join(root, ".abilitybench", "evaluations"));
    failure(evaluate(root, baseline, candidate), "corrupt_artifact");
    expect(await snapshot(join(root, ".abilitybench", "evaluations"))).toEqual(before);
    const lookup = command(root, ["evaluation", stored.id, "--json"]);
    expect(lookup.status).toBe(2);
    expect(lookup.stdout).toBe("");
  }, 15_000);

  it("keeps baseline errors distinct and reruns checks on repeated invocations", async () => {
    const root = await project();
    const baseline = await run(root, ["a", "b", "c"]);
    const candidate = await run(root, ["a"], baseline);
    const sdk = pathToFileURL(resolve("dist/index.js")).href;
    await writeFile(
      join(root, "evaluation.ts"),
      `
      import { appendFileSync } from "node:fs";
      import { createEvaluationSuite, defineCheck, input } from ${JSON.stringify(sdk)};
      export default createEvaluationSuite({ id: "errors", workflowId: "evaluation-regression", root: import.meta.dirname,
        checks: [defineCheck({ id: "count", targetStage: "report", outputInputs: { candidates: input.stringArray("/candidates") },
          revision: "v1", files: ["evaluation.ts"], evaluate: ({output, criteria}) => {
            appendFileSync(new URL("./invocations.txt", import.meta.url), "invoked\\n");
            if (output.candidates.length === criteria.throwCount) throw new Error("side failure");
            if (criteria.invalid) return { passed: "yes", details: {} };
            return {passed:true, details:{}};
          } })] });
    `,
    );
    await writeFile(join(root, "criteria.json"), '{"throwCount":3}');
    for (let index = 0; index < 2; index++) {
      const result = evaluate(root, baseline, candidate);
      expect(result.status).toBe(3);
      expect(receipt(result)).toMatchObject({
        evaluationStatus: "passed",
        comparisonStatus: "error",
      });
    }
    expect((await readFile(join(root, "invocations.txt"), "utf8")).trim().split("\n")).toHaveLength(
      4,
    );
    await writeFile(join(root, "criteria.json"), '{"throwCount":1}');
    expect(receipt(evaluate(root, baseline, candidate)).evaluationStatus).toBe("error");
    await writeFile(join(root, "criteria.json"), '{"invalid":true}');
    const malformed = receipt(evaluate(root, baseline, candidate));
    expect(malformed.checks[0]?.candidate.error?.code).toBe("invalid_check_result");
  }, 20_000);

  it("aborts unstable implementation inputs and publication failures without a success result", async () => {
    const root = await project();
    const baseline = await run(root, ["a", "b", "c"]);
    const candidate = await run(root, ["a"], baseline);
    const original = await readFile(join(root, "evaluation.ts"), "utf8");
    await writeFile(
      join(root, "evaluation.ts"),
      `import { appendFileSync } from "node:fs";\n${original.replace('const required = minimum(criteria, "minimumEvidence");', 'appendFileSync(new URL("./evaluation.ts", import.meta.url), "\\n// changed"); const required = minimum(criteria, "minimumEvidence");')}`,
    );
    failure(evaluate(root, baseline, candidate), "evaluation_inputs_changed");
    expect(await readdir(join(root, ".abilitybench"))).not.toContain("evaluations");
    await writeFile(join(root, "evaluation.ts"), original);
    await writeFile(join(root, ".abilitybench", "evaluations"), "not a directory");
    const result = evaluate(root, baseline, candidate);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).schemaVersion).toBe("phase1-cli-error-v1");
  }, 15_000);

  it("rejects mismatched suites and physical path escapes while old commands stay lazy", async () => {
    const root = await project();
    const original = await readFile(join(root, "evaluation.ts"), "utf8");
    for (const source of [
      original.replace('workflowId: "evaluation-regression"', 'workflowId: "other"'),
      original.replace("root: import.meta.dirname", 'root: import.meta.dirname + "/other"'),
    ]) {
      await writeFile(join(root, "evaluation.ts"), source);
      failure(evaluate(root, "a", "b"), "invalid_evaluation_export");
    }
    const outside = await mkdtemp(join(tmpdir(), "abilitybench outside evaluation "));
    roots.push(outside);
    await symlink(outside, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await config(root, "./alias/evaluation.ts");
    failure(evaluate(root, "a", "b"), "path_escaped");
    await config(root, "./evaluation.ts");
    await writeFile(join(root, "evaluation.ts"), 'throw new Error("not for execution commands");');
    expect(await run(root, ["a"])).toMatch(/^run_/);
  }, 15_000);
});
