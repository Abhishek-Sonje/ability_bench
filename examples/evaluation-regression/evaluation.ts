import { createEvaluationSuite, defineCheck, input, type JsonObject } from "abilitybench";

function minimum(criteria: Readonly<JsonObject>, key: string): number {
  const value = criteria[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${key} must be a nonnegative safe integer.`);
  }
  return value;
}
const evidenceMinimum = defineCheck({
  id: "evidence-minimum",
  targetStage: "evidence",
  outputInputs: { records: input.stringArray("/records") },
  revision: "evidence-minimum-v1",
  files: ["evaluation.ts"],
  evaluate: ({ output, criteria }) => {
    const required = minimum(criteria, "minimumEvidence");
    return {
      passed: output.records.length >= required,
      details: { actual: output.records.length, required },
    };
  },
});
const reportMinimum = defineCheck({
  id: "report-minimum",
  targetStage: "report",
  outputInputs: { candidates: input.stringArray("/candidates") },
  revision: "report-minimum-v1",
  files: ["evaluation.ts"],
  evaluate: ({ output, criteria }) => {
    const required = minimum(criteria, "minimumCandidates");
    return {
      passed: output.candidates.length >= required,
      details: { actual: output.candidates.length, required },
    };
  },
});
export default createEvaluationSuite({
  id: "screening",
  workflowId: "evaluation-regression",
  root: import.meta.dirname,
  checks: [reportMinimum, evidenceMinimum],
});
