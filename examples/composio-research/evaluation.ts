import { createEvaluationSuite, defineCheck, input } from "abilitybench";

const knownRecords = defineCheck({
  id: "known-records",
  targetStage: "report",
  outputInputs: { candidates: input.stringArray("/candidates") },
  revision: "known-records-v1",
  files: ["evaluation.ts"],
  evaluate: ({ output, criteria }) => {
    const { knownRecords } = criteria;
    if (!Array.isArray(knownRecords) || !knownRecords.every((value) => typeof value === "string")) {
      throw new TypeError("knownRecords must be an array of captured record filenames.");
    }
    const unknown = output.candidates.filter((name) => !knownRecords.includes(name));
    const unique = new Set(output.candidates).size;
    return {
      passed: unknown.length === 0 && unique === output.candidates.length,
      details: { unknownRecords: unknown, duplicates: output.candidates.length - unique },
    };
  },
});
const minimumCandidates = defineCheck({
  id: "minimum-candidates",
  targetStage: "report",
  outputInputs: { candidates: input.stringArray("/candidates") },
  revision: "minimum-candidates-v1",
  files: ["evaluation.ts"],
  evaluate: ({ output, criteria }) => {
    const { minimumCandidates } = criteria;
    if (
      typeof minimumCandidates !== "number" ||
      !Number.isSafeInteger(minimumCandidates) ||
      minimumCandidates < 0
    ) {
      throw new TypeError("minimumCandidates must be a nonnegative safe integer.");
    }
    return {
      passed: output.candidates.length >= minimumCandidates,
      details: { actual: output.candidates.length, required: minimumCandidates },
    };
  },
});
export default createEvaluationSuite({
  id: "captured-screening",
  workflowId: "composio-research-screening",
  root: import.meta.dirname,
  checks: [knownRecords, minimumCandidates],
});
