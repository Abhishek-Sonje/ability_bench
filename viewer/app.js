import { COMPONENTS, explanation, layout, status } from "./model.js";

/** @typedef {import('../src/run-manifest.js').RunManifestStage} Stage */
/** @typedef {import('../src/run-manifest.js').FinalizedRunManifest} Run */
/** @typedef {import('../src/evaluation-receipt.js').EvaluationReceipt} Receipt */
/** @typedef {{candidate: Run, baseline: Run | null, diff: import('../src/run-diff.js').RunDiff | null}} Selection */
/** @type {Selection | null} */
let selected = null;
/** @type {Receipt | null} */
let receipt = null;
let runRequest = 0;
let stageRequest = 0;
let receiptRequest = 0;

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}
/** @param {string} tag @param {string} [text] @param {string} [className] */
function el(tag, text = "", className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}
/** @param {string} path @param {Record<string, string>} [query] @returns {Promise<any>} */
async function api(path, query = {}) {
  const response = await fetch(`${path}?${new URLSearchParams(query)}`);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? "The retained data could not be read.");
  return value;
}
/** @param {HTMLElement} target @param {unknown} error */
function showError(target, error) {
  target.replaceChildren(
    el("p", error instanceof Error ? error.message : "Unable to inspect retained data.", "error"),
  );
}
/** @param {string} value */
function short(value) {
  return `${value.slice(0, 16)}…`;
}
/** @param {string} label @param {string} value @param {HTMLElement} [target] */
function identity(label, value, target = byId("identities")) {
  const row = el("div", "", "identity");
  row.append(el("span", label, "muted"), el("span", value, "hash"));
  target.append(row);
}
/** @param {string} label @param {string} value @param {string} note */
function summary(label, value, note) {
  const item = el("div");
  item.append(
    el("p", label, "summary-label"),
    el("p", value, "summary-value"),
    el("p", note, "muted"),
  );
  return item;
}

function summaries() {
  if (!selected) return;
  const { candidate } = selected;
  const counts = [
    "reused",
    "succeeded",
    "failed",
    "skipped_dependency_failed",
    "skipped_run_stopped",
  ].map((state) => candidate.stages.filter((stage) => stage.executionStatus === state).length);
  byId("summaries").replaceChildren(
    summary(
      "Execution result",
      candidate.executionStatus === "completed" ? "Completed" : "Failed",
      `${counts[0]} reused · ${counts[1]} executed · ${counts[2]} failed · ${(counts[3] ?? 0) + (counts[4] ?? 0)} skipped`,
    ),
    summary(
      "Evaluation result",
      receipt?.evaluationStatus ?? "No receipt selected",
      receipt ? `Suite: ${receipt.suiteId}` : "Separate from the execution record",
    ),
    summary(
      "Regression result",
      receipt?.comparisonStatus.replaceAll("_", " ") ?? "Not inspected",
      receipt
        ? `${receipt.summary.regressed} regressed check(s)`
        : "Requires an exact evaluation receipt",
    ),
  );
}

/** @param {string} id */
async function chooseRun(id) {
  const token = ++runRequest;
  ++stageRequest;
  ++receiptRequest;
  selected = null;
  receipt = null;
  byId("inspection").hidden = true;
  byId("empty").hidden = true;
  byId("notice").textContent = "Verifying selected run and recorded baseline…";
  byId("receipt").replaceChildren();
  byId("receipt-notice").replaceChildren();
  /** @type {HTMLInputElement} */ (byId("receipt-id")).value = "";
  try {
    const result = /** @type {Selection} */ (await api("/api/run", { run: id }));
    if (token !== runRequest) return;
    selected = result;
    byId("notice").replaceChildren();
    byId("inspection").hidden = false;
    byId("run-title").textContent = result.baseline ? "Candidate run" : "Immutable baseline run";
    byId("identities").replaceChildren();
    identity("Selected run", result.candidate.id);
    identity("Recorded baseline", result.baseline?.id ?? "None — this run establishes a baseline");
    identity("Recorded at", new Date(result.candidate.createdAt).toLocaleString());
    if (result.baseline) {
      const button = el("button", "Inspect recorded baseline", "identity-link");
      button.addEventListener("click", () => chooseRun(result.baseline?.id ?? ""));
      byId("identities").append(button);
    }
    for (const node of byId("runs").querySelectorAll("button"))
      node.setAttribute("aria-pressed", String(node.dataset["id"] === id));
    const url = new URL(window.location.href);
    url.searchParams.set("run", id);
    window.history.replaceState(null, "", url);
    summaries();
    drawGraph();
    const first =
      result.candidate.stages.find((stage) => stage.executionStatus === "failed") ??
      result.candidate.stages.find((stage) => stage.executionStatus !== "reused") ??
      result.candidate.stages[0];
    if (first) chooseStage(first.stageId);
  } catch (error) {
    if (token === runRequest) showError(byId("notice"), error);
  }
}

