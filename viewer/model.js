/** @typedef {import('../src/run-manifest.js').RunManifestStage} Stage */
/** @param {Stage} stage */
export function status(stage) {
  return {
    pending: "Not started",
    reused: "Reused",
    succeeded: "Executed",
    failed: "Failed",
    skipped_dependency_failed: "Skipped · dependency failed",
    skipped_run_stopped: "Skipped · run stopped",
  }[stage.executionStatus];
}

/** @param {Stage} stage */
export function explanation(stage) {
  if (stage.executionStatus === "skipped_dependency_failed")
    return "Not executed because a declared dependency failed or was skipped. This is a dependency block; it does not imply that an unrelated branch failed.";
  if (stage.executionStatus === "skipped_run_stopped")
    return "Not executed because an earlier failure stopped this run under fail-fast policy. Its own dependencies need not have failed.";
  const reasons = {
    no_baseline:
      "There is no baseline for this run. Every stage must execute to establish the baseline.",
    manual_invalidation: "This stage was explicitly invalidated for this run.",
    volatile_stage: "This stage is volatile and always executes.",
    cache_disabled:
      "Caching is disabled for this stage. Its previous output cannot replace execution.",
    dependency_executed:
      "At least one declared dependency was planned to execute. Conservative invalidation reruns this stage even if that dependency produces identical bytes.",
    stage_missing_from_baseline: "This stage was not present in the recorded baseline.",
    baseline_stage_not_reusable: "The baseline stage did not have a successful reusable output.",
    baseline_artifact_unavailable:
      "The baseline output artifact was unavailable when the run was planned.",
    fingerprint_changed: "The declared fingerprint changed relative to the recorded baseline.",
    fingerprint_match:
      "The declared fingerprint matched the recorded baseline and its output was available for reuse.",
  };
  const reason =
    reasons[/** @type {keyof typeof reasons} */ (stage.decisionReason)] ??
    `Recorded decision reason: ${stage.decisionReason}.`;
  return stage.executionStatus === "failed"
    ? `${reason} Execution was attempted and failed; see the recorded error below.`
    : reason;
}

/** @param {Stage[]} stages */
export function layout(stages) {
  const remaining = new Map(stages.map((stage) => [stage.stageId, stage]));
  /** @type {Map<string, number>} */
  const depths = new Map();
  /** @type {Stage[][]} */
  const layers = [];
  while (remaining.size) {
    const ready = [...remaining.values()]
      .filter((stage) => stage.dependencyIds.every((id) => depths.has(id)))
      .sort((a, b) => a.stageId.localeCompare(b.stageId));
    if (!ready.length)
      throw new Error("Recorded dependencies are missing or cyclic; the graph cannot be drawn.");
    for (const stage of ready) {
      const depth = Math.max(-1, ...stage.dependencyIds.map((id) => depths.get(id) ?? -1)) + 1;
      depths.set(stage.stageId, depth);
      layers[depth] ??= [];
      layers[depth].push(stage);
      remaining.delete(stage.stageId);
    }
  }
  const width = Math.max(1, ...layers.map((layer) => layer.length)) * 236 + 32;
  const nodes = layers.flatMap((layer, depth) =>
    layer.map((stage, index) => ({
      stage,
      x: (width - layer.length * 236) / 2 + index * 236 + 8,
      y: depth * 116 + 24,
    })),
  );
  return { nodes, width, height: layers.length * 116 + 8 };
}

export const COMPONENTS = /** @type {const} */ ([
  ["selectedInputs", "Declared inputs"],
  ["environment", "Declared environment"],
  ["watchedFiles", "Watched file bytes"],
  ["implementation", "Implementation identity"],
  ["dependencies", "Dependency artifacts"],
  ["cachePolicy", "Cache policy"],
  ["codec", "Output codec"],
]);
