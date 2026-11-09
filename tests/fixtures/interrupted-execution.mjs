import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkflow, prepare, stage } from "../../dist/index.js";

const root = process.argv[2];
const seed = stage({
  id: "seed",
  reuse: { revision: "one" },
  run: () => "orphan output from interrupted attempt",
});
const hanging = stage({
  id: "hanging",
  reuse: { revision: "one" },
  dependencies: { seed },
  run: async () => {
    const heartbeat = setInterval(() => {}, 1000);
    try {
      await writeFile(join(root, ".abilitybench", "staging", "interrupted.tmp"), "orphan temp");
      process.stdout.write("hanging\n");
      await new Promise(() => {});
    } finally {
      clearInterval(heartbeat);
      await writeFile(join(root, "resumed"), "callback resumed");
    }
  },
});
const workflow = createWorkflow({ id: "interrupt", root, stages: [seed, hanging] });
await (await prepare(workflow, { baseline: null })).execute();
