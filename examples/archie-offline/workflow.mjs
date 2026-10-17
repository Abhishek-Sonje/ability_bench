import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  cache,
  createEvaluationSuite,
  createWorkflow,
  defineCheck,
  defineStage,
  input,
} from "../../dist/index.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function build(root) {
  const file = (path) => join(root, path);
  const watched = (files, enabled = true, environment = []) =>
    (enabled ? cache.enabled : cache.disabled)({
      revision: "archie-offline-v1",
      files: ["workflow.mjs", ...files],
      environment,
    });
  // These are the existing init() gathering branches, now read from an explicit acquisition snapshot.
  const branches = ["userConfig", "identityFiles", "treeString", "sourceFiles", "gitHistory"].map(
    (key) =>
      defineStage({
        id: key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
        dependsOn: [],
        inputs: {},
        cache: watched([`${key}.json`]),
        run: async () => ({ text: await readFile(file(`${key}.json`), "utf8") }),
      }),
  );
  const architecture = defineStage({
    id: "architecture",
    dependsOn: branches,
    inputs: { snapshotReadRevision: input.string("/snapshotReadRevision") },
    cache: watched(["capture.json", "architecture.md", "upstream/core/gemini.js"]),
    run: async ({ dependencies }) => {
      // Explicit field/array order is part of Archie's prompt contract.
      const originalInput = Object.fromEntries(
        ["userConfig", "identityFiles", "treeString", "sourceFiles", "gitHistory"].map((key) => [
          key,
          JSON.parse(
            dependencies[key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)].text,
          ),
        ]),
      );
      const capture = JSON.parse(await readFile(file("capture.json"), "utf8"));
      const markdown = await readFile(file("architecture.md"), "utf8");
      assert(
        capture.version === 1 && capture.mode === "mocked-existing-agent",
        "Unsupported acquisition provenance.",
      );
      assert(
        capture.inputSha256 === sha(JSON.stringify(originalInput)),
        "Stale acquisition: inputs changed; explicitly acquire a fresh snapshot.",
      );
      assert(
        capture.generationModuleSha256 === sha(await readFile(file("upstream/core/gemini.js"))),
        "Stale acquisition: original prompt implementation changed.",
      );
      assert(capture.architectureSha256 === sha(markdown), "Corrupt acquired architecture.");
      return { markdown, provenance: capture.mode, inputSha256: capture.inputSha256 };
    },
  });
  const publish = defineStage({
    id: "publish",
    dependsOn: [architecture],
    inputs: { publish: input.boolean("/publish") },
    cache: watched(["upstream/core/writer.js"], false, ["ARCHIE_EXAMPLE_OUTPUT"]),
    run: async ({ dependencies, inputs, env }) => {
      if (!inputs.publish) return { published: false };
      const target = file("published");
      assert(
        env.ARCHIE_EXAMPLE_OUTPUT === target && resolve(root) === (await realpath(root)),
        "Publication must use the isolated project directory.",
      );
      try {
        const info = await lstat(target);
        assert(info.isDirectory() && !info.isSymbolicLink(), "Unsafe destination.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await mkdir(target);
      }
      try {
        const info = await lstat(join(target, "ARCHITECTURE.md"));
        assert(info.isFile() && !info.isSymbolicLink(), "Unsafe output file.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const writerPath = file("upstream/core/writer.js");
      const writer = await import(
        `${pathToFileURL(writerPath).href}?sha=${sha(await readFile(writerPath))}`
      );
      await writer.writeArchitecture(target, dependencies.architecture.markdown);
      return { published: true, markdown: await readFile(join(target, "ARCHITECTURE.md"), "utf8") };
    },
  });
  return createWorkflow({
    id: "archie-existing-agent-offline",
    root,
    stages: [...branches, architecture, publish],
  });
}

export function evaluation(root) {
  const policyPath = join(root, "evaluation-policy.json");
  return createEvaluationSuite({
    id: "archie-document-contract",
    workflowId: "archie-existing-agent-offline",
    root,
    checks: [
      defineCheck({
        id: "required-section-order",
        targetStage: "architecture",
        outputInputs: { markdown: input.string("/markdown") },
        revision: "archie-original-output-instructions-v1",
        files: ["workflow.mjs", "evaluation-policy.json"],
        evaluate: async ({ output }) => {
          const policy = JSON.parse(await readFile(policyPath, "utf8"));
          const actual = output.markdown.split(/\r?\n/).filter((line) => /^#{1,2} /.test(line));
          return {
            passed: JSON.stringify(actual) === JSON.stringify(policy.requiredHeadings),
            details: { actual, expected: policy.requiredHeadings },
          };
        },
      }),
    ],
  });
}
