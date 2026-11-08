import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWorkflow, openHistory, prepare, stage } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function root() {
  const p = await mkdtemp(join(tmpdir(), "abilitybench fresh "));
  roots.push(p);
  return p;
}
it("prepares callback-free and executes once into independently readable ordered history", async () => {
  const directory = await root();
  let calls = 0;
  const source = stage({
    id: "source",
    run: () => {
      calls++;
      return { z: [2, 1], a: null };
    },
  });
  const workflow = createWorkflow({ id: "fresh", root: directory, stages: [source] });
  const prepared = await prepare(workflow, { baseline: null });
  expect(calls).toBe(0);
  await expect(stat(join(directory, ".abilitybench"))).rejects.toMatchObject({ code: "ENOENT" });
  const result = await prepared.execute();
  expect(result.status).toBe("completed");
  expect(calls).toBe(1);
  expect(
    await openHistory(join(directory, ".abilitybench")).output(result.runId, "source"),
  ).toEqual({ z: [2, 1], a: null });
  expect(
    Object.keys(
      (await openHistory(join(directory, ".abilitybench")).output(
        result.runId,
        "source",
      )) as object,
    ),
  ).toEqual(["z", "a"]);
  await expect(prepared.execute()).rejects.toMatchObject({ code: "prepared_execution_used" });
});
