// IPC barriers drive real SDK attempts. The private coordinator only supplies the schedule.
import { once } from "node:events";
import { basename } from "node:path";
import { prepareExecution } from "../../dist/execution.js";
import { createWorkflow, stage } from "../../dist/index.js";

const [root, payload, runId, boundary] = process.argv.slice(2);
const signal = (event) =>
  new Promise((resolve, reject) => {
    process.send(event, (error) => (error ? reject(error) : resolve()));
  });
async function barrier(point, file) {
  const resume = once(process, "message");
  await signal({ point, file });
  await resume;
}

const source = stage({
  id: "source",
  reuse: { revision: "one" },
  run: async () => {
    await signal({ point: "callback" });
    if (boundary === "callback") await barrier("callbackHeld");
    return JSON.parse(payload);
  },
});
const workflow = createWorkflow({ id: "storage-schedule", root, stages: [source] });
const schedule = {
  contended: (file) => signal({ point: "contended", file }),
};
if (boundary === "runLinked" || boundary === "replacementLinked") {
  schedule.linked = async (file) => {
    if (basename(file).endsWith(".json") === (boundary === "runLinked"))
      await barrier(boundary, file);
  };
} else if (boundary && boundary !== "callback") {
  for (const point of boundary.split(",")) {
    let held = false;
    schedule[point] = async (file) => {
      if (held) return;
      held = true;
      await barrier(point, typeof file === "string" ? file : undefined);
    };
  }
}
try {
  const prepared = await prepareExecution(
    workflow,
    { baseline: runId ? { runId } : null },
    schedule,
  );
  const result = await prepared.execute();
  await signal({ point: "result", result, preview: prepared.preview });
} catch (error) {
  await signal({
    point: "error",
    code: error.code,
    reason: error.context?.reason,
    runId: error.context?.runId,
    status: error.context?.status,
  });
}
process.disconnect();
