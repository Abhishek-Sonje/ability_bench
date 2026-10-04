# AbilityBench

AbilityBench is a local developer tool for dependency-aware incremental workflow execution and deterministic evaluation. Its execution engine records immutable run manifests, canonical artifacts, exact baseline lineage, and reasons for every reuse/rerun decision. Evaluation receipts are separate from execution history.

## Read-only viewer milestone

Audience: developers inspecting their own retained workflow runs on their machine.

Job: understand what ran, what reused, what failed or was skipped, and why, within seconds. Compare a candidate with its recorded immutable baseline without reading raw JSON or CLI output.

Confirmed experience: one inspection screen with a run list, recorded baseline, execution/evaluation/regression summaries, historical DAG, and clickable stage details. Artifact previews and fingerprint-component comparisons explain existing records; unavailable information stays explicitly unavailable.

Confirmed implementation: existing Node/TypeScript stack, dependency-light native browser UI, code-first. No frontend framework just for structure. Use the existing verified read boundary and storage format, without importing current workflows.

Boundaries: no workflow editing or execution from the UI, drag-and-drop, authentication, live Gemini, replay, SQLite, cloud, publishing, or execution-engine changes. Read-only localhost inspection only. Real retained Composio and deterministic evaluation histories are acceptance evidence, not invented demonstration records.

Success: a developer can explain every displayed decision, distinguish execution from evaluation from regression, and inspect historical runs even when present-day workflow code is missing.
