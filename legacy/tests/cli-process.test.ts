import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const executable = resolve("dist/cli.js");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function invoke(root: string, args: readonly string[]) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

async function project() {
  const root = await mkdtemp(join(tmpdir(), "abilitybench process "));
  roots.push(root);
  const sdkUrl = pathToFileURL(resolve("dist/index.js")).href;
  await writeFile(
    join(root, "abilitybench.config.mjs"),
    'export default { workflow: "./workflow.mjs" };',
  );
  await writeFile(
    join(root, "workflow.mjs"),
    `import { defineWorkflow } from ${JSON.stringify(sdkUrl)};
const builder = defineWorkflow({ id: "process-fixture", root: import.meta.dirname });
for (const [id, dependsOn] of [["seed", []], ["left", ["seed"]], ["right", ["seed"]], ["join", ["left", "right"]]]) {
  builder.stage({ id, dependsOn, implementation: "v1", watch: ["workflow.mjs"], inputs: ["/fail"], env: [], cache: true,
    run: ({ inputs }) => { if (inputs["/fail"] === true) throw new Error("intentional failure"); return { id }; } });
}
export default builder.build();`,
  );
  await writeFile(join(root, "inputs.json"), '{"fail":false}');
  return root;
}

const config = ["--config", "abilitybench.config.mjs"];
const inputs = ["--inputs", "inputs.json"];

describe("compiled CLI process", () => {
  it("runs, plans, inspects, compares, and lists a branch-and-join workflow", async () => {
    const root = await project();
    const first = invoke(root, ["run", ...config, ...inputs, "--json"]);
    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    const baseline = JSON.parse(first.stdout) as { runId: string };
    const store = join(root, ".abilitybench", "runs");
    const names = await readdir(store);
    const bytes = await readFile(join(store, `${baseline.runId}.json`));

    const plan = invoke(root, [
      "plan",
      ...config,
      ...inputs,
      "--baseline",
      baseline.runId,
      "--json",
    ]);
    expect(plan.status).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({ summary: { execute: 0, reuse: 4 } });
    expect(await readdir(store)).toEqual(names);
    expect(await readFile(join(store, `${baseline.runId}.json`))).toEqual(bytes);

    const second = invoke(root, [
      "run",
      ...config,
      ...inputs,
      "--baseline",
      baseline.runId,
      "--json",
    ]);
    expect(second.status).toBe(0);
    const candidate = JSON.parse(second.stdout) as { runId: string };
    const inspected = invoke(root, ["inspect", candidate.runId, ...config, "--json"]);
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      manifest: { id: candidate.runId, baselineRunId: baseline.runId },
    });
    const diff = invoke(root, ["diff", baseline.runId, candidate.runId, ...config, "--json"]);
    expect(diff.status).toBe(0);
    expect(JSON.parse(diff.stdout)).toMatchObject({
      summary: { changed: 4, added: 0, removed: 0 },
    });
    const listed = invoke(root, ["runs", ...config, "--limit", "1", "--json"]);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ totalMatched: 2, truncated: true });
  });

  it("preserves process exit codes and output streams for failures", async () => {
    const root = await project();
    const invalid = invoke(root, ["inspect", "invalid", "--baseline", "invalid", "--json"]);
    expect(invalid.status).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(JSON.parse(invalid.stderr)).toMatchObject({
      schemaVersion: "phase1-cli-error-v1",
      error: { code: "invalid_arguments" },
    });

    await writeFile(join(root, "inputs.json"), '{"fail":true}');
    const failed = invoke(root, ["run", ...config, ...inputs, "--json"]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toBe("");
    expect(JSON.parse(failed.stdout)).toMatchObject({
      executionStatus: "failed",
      evaluationStatus: "not_run",
    });
  });
});