function drawGraph() {
  if (!selected) return;
  const stages = selected.candidate.stages;
  byId("stage-count").textContent = `${stages.length} recorded stages`;
  byId("graph").replaceChildren();
  byId("stage-list").replaceChildren();
  for (const stage of stages) {
    const item = el("div", "", "dependency-item");
    const button = el("button", `${stage.stageId} · ${status(stage)}`);
    button.addEventListener("click", () => chooseStage(stage.stageId, true));
    item.append(
      button,
      el("p", `Depends on: ${stage.dependencyIds.join(", ") || "nothing"}`, "muted"),
    );
    byId("stage-list").append(item);
  }
  byId("removed").replaceChildren();
  const removed =
    selected.diff?.stages
      .filter((stage) => stage.kind === "removed")
      .map((stage) => stage.stageId) ?? [];
  if (removed.length)
    byId("removed").append(
      el(
        "p",
        `Baseline-only stages: ${removed.join(", ")}. These are absent from the candidate, not skipped.`,
        "muted",
      ),
    );
  if (stages.length > 100) {
    byId("graph").append(
      el("p", "Diagram limited to 100 stages. Use the complete dependency list below.", "muted"),
    );
    return;
  }
  try {
    const graph = layout([...stages]);
    const canvas = el("div", "", "graph-canvas");
    canvas.style.width = `${graph.width}px`;
    canvas.style.height = `${graph.height}px`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(graph.width));
    svg.setAttribute("height", String(graph.height));
    svg.setAttribute("aria-hidden", "true");
    const nodes = new Map(graph.nodes.map((node) => [node.stage.stageId, node]));
    for (const node of graph.nodes) {
      for (const dependency of node.stage.dependencyIds) {
        const source = nodes.get(dependency);
        if (!source) continue;
        const x = source.x + 110;
        const y = source.y + 76;
        const endX = node.x + 110;
        const endY = node.y;
        const edge = document.createElementNS(svg.namespaceURI, "path");
        // Route edges spanning layers around the nodes, not through an unrelated stage.
        edge.setAttribute(
          "d",
          endY - y > 70
            ? `M ${x} ${y} V ${y + 18} H ${graph.width - 10} V ${endY - 18} H ${endX} V ${endY - 6}`
            : `M ${x} ${y} C ${x} ${y + 20}, ${endX} ${endY - 20}, ${endX} ${endY - 6}`,
        );
        svg.append(edge);
        const arrow = document.createElementNS(svg.namespaceURI, "path");
        arrow.setAttribute(
          "d",
          `M ${endX - 4} ${endY - 7} L ${endX} ${endY - 1} L ${endX + 4} ${endY - 7} Z`,
        );
        arrow.setAttribute("class", "arrow");
        svg.append(arrow);
      }
    }
    canvas.append(svg);
    for (const node of graph.nodes) {
      const button = el("button", "", "stage-node");
      button.style.left = `${node.x}px`;
      button.style.top = `${node.y}px`;
      button.dataset["stage"] = node.stage.stageId;
      button.setAttribute("aria-pressed", "false");
      button.append(
        el("strong", node.stage.stageId),
        el("span", status(node.stage), `status ${node.stage.executionStatus}`),
      );
      button.title = node.stage.stageId;
      button.addEventListener("click", () => chooseStage(node.stage.stageId, true));
      canvas.append(button);
    }
    byId("graph").append(canvas);
  } catch (error) {
    showError(byId("graph"), error);
  }
}

/** @param {string[]} headers @param {string[][]} rows */
function table(headers, rows) {
  const wrap = el("div", "", "table-scroll");
  const element = el("table");
  const head = el("thead");
  const heading = el("tr");
  for (const name of headers) {
    const cell = el("th", name);
    cell.setAttribute("scope", "col");
    heading.append(cell);
  }
  head.append(heading);
  const body = el("tbody");
  for (const row of rows) {
    const item = el("tr");
    for (const value of row) item.append(el("td", value));
    body.append(item);
  }
  element.append(head, body);
  wrap.append(element);
  return wrap;
}

