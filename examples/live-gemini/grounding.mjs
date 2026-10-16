/** Example-specific source contract and bounded checks, not a general factuality evaluator. */
export const EXAMPLE_VERSION = "source-grounded-v2";
export const SOURCE_CATALOG = {
  teamSize: 3,
  dailyTickets: 40,
  budgetUsd: 70,
  options: {
    A: {
      description: "shared inbox",
      priceUsd: 20,
      mode: "manual tags",
      humanReview: "unspecified",
    },
    B: {
      description: "automated triage",
      priceUsd: 60,
      mode: "automated triage",
      humanReview: "required",
    },
  },
};
export const PROMPTS = {
  facts:
    "[facts] Extract JSON only with keys budgetUsd, teamSize, dailyTickets, humanReviewRequired (array of option IDs). Exact source values; no extra keys or claims.",
  options:
    "[options] Compare catalog and facts, using source only. Two lines A: and B:. Include each monthly price, mode, and human review required/unspecified. Do not infer capacity or no-review guarantees. At most 25 words.",
  risks:
    "[risks] Use catalog and facts. Two lines A: and B:, each labelled Hypothesis and using may/could. Describe plausible risks, not established outcomes. Do not invent capacities or capabilities. At most 25 words.",
  report:
    "[report] Recommend Option A or B using catalog, options and risks. Give one grounded reason. Risks are hypotheses, not facts. Do not invent capabilities or guarantee outcomes. At most 25 words.",
  summary:
    "[summary] Start Recommend Option A or B, preserving the report's choice. Add no claims, numbers or cadence. Preserve any proposed safeguard as a proposal, not existing policy. At most 20 words.",
};
export const CHANGED_PROMPT =
  "[report] Recommend Option A or B using catalog, options and risks. Include one grounded reason AND one human-review safeguard labelled Proposed. No invented capabilities or guaranteed outcomes. At most 30 words.";

