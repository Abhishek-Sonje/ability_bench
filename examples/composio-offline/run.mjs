import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeArtifact,
  FileArtifactStore,
  planWorkflowRun,
  runWorkflow,
} from "../../dist/index.js";
import { openProject, prepareProject } from "./prepare.mjs";

const [command, ...args] = process.argv.slice(2);
const help =
  "Usage: node examples/composio-offline/run.mjs prepare <source> <result.json> [output-parent] | adopt <source> <result.json> <capture-package> [output-parent] | run <project> <baseline-id|none> [--publish] | plan <project> <baseline-id|none>";
if (command === "prepare" && args.length >= 2 && args.length <= 3) {
  const project = await prepareProject(
    args[0],
    args[1],
    args[2] ?? fileURLToPath(new URL(".abilitybench", import.meta.url)),
  );
  console.log(JSON.stringify(project, null, 2));
} else if (command === "adopt" && args.length >= 3 && args.length <= 4) {
  console.log(
    JSON.stringify(
      await prepareProject(
        args[0],
        args[1],
        args[3] ?? fileURLToPath(new URL(".abilitybench", import.meta.url)),
        { capturePackage: args[2] },
      ),
      null,
      2,
    ),
  );
} else if (
  (command === "run" || command === "plan") &&
  (args.length === 2 || (command === "run" && args.length === 3 && args[2] === "--publish"))
) {
  const root = resolve(args[0]);
  const workflow = await openProject(root);
  const inputs = JSON.parse(await readFile(join(root, "inputs.json"), "utf8"));
  const publish = args[2] === "--publish";
  const environment = {};
  if (publish) {
    environment.ABILITYBENCH_SITE_OUTPUT_DIRECTORY = join(
      root,
      "published",
      `site-${randomUUID()}`,
    );
  }
  const options = {
    inputs: { ...inputs, publish },
    baseline: args[1] === "none" ? null : { runId: args[1] },
    environment,
  };
  const result = await (command === "plan" ? planWorkflowRun : runWorkflow)(workflow, options);
  if (command === "run") {
    const reviewDirectory = join(root, "reviews");
    await mkdir(reviewDirectory, { recursive: true });
    // Local review files are opt-in workflow execution outputs, never site publication.
    await writeFile(
      join(reviewDirectory, `${result.manifest.id}.json`),
      JSON.stringify(
        {
          manifest: result.manifest,
          plan: result.plan,
          modelCalls: 0,
          composioCalls: 0,
          mode: "offline-only",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    const stage = result.manifest.stages.find(({ stageId }) => stageId === "render-report");
    if (stage.outputArtifactHash) {
      const artifact = await new FileArtifactStore(result.storageDir).get(stage.outputArtifactHash);
      await writeFile(
        join(reviewDirectory, `${result.manifest.id}.md`),
        decodeArtifact(artifact).markdown,
        { flag: "wx" },
      );
    }
    const analysis = result.manifest.stages.find(({ stageId }) => stageId === "analyze");
    if (analysis.outputArtifactHash) {
      const artifact = await new FileArtifactStore(result.storageDir).get(
        analysis.outputArtifactHash,
      );
      await writeFile(
        join(reviewDirectory, `${result.manifest.id}-criteria.json`),
        JSON.stringify({ analysisText: decodeArtifact(artifact).text }),
        { flag: "wx" },
      );
    }
    console.log(
      JSON.stringify(
        {
          runId: result.manifest.id,
          executionStatus: result.manifest.executionStatus,
          reviewDirectory,
          publication: publish ? environment.ABILITYBENCH_SITE_OUTPUT_DIRECTORY : "disabled",
          stages: result.manifest.stages.map(({ stageId, executionStatus, decisionReason }) => ({
            stageId,
            executionStatus,
            decisionReason,
          })),
        },
        null,
        2,
      ),
    );
    if (result.manifest.executionStatus !== "completed") process.exitCode = 1;
  } else console.log(JSON.stringify(result.plan, null, 2));
} else throw new Error(help);
