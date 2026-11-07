import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createEvaluationSuite, defineCheck, input } from "../../dist/index.js";
import { renderReport } from "./upstream/analysis.js";

// Report compatibility, not a factuality claim about historical research.
const report = defineCheck({
  id: "original-report-bytes",
  targetStage: "render-report",
  outputInputs: { markdown: input.string("/markdown") },
  revision: "upstream-report-compatibility-v1",
  files: [
    "evaluation.mjs",
    "upstream/analysis.js",
    "upstream/data/assessment-categories.js",
    "upstream/agent/result-schema.js",
    "dependency-files.json",
    ...JSON.parse(await readFile(new URL("./dependency-files.json", import.meta.url), "utf8")),
  ],
  evaluate: ({ output, criteria }) => {
    assert(typeof criteria.analysisText === "string", "analysisText criterion is required.");
    const expected = renderReport(JSON.parse(criteria.analysisText));
    return {
      passed: output.markdown === expected,
      details: { check: "original-renderer-byte-equality", factualityEvaluated: false },
    };
  },
});
const support = defineCheck({
  id: "existing-support-policy",
  targetStage: "validate-result",
  outputInputs: { findings: input.stringArray("/policyFindings") },
  revision: "saved-context-support-audit-v1",
  files: [
    "evaluation.mjs",
    "upstream/agent/research-agent.js",
    "upstream/agent/result-schema.js",
    "dependency-files.json",
    ...JSON.parse(await readFile(new URL("./dependency-files.json", import.meta.url), "utf8")),
  ],
  evaluate: ({ output }) => ({
    passed: output.findings.length === 0,
    details: {
      affectedApps: output.findings,
      scope: "existing-policy-differences-not-source-authenticity",
    },
  }),
});
export default createEvaluationSuite({
  id: "composio-offline-compatibility",
  workflowId: "composio-offline-coarse-v1",
  root: import.meta.dirname,
  checks: [report, support],
});