/** @param {string} stageId @param {boolean} [navigate] */
function chooseStage(stageId, navigate = false) {
  if (!selected) return;
  const token = ++stageRequest;
  const stage = selected.candidate.stages.find((item) => item.stageId === stageId);
  if (!stage) return;
  const baseline = selected.baseline?.stages.find((item) => item.stageId === stageId);
  const panel = byId("stage");
  panel.replaceChildren(
    el("h2", stage.stageId),
    el("p", status(stage), `status ${stage.executionStatus}`),
    el("p", explanation(stage), "reason"),
  );
  for (const button of byId("graph").querySelectorAll("button"))
    button.setAttribute("aria-pressed", String(button.dataset["stage"] === stageId));
  const details = el("dl");
  for (const [label, value] of [
    ["Recorded reason", stage.decisionReason],
    ["Planned action → final decision", `${stage.plannedDecision} → ${stage.finalDecision}`],
    ["Actual execution status", stage.executionStatus],
    ["Baseline stage status", baseline ? status(baseline) : "Not present / no baseline"],
  ])
    details.append(el("dt", label), el("dd", value));
  panel.append(details);
  const recorded = stage.decisionDetails;
  for (const [key, value] of Object.entries(recorded))
    panel.append(
      el(
        "p",
        `${key}: ${Array.isArray(value) ? value.join(", ") : JSON.stringify(value)}`,
        "muted recorded",
      ),
    );
  if (stage.error) panel.append(el("p", `${stage.error.name}: ${stage.error.message}`, "error"));
  panel.append(el("h3", "Declared dependencies"));
  if (!stage.dependencyIds.length) panel.append(el("p", "None. This is a root stage.", "muted"));
  for (const id of stage.dependencyIds) {
    const dependency = selected.candidate.stages.find((item) => item.stageId === id);
    const button = el(
      "button",
      `${id} · ${dependency ? status(dependency) : "not recorded"}`,
      "identity-link",
    );
    button.addEventListener("click", () => chooseStage(id, true));
    const line = el("p");
    line.append(button);
    panel.append(line);
  }
  panel.append(el("h3", "Baseline comparison"));
  if (!baseline)
    panel.append(
      el("p", "No corresponding baseline stage. Component comparisons are unavailable.", "muted"),
    );
  else {
    panel.append(
      table(
        ["Evidence", "Compared with baseline"],
        COMPONENTS.map(([key, label]) => {
          const before = baseline.componentHashes?.[key];
          const after = stage.componentHashes?.[key];
          return [
            label,
            before && after
              ? before === after
                ? "Unchanged"
                : "Changed"
              : "Not recorded / unavailable",
          ];
        }),
      ),
    );
    panel.append(
      el(
        "p",
        "These compare recorded hashes only. Raw input values, environment values, and watched filenames were not retained.",
        "muted",
      ),
    );
    panel.append(
      table(
        ["Artifact", "Baseline → candidate"],
        [
          [
            "Output bytes",
            !baseline.outputArtifactHash || !stage.outputArtifactHash
              ? "Comparison unavailable"
              : baseline.outputArtifactHash === stage.outputArtifactHash
                ? "Identical recorded identity"
                : "Different recorded identity",
          ],
        ],
      ),
    );
  }
  const fingerprint = el("details");
  fingerprint.append(el("summary", "Fingerprint identities"));
  identity("Baseline", baseline?.fingerprint ?? "Not recorded", fingerprint);
  identity("Candidate", stage.fingerprint ?? "Not recorded", fingerprint);
  panel.append(fingerprint);
  panel.append(el("h3", "Output artifact"));
  identity("Candidate", stage.outputArtifactHash ?? "No output recorded", panel);
  if (baseline) identity("Baseline", baseline.outputArtifactHash ?? "No output recorded", panel);
  const preview = el("div", "", "preview");
  if (stage.outputArtifactHash || baseline?.outputArtifactHash) {
    const button = el("button", "Inspect recorded outputs", "preview-button");
    const candidateId = selected.candidate.id;
    const baselineId = selected.baseline?.id;
    button.addEventListener("click", async () => {
      /** @type {HTMLButtonElement} */ (button).disabled = true;
      preview.textContent = "Verifying artifacts…";
      try {
        const outputs = await Promise.all([
          api("/api/artifact", { run: candidateId, stage: stageId }),
          baselineId && baseline ? api("/api/artifact", { run: baselineId, stage: stageId }) : null,
        ]);
        if (token !== stageRequest) return;
        preview.replaceChildren();
        for (const [index, output] of outputs.entries()) {
          if (!output) continue;
          preview.append(
            el("h3", index === 0 ? "Candidate output" : "Baseline output"),
            el(
              "p",
              output.verification === "verified"
                ? `Verified canonical JSON · ${output.byteLength} bytes`
                : (output.notice ?? "No output recorded"),
              "muted",
            ),
          );
          if (output.verification === "verified") preview.append(valueTree(output.value, "Output"));
        }
      } catch (error) {
        if (token === stageRequest) showError(preview, error);
      } finally {
        /** @type {HTMLButtonElement} */ (button).disabled = false;
      }
    });
    panel.append(button);
  }
  panel.append(preview);
  if (navigate && window.matchMedia("(max-width: 1200px)").matches) {
    panel.tabIndex = -1;
    panel.focus();
  }
}