function requireCondition(condition, message) {
  if (!condition) {
    const error = new Error(`Source grounding: ${message}`);
    error.failureOrigin = "grounding_validation";
    throw error;
  }
}
function keysEqual(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}
export function validateCatalog(value) {
  requireCondition(
    keysEqual(value, ["teamSize", "dailyTickets", "budgetUsd", "options"]),
    "catalog fields are missing or unexpected.",
  );
  for (const key of ["teamSize", "dailyTickets"])
    requireCondition(Number.isSafeInteger(value[key]) && value[key] > 0, `invalid ${key}.`);
  requireCondition(Number.isFinite(value.budgetUsd) && value.budgetUsd >= 0, "invalid budget.");
  requireCondition(keysEqual(value.options, ["A", "B"]), "both source options are required.");
  for (const [id, option] of Object.entries(value.options)) {
    requireCondition(
      keysEqual(option, ["description", "priceUsd", "mode", "humanReview"]),
      `incomplete option ${id}.`,
    );
    requireCondition(
      typeof option.description === "string" && option.description.trim().length > 0,
      `missing description for ${id}.`,
    );
    requireCondition(
      Number.isFinite(option.priceUsd) && option.priceUsd >= 0,
      `invalid price for ${id}.`,
    );
    requireCondition(
      ["manual tags", "automated triage"].includes(option.mode),
      `unknown mode for ${id}.`,
    );
    requireCondition(
      ["required", "unspecified"].includes(option.humanReview),
      `unknown review requirement for ${id}.`,
    );
  }
  return value;
}
export function expectedFacts(catalog) {
  validateCatalog(catalog);
  return {
    budgetUsd: catalog.budgetUsd,
    teamSize: catalog.teamSize,
    dailyTickets: catalog.dailyTickets,
    humanReviewRequired: Object.keys(catalog.options)
      .filter((id) => catalog.options[id].humanReview === "required")
      .sort(),
  };
}
export function validateFacts(text, catalog) {
  let facts;
  try {
    facts = JSON.parse(text);
  } catch {
    requireCondition(false, "facts must be strict JSON.");
  }
  const expected = expectedFacts(catalog);
  requireCondition(
    keysEqual(facts, Object.keys(expected)),
    "facts fields are missing or unexpected.",
  );
  for (const key of ["budgetUsd", "teamSize", "dailyTickets"])
    requireCondition(facts[key] === expected[key], `facts contradict source ${key}.`);
  requireCondition(
    Array.isArray(facts.humanReviewRequired) &&
      JSON.stringify(facts.humanReviewRequired) === JSON.stringify(expected.humanReviewRequired),
    "facts contradict human-review requirements.",
  );
  return facts;
}
export function validateStageInputs(stageId, dependencies) {
  requireCondition(
    dependencies !== null && typeof dependencies === "object",
    "explicit dependencies are required.",
  );
  const catalog = validateCatalog(dependencies.catalog);
  if (["options", "risks"].includes(stageId)) {
    requireCondition(
      typeof dependencies.facts?.text === "string",
      "explicit facts dependency is required.",
    );
    validateFacts(dependencies.facts.text, catalog);
  }
  for (const id of stageId === "report"
    ? ["options", "risks"]
    : stageId === "summary"
      ? ["report"]
      : [])
    requireCondition(
      typeof dependencies[id]?.text === "string" && dependencies[id].text.trim().length > 0,
      `explicit ${id} dependency is required.`,
    );
  return catalog;
}
export function validateStageOutput(stageId, text, dependencies, prompt) {
  const catalog = validateStageInputs(stageId, dependencies);
  requireCondition(typeof text === "string" && text.trim().length > 0, "empty generated output.");
  if (stageId === "facts") {
    validateFacts(text, catalog);
    return;
  }
  const words = text.trim().split(/\s+/).length;
  const limit =
    stageId === "summary"
      ? 20
      : stageId === "report" && prompt.includes("labelled Proposed")
        ? 30
        : 25;
  requireCondition(
    words <= limit,
    `${stageId} exceeds its ${limit}-word limit (whitespace-delimited).`,
  );
  requireCondition(
    !/\b(?:automated|automatic)\s+(?:responses|replies)\b/i.test(text),
    "source does not establish automated responses/replies.",
  );
  requireCondition(
    !/\b(?:will prevent|prevents|guarantees|will avoid|avoids)\b/i.test(text),
    "unsupported guaranteed outcome.",
  );
  requireCondition(
    !/\b(?:fits?|meets?)\s+(?:the\s+)?(?:team|support)\s+(?:capacity|constraints)\b|\bsufficient capacity\b/i.test(
      text,
    ),
    "source does not establish capacity sufficiency.",
  );
  for (const [id, option] of Object.entries(catalog.options)) {
    const clause = new RegExp(`(?:^|\\bOption )${id}:?\\s+[^.!?\\n]*`, "gim");
    for (const match of text.matchAll(clause)) {
      requireCondition(
        !/\b(?:no|without)\s+human review\b|\brequires? no review\b/i.test(match[0]),
        `unsupported no-review claim for ${id}.`,
      );
      if (option.mode === "manual tags")
        requireCondition(
          !/\b(?:automated triage|automates)\b/i.test(match[0]),
          `unsupported automation for ${id}.`,
        );
    }
  }
  if (["options", "risks"].includes(stageId)) {
    const lines = text
      .trim()
      .split(/\n/)
      .map((line) => line.trim());
    requireCondition(
      lines.length === 2 &&
        lines.some((line) => line.startsWith("A:")) &&
        lines.some((line) => line.startsWith("B:")),
      "both A: and B: lines are required.",
    );
    for (const [id, option] of Object.entries(catalog.options)) {
      const line = lines.find((value) => value.startsWith(`${id}:`));
      if (stageId === "options") {
        const prices = [...line.matchAll(/[$]([0-9]+(?:[.][0-9]+)?)/g)].map((match) =>
          Number(match[1]),
        );
        requireCondition(
          prices.includes(option.priceUsd) &&
            prices.every((price) => [option.priceUsd, catalog.budgetUsd].includes(price)),
          `missing/contradictory price for ${id}.`,
        );
        requireCondition(
          line.toLowerCase().includes("monthly") && line.toLowerCase().includes(option.mode),
          `missing monthly price/mode for ${id}.`,
        );
        requireCondition(
          line.toLowerCase().includes(`human review ${option.humanReview}`),
          `missing/contradictory review status for ${id}.`,
        );
      } else
        requireCondition(
          /\bHypothesis\b/i.test(line) && /\b(?:may|could)\b/i.test(line),
          `risk ${id} must remain an explicit hypothesis.`,
        );
    }
  }
  if (stageId === "report") {
    requireCondition(
      /\bRecommend Option [AB]\b/.test(text),
      "report must identify the recommended source option.",
    );
    if (prompt.includes("labelled Proposed"))
      requireCondition(
        /\bProposed\b/.test(text) && /\b(?:review|audit)\b/i.test(text),
        "changed report requires a proposed human-review safeguard.",
      );
  }
  if (stageId === "summary") {
    const original = dependencies.report.text;
    const choice = /\bRecommend Option ([AB])\b/i.exec(original)?.[1]?.toUpperCase();
    requireCondition(
      choice && /\bRecommend Option ([AB])\b/i.exec(text)?.[1]?.toUpperCase() === choice,
      "summary changed or omitted the report's option.",
    );
    requireCondition(
      /\bProposed\b/i.test(original) === /\bProposed\b/i.test(text),
      "summary changed a safeguard's proposal status.",
    );
    const numbers = original.match(/\b[0-9]+(?:[.][0-9]+)?%?/g) ?? [];
    requireCondition(
      (text.match(/\b[0-9]+(?:[.][0-9]+)?%?/g) ?? []).every((value) => numbers.includes(value)),
      "summary introduced a number absent from its report.",
    );
    for (const cadence of ["daily", "weekly", "monthly"])
      requireCondition(
        !new RegExp(`\\b${cadence}\\b`, "i").test(text) ||
          new RegExp(`\\b${cadence}\\b`, "i").test(original),
        "summary introduced a cadence absent from its report.",
      );
  }
}