/** @param {unknown} value @param {string} label @param {number} [depth] @param {{remaining: number}} [budget] @returns {HTMLElement} */
function valueTree(value, label, depth = 0, budget = { remaining: 300 }) {
  if (budget.remaining <= 0) return el("p", "Preview limited to 300 entries.", "muted");
  budget.remaining--;
  if (value === null || typeof value !== "object") {
    const line = el("dl");
    const text = typeof value === "string" ? value : JSON.stringify(value);
    line.append(el("dt", label), el("dd", text?.slice(0, 4000) ?? "null"));
    if ((text?.length ?? 0) > 4000)
      line.append(el("dd", "Text preview truncated at 4,000 characters."));
    return line;
  }
  const items = Object.entries(value);
  const details = /** @type {HTMLDetailsElement} */ (el("details"));
  details.open = depth === 0;
  details.append(
    el("summary", `${label} · ${items.length} ${Array.isArray(value) ? "items" : "fields"}`),
  );
  if (depth >= 6) details.append(el("p", "Expand depth limited to 6 for this preview.", "muted"));
  else {
    for (const [key, child] of items.slice(0, 30)) {
      details.append(
        valueTree(child, Array.isArray(value) ? `Item ${Number(key) + 1}` : key, depth + 1, budget),
      );
      if (budget.remaining <= 0) break;
    }
    if (items.length > 30)
      details.append(el("p", `Showing 30 of ${items.length} entries.`, "muted"));
  }
  return details;
}

byId("receipt-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selected) return;
  const token = ++receiptRequest;
  const currentRun = runRequest;
  receipt = null;
  summaries();
  byId("receipt").replaceChildren();
  byId("receipt-notice").textContent =
    "Verifying receipt, lineage, criteria, and source artifacts…";
  const button = byId("receipt-form").querySelector("button");
  if (button) button.disabled = true;
  try {
    const value = /** @type {Receipt} */ (
      await api("/api/receipt", {
        run: selected.candidate.id,
        receipt: /** @type {HTMLInputElement} */ (byId("receipt-id")).value.trim(),
      })
    );
    if (token !== receiptRequest || currentRun !== runRequest) return;
    receipt = value;
    summaries();
    byId("receipt-notice").replaceChildren();
    const target = byId("receipt");
    identity("Receipt", value.id, target);
    identity("Criteria artifact", value.criteriaArtifactHash, target);
    target.append(
      table(
        ["Check / stage", "Baseline verdict", "Candidate verdict", "Regression result"],
        value.checks.map((check) => [
          `${check.checkId} / ${check.targetStageId}`,
          check.baseline.verdict ?? `Error: ${check.baseline.error?.message}`,
          check.candidate.verdict ?? `Error: ${check.candidate.error?.message}`,
          check.comparison,
        ]),
      ),
    );
    const details = el("details");
    details.append(el("summary", "Check evidence and recorded diagnostics"));
    for (const check of value.checks)
      details.append(
        valueTree(
          {
            baseline: {
              verdict: check.baseline.verdict,
              details: check.baseline.details,
              error: check.baseline.error,
            },
            candidate: {
              verdict: check.candidate.verdict,
              details: check.candidate.details,
              error: check.candidate.error,
            },
          },
          check.checkId,
        ),
      );
    target.append(details);
  } catch (error) {
    if (token === receiptRequest && currentRun === runRequest)
      showError(byId("receipt-notice"), error);
  } finally {
    if (button) button.disabled = false;
  }
});

try {
  const history = await api("/api/history");
  byId("workflow").textContent = history.workflowId;
  if (!history.runs.length)
    byId("runs").append(
      el(
        "p",
        history.storeStatus === "missing"
          ? "No retained store found. Nothing was created."
          : "No retained runs for this workflow.",
        "muted",
      ),
    );
  for (const run of history.runs) {
    const button = el("button", "", "run-button");
    button.dataset["id"] = run.id;
    button.setAttribute("aria-pressed", "false");
    const time = el("time", new Date(run.createdAt).toLocaleString());
    time.setAttribute("datetime", run.createdAt);
    button.append(
      time,
      el(
        "span",
        `${run.baselineRunId ? "Candidate" : "Baseline"} · ${run.executionStatus}`,
        "muted",
      ),
      el("span", short(run.id), "hash"),
    );
    button.title = run.id;
    button.addEventListener("click", () => chooseRun(run.id));
    byId("runs").append(button);
  }
  const id = new URL(window.location.href).searchParams.get("run");
  if (id) await chooseRun(id);
} catch (error) {
  showError(byId("notice"), error);
  byId("workflow").textContent = "History unavailable";
}
