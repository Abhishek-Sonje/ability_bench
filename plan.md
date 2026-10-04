# AbilityBench — Plan

> **Current status (2026-10-04):** The revised Phase 0 engine, local execution/evaluation CLI,
> and deterministic evaluation receipts are implemented. The read-only viewer uses the existing
> Node/TypeScript stack and plain browser modules (not the older Next.js proposal below).
> Retained-data checks pass; browser acceptance remains open. See `docs/phase-3-viewer-usage.md`.
> The normative execution
> contract is in `execution-contract.md`, verification and assessment are under `docs/`, and
> Phase 1 currently means the narrow local CLI specified in `docs/phase-1-cli.md`. Those documents
> supersede older implementation details in this original product plan where they conflict.

> **Working idea:** Change one part of your agent. Rerun only what the change could affect.

AbilityBench is a local-first developer tool for testing expensive AI agents without blindly rerunning the entire workflow after every change.

The core problem is simple:

A developer changes one prompt, model, tool, or piece of agent logic. Today, the easiest way to check whether the agent got better or worse is often to run the whole workflow again. That wastes LLM tokens, external API credits, browser/tool calls, and developer time.

AbilityBench records previous runs, understands the dependency graph of the workflow, detects what changed, reuses work that is still valid, reruns the affected parts, and compares the result with the previous run.

It is primarily a **development and CI tool**, not something that needs to sit in the production request path.

---

## 1. Product Goal

Build a lightweight developer tool that can answer:

> **“I changed my agent. What actually needs to run again?”**

The product should help developers:

- avoid rerunning expensive unchanged stages
- avoid repeating external tool/API calls when possible
- compare an old agent version with a new one
- detect regressions
- understand why a stage was rerun
- see how much time, cost, and tokens were saved

AbilityBench should feel closer to **Vitest / Playwright / pytest for expensive AI workflows** than to an observability SaaS.

---

## 2. Who It Is For

Primary users:

- AI Product Engineers
- Applied AI Engineers
- agent developers
- full-stack engineers building AI products
- backend engineers working on agent pipelines
- developers building research agents, browser agents, support agents, coding agents, or internal automation

Best initial use case:

A multi-step agent where some stages are expensive and can be reused safely.

Example:

```text
Discover companies
      ↓
Research websites
      ↓
Inspect GitHub
      ↓
Analyze evidence
      ↓
Rank companies
      ↓
Generate report
```

If only the ranking logic changes, rerunning discovery, scraping, GitHub research, and analysis may be unnecessary.

---

## 3. Core Product Thesis

AbilityBench is **not**:

- another generic agent observability platform
- another LangSmith clone
- another trace viewer
- another MCP recorder
- another prompt playground
- another general-purpose evaluation platform

Its main idea is:

> **Dependency-aware incremental evaluation for AI agents.**

Internally:

```text
change
  ↓
impact analysis
  ↓
determine stale stages
  ↓
reuse valid artifacts
  ↓
rerun affected stages
  ↓
compare results
```

---

## 4. Main Features

### 4.1 Record Agent Runs

AbilityBench records enough information about a run to reuse or compare it later.

For each stage:

- stage name
- input
- output
- code fingerprint
- prompt fingerprint
- model configuration
- tool dependencies
- upstream dependencies
- token usage
- latency
- estimated cost
- status
- timestamp

For external tool calls:

- tool name
- arguments
- response reference
- latency
- success/failure

---

### 4.2 Detect What Changed

AbilityBench determines whether a stage is still valid by comparing fingerprints.

Possible change sources:

- code changed
- prompt changed
- model changed
- model settings changed
- tool schema changed
- upstream stage changed
- explicit developer invalidation
- environment/config changed

The first version should be conservative.

If AbilityBench is uncertain whether a previous result is safe to reuse:

> **rerun it**

False reuse is worse than an unnecessary rerun.

---

### 4.3 Rerun Only Affected Stages

Example:

```text
Discover → Research → Analyze → Rank → Report
```

Developer changes:

```text
prompts/rank.ts
```

AbilityBench should produce:

```text
Discover    REUSE
Research    REUSE
Analyze     REUSE
Rank        RERUN
Report      RERUN
```

The `Report` stage reruns because it depends on `Rank`.

---

### 4.4 Reuse Previous Stage Outputs

If a stage is still valid, AbilityBench should load its previous output rather than execute it again.

This is where real LLM-token savings can happen.

Example:

```text
Research stage:
34,000 tokens

Analyze stage:
12,000 tokens

Rank stage:
4,000 tokens
```

If only Rank changes, AbilityBench can potentially avoid the first 46,000 tokens.

Actual savings must always be measured, not assumed.

---

### 4.5 Tool Record and Replay

Tool replay is a supporting feature, not the main product.

During a recorded run:

```text
Agent
  ↓
AbilityBench
  ↓
External Tool
```

AbilityBench stores the tool request and response.

During replay:

```text
Agent
  ↓
AbilityBench
  ↓
Stored Tool Response
```

This can avoid:

- repeated API credits
- rate limits
- browser sessions
- scraping costs
- external side effects
- changing test data

It also creates a more deterministic test environment.

Important:

**Tool replay does not automatically save LLM tokens.**

The LLM still runs unless the whole stage is reused from a checkpoint.

---

### 4.6 Compare Runs

AbilityBench should make it easy to compare:

```text
Previous version
vs
Current version
```

Useful metrics:

- task success
- test pass rate
- token usage
- estimated LLM cost
- tool-call count
- tool/API cost when known
- latency
- stages executed
- stages reused
- regressions

---

### 4.7 Show Savings

One of the most understandable product outputs should be:

```text
Reused stages:       4 / 6
Executed stages:     2 / 6

Tokens avoided:      41,280
Tool calls avoided:  67
Time avoided:        4m 12s
Estimated savings:   $1.21
```

These values should be based on previous recorded measurements.

Never claim savings that AbilityBench cannot calculate.

---

## 5. MVP Scope

The MVP must stay small.

### MVP should include

- TypeScript SDK
- local CLI
- explicit stage-based workflow
- stage dependency graph
- stage output caching
- fingerprints
- safe invalidation
- incremental reruns
- run comparison
- basic tool-call recording
- local storage
- small local web UI
- token/cost/time metrics

### MVP should NOT include

- hosted cloud
- organizations
- teams
- billing
- auth system
- production monitoring
- arbitrary framework support
- Python SDK
- advanced distributed execution
- automatic GitHub PR comments
- complex AI-generated evals
- every agent framework
- every model provider
- enterprise security features
- automatic semantic dependency inference

Those can come later if the core works.

---

## 6. First Integration Strategy

The first version should be **TypeScript-first**.

Do not try to transparently understand every agent framework.

Instead, give developers a small explicit API.

Example:

```ts
import { workflow } from "abilitybench";

const run = workflow("startup-research");

const companies = await run.stage(
  "discover",
  async () => discoverCompanies()
);

const research = await run.stage(
  "research",
  { dependsOn: ["discover"] },
  async () => researchCompanies(companies)
);

const ranked = await run.stage(
  "rank",
  { dependsOn: ["research"] },
  async () => rankCompanies(research)
);
```

The API should remain small.

Possible later improvement:

```ts
stage("rank", {
  deps: ["research"],
  prompt: rankPrompt,
  model: modelConfig
}, fn);
```

The MVP should prefer explicit dependencies over trying to infer them magically.

Explicit dependencies are:

- easier to build
- easier to explain
- safer
- more predictable

---

## 7. Why Explicit Stages Are Acceptable

AbilityBench is a development tool.

A small amount of test-oriented instrumentation is acceptable if the payoff is clear.

However:

- AbilityBench should not pollute production logic heavily
- the SDK should be removable
- stages should be simple wrappers
- production behavior should remain the same
- developers should be able to disable AbilityBench completely

Eventually we can support adapters or proxies that require less instrumentation.

The MVP should optimize for correctness over magic.

---

## 8. Internal Workflow

### First Run

```text
Developer starts AbilityBench
        ↓
Load workflow definition
        ↓
Build dependency graph
        ↓
Stage A executes
        ↓
Save fingerprint + output + metrics
        ↓
Stage B executes
        ↓
Save fingerprint + output + metrics
        ↓
...
        ↓
Save complete run
```

---

### Second Run

```text
Load previous successful run
        ↓
Calculate current stage fingerprints
        ↓
Compare fingerprints
        ↓
Mark changed stages stale
        ↓
Propagate invalidation downstream
        ↓
Reuse valid stages
        ↓
Execute stale stages
        ↓
Save candidate run
        ↓
Compare candidate with baseline
```

---

## 9. Dependency Graph

Example:

```text
        ┌────────── GitHub ─────────┐
Discover                           Analyze → Rank → Report
        └───────── Careers ─────────┘
```

Internally:

```json
{
  "discover": [],
  "github": ["discover"],
  "careers": ["discover"],
  "analyze": ["github", "careers"],
  "rank": ["analyze"],
  "report": ["rank"]
}
```

If `github` changes:

```text
Discover    VALID
GitHub      STALE
Careers     VALID
Analyze     STALE
Rank        STALE
Report      STALE
```

---

## 10. Fingerprinting

Each stage needs a fingerprint representing the things that can affect its output.

Possible inputs:

```text
stage function/code
prompt
model name
model configuration
tool definitions
explicit inputs
environment keys selected by developer
upstream artifact hashes
AbilityBench stage config
```

Conceptually:

```text
fingerprint =
hash(
  code +
  prompt +
  modelConfig +
  toolSchemas +
  inputHashes +
  upstreamHashes
)
```

If the fingerprint matches the previous successful run:

```text
candidate for reuse
```

If it differs:

```text
rerun
```

---

## 11. Conservative Invalidation Rules

Initial rules:

### Prompt changed

Rerun that stage and all downstream dependents.

### Model changed

Rerun every stage using that model and all downstream dependents.

### Model parameters changed

Rerun the affected stage and downstream stages.

Example:

```text
temperature
top_p
reasoning settings
```

### Stage code changed

Rerun that stage and downstream dependents.

### Input changed

Rerun the stage and downstream dependents.

### Tool schema changed

Rerun stages depending on that tool.

### Upstream stage reran with different output

Invalidate downstream stages.

### Unknown/uncertain dependency

Rerun.

Safety principle:

```text
REUSE only when confidently valid.
```

---

## 12. Important Hard Problem: Code Fingerprints

Hashing the full repository is too aggressive.

Hashing only one function may miss imported dependencies.

MVP options:

### Option A — developer-declared files

```ts
stage("rank", {
  watch: [
    "./src/rank.ts",
    "./prompts/rank.txt"
  ]
})
```

Very simple and predictable.

### Option B — import graph analysis

AbilityBench traces imports from the stage module.

More automatic, but harder.

### Recommended MVP

Start with:

- stage callback identity
- explicit `watch` files
- prompt hash
- model config hash
- upstream hashes

Then later add smarter static dependency analysis.

Do not delay the MVP trying to perfectly understand arbitrary JavaScript dependency graphs.

---

## 13. Artifact Storage

The user raised an important concern:

Agent outputs and tool responses can be large.

We should not duplicate large payloads for every run.

Use content-addressed storage.

Example:

```text
response
  ↓
SHA-256
  ↓
a91fd842...
```

Save once:

```text
.abilitybench/
  objects/
    a91fd842...
```

Runs reference the hash:

```json
{
  "stage": "research",
  "output": "a91fd842..."
}
```

If another run produces the exact same output, no second copy is needed.

---

## 14. Local Storage Architecture

Possible layout:

```text
.abilitybench/
├── abilitybench.db
├── objects/
│   ├── a91fd842...
│   ├── 83bd831c...
│   └── ...
├── runs/
└── config.json
```

### SQLite

Use for metadata:

- workflows
- runs
- stages
- dependencies
- fingerprints
- metrics
- tool calls
- artifact references

### Object files

Use for:

- large JSON responses
- tool outputs
- LLM outputs
- stage artifacts

Compress large text/JSON artifacts.

Potential options:

- gzip
- Brotli
- zstd

Choose the simplest reliable option for MVP.

---

## 15. Storage Rules

Initial defaults could be:

```ts
storage: {
  local: true,
  compression: true,
  maxObjectSize: "10mb",
  retentionDays: 30
}
```

Also support:

```bash
abilitybench clean
```

and:

```bash
abilitybench clean --older-than 14d
```

Later:

```bash
abilitybench gc
```

for unreferenced artifacts.

---

## 16. LLM Recording

Store:

- provider
- model
- request metadata
- prompt/input reference
- output reference
- input tokens
- output tokens
- cost when known
- latency
- error

LLM responses are primarily used for:

- run comparison
- debugging
- metrics
- history

Do not treat replaying old LLM outputs as the normal evaluation path.

If testing a changed prompt/model, the LLM must actually execute.

---

## 17. Tool Recording

Store:

```text
tool name
arguments hash
arguments
response hash
response
latency
status
timestamp
```

Later replay matching can be:

```text
tool name + normalized arguments
```

Example:

```text
github.search
+
{"query":"agent infrastructure"}
```

→ stored result.

---

## 18. Tool Replay Modes

Later support:

### Live

Always call the external tool.

### Replay

Use a matching previously recorded result.

### Auto

Use recorded result when safe, otherwise call live tool.

For MVP, this can be basic.

Do not build an extremely complicated VCR system immediately.

---

## 19. Side Effects

Some tools perform real actions:

```text
send_email
refund_payment
create_ticket
delete_file
post_message
```

Replaying previously recorded responses lets a developer test the agent without repeating those actions.

Future feature:

```ts
toolPolicy: {
  "email.send": "replay-only",
  "stripe.refund": "block",
  "github.search": "live"
}
```

Not required for first MVP, but worth designing for.

---

## 20. Evaluation Model

AbilityBench should not try to invent a universal “agent score.”

Let developers define assertions.

Examples:

```ts
expect(result.companies.length).toBeGreaterThan(10);
expect(result.invalidCompanies).toHaveLength(0);
```

or:

```ts
evals: {
  validCompanyRate: result => ...,
  evidenceCoverage: result => ...
}
```

AbilityBench stores these metrics per run.

Then it can compare:

```text
Baseline
vs
Candidate
```

---

## 21. Run Comparison

Example:

```text
                   BASELINE     CURRENT

Success               82%          91%
Tokens              68,240       19,310
Tool calls              94           21
Time                  7m12s        2m03s
Cost                  $2.14        $0.61
```

Also show:

```text
Improved:
+ ranking accuracy

Regressed:
- company diversity

Unchanged:
= evidence coverage
```

---

## 22. CLI

The CLI should be the primary developer interface.

Possible commands:

```bash
abilitybench init
```

Creates configuration.

```bash
abilitybench run
```

Runs the workflow incrementally.

```bash
abilitybench run --full
```

Ignores cache and executes everything.

```bash
abilitybench run --from rank
```

Manually reruns from a stage.

```bash
abilitybench runs
```

Lists previous runs.

```bash
abilitybench diff <run-a> <run-b>
```

Compares runs.

```bash
abilitybench ui
```

Starts local dashboard.

```bash
abilitybench clean
```

Cleans stored artifacts.

---

## 23. Example CLI Experience

```text
$ abilitybench run

AbilityBench

Workflow: startup-research
Baseline: run_023

Checking changes...

✓ discover        reused
✓ github          reused
✓ careers         reused
✓ analyze         reused
↻ rank            changed
↻ report          dependency changed

Running 2/6 stages...

rank              3.2s
report            5.7s

Done.

Passed:             18/20 → 19/20
Tokens:             54,210 → 8,940
Tool calls:         72 → 4
Time:               5m31s → 12s

Reused:             4 stages
Tokens avoided:     45,270
Tool calls avoided: 68

Open report:
http://localhost:4317/runs/run_024
```

This output itself should feel satisfying.

---

## 24. Local Product UI

The UI should be small.

Do not build a large SaaS dashboard.

Three screens are enough.

---

### Screen 1 — Runs

Show recent runs.

```text
run_024
19/20 passed
8.9k tokens
12s
4/6 stages reused

run_023
18/20 passed
54.2k tokens
5m31s
full run
```

Allow selecting two runs for comparison.

---

### Screen 2 — Impact Graph

This is the signature visual.

Example:

```text
Discover      REUSED
   ├─ GitHub  REUSED
   └─ Careers REUSED
        ↓
Analyze       REUSED
        ↓
Rank          RERUN
        ↓
Report        RERUN
```

Clicking a stage shows why:

```text
Rank

Status:
RERUN

Reason:
prompt fingerprint changed

Changed:
prompts/rank.ts

Previous fingerprint:
8d932...

Current fingerprint:
139ac...
```

---

### Screen 3 — Stage Detail

Show:

- status
- reason for reuse/rerun
- inputs
- output
- LLM calls
- tool calls
- tokens
- latency
- cost
- previous vs current output

This is useful both technically and visually for demos.

---

## 25. Landing Page

Yes, AbilityBench should have a polished landing page.

Purpose:

- explain the problem quickly
- make the GitHub project feel like a real developer product
- give AI Product Engineer signal
- provide a strong visual demo

Avoid:

- fake testimonials
- fake customer logos
- generic AI gradients
- pricing cards
- fake enterprise claims
- excessive sections
- “revolutionary AI-powered platform” language

---

### Landing Page Hero

Possible headline:

> **Change one part of your agent. Rerun only what matters.**

Subtext:

> AbilityBench reuses valid work from previous agent runs, reruns affected stages, and shows whether your change actually improved the agent.

Buttons:

```text
View on GitHub
Read Docs
```

Terminal snippet:

```bash
npm i -D abilitybench
npx abilitybench run
```

---

### Signature Hero Visual

```text
Changed:
prompts/rank.ts

────────────────────

Discover      ✓ reused
GitHub        ✓ reused
Careers       ✓ reused
Analyze       ✓ reused
Rank          ↻ rerun
Report        ↻ rerun

────────────────────

Saved

45k tokens
68 tool calls
4m 53s
```

A visitor should understand the product in five seconds.

---

## 26. Visual Style

Aim for:

- dark or neutral developer-tool interface
- restrained typography
- strong monospace usage where useful
- minimal color
- clear graph states
- generous whitespace
- no futuristic AI aesthetic

Reference feeling:

- Linear
- Vercel
- Resend
- modern CLI/devtools products

Not copies, only the level of restraint.

---

## 27. Recommended Tech Stack

Keep the stack close to what is already productive.

### Core

- TypeScript
- Node.js

### CLI

- `commander` or `citty`
- `ora` / minimal terminal output if necessary

### Local storage

- SQLite
- Drizzle ORM or lightweight direct SQLite library

### Hashing

- Node `crypto`

### Compression

- built-in zlib/Brotli initially

### UI

- Next.js
- TypeScript
- Tailwind
- React Flow only if the dependency graph actually benefits from it

### Validation

- Zod

### Monorepo

Possible:

```text
apps/
  web/

packages/
  core/
  cli/
  sdk/
```

Do not add a monorepo merely for appearance. Use it only if packages genuinely help.

---

## 28. Suggested Repository Structure

```text
abilitybench/
├── packages/
│   ├── core/
│   │   ├── graph/
│   │   ├── fingerprints/
│   │   ├── executor/
│   │   ├── artifacts/
│   │   ├── storage/
│   │   └── compare/
│   │
│   ├── sdk/
│   │   └── src/
│   │
│   └── cli/
│       └── src/
│
├── apps/
│   └── web/
│
├── examples/
│   └── research-agent/
│
└── plan.md
```

---

## 29. Core Data Model

### Workflow

```ts
type Workflow = {
  id: string;
  name: string;
};
```

### Stage

```ts
type Stage = {
  id: string;
  workflowId: string;
  name: string;
  dependencies: string[];
};
```

### Run

```ts
type Run = {
  id: string;
  workflowId: string;
  createdAt: Date;
  baselineRunId?: string;
  status: "running" | "passed" | "failed";
};
```

### StageRun

```ts
type StageRun = {
  runId: string;
  stageId: string;

  fingerprint: string;

  status:
    | "executed"
    | "reused"
    | "failed";

  inputArtifact?: string;
  outputArtifact?: string;

  inputTokens?: number;
  outputTokens?: number;

  latencyMs?: number;
  estimatedCost?: number;

  invalidationReason?: string;
};
```

### Artifact

```ts
type Artifact = {
  hash: string;
  size: number;
  encoding: string;
  compressed: boolean;
  createdAt: Date;
};
```

---

## 30. Core Algorithm

Pseudo logic:

```ts
for (const stage of topologicalSort(graph)) {
  const currentFingerprint =
    calculateFingerprint(stage);

  const previous =
    findPreviousStageRun(stage);

  const upstreamChanged =
    stage.dependencies.some(
      dep => state[dep].outputChanged
    );

  const reusable =
    previous &&
    previous.fingerprint === currentFingerprint &&
    !upstreamChanged;

  if (reusable) {
    state[stage.id] = reuse(previous);
    continue;
  }

  const result = await execute(stage);

  state[stage.id] = result;
}
```

Then compare the completed run against the baseline.

This should remain understandable.

---

## 31. Output Equality

A rerun stage may produce the exact same output.

Example:

```text
fingerprint changed
→ stage reruns
→ output hash is unchanged
```

If the downstream stage depends only on that output, we may eventually avoid invalidating it.

Example:

```text
Rank implementation changed
        ↓
Rank reruns
        ↓
output is identical
        ↓
Report may remain reusable
```

This is a powerful optimization.

However, it adds complexity.

### Recommendation

Do not make output-equality propagation part of the first implementation.

Initial MVP:

```text
stage changed → downstream reruns
```

Later:

```text
stage changed
→ rerun
→ if output unchanged
→ stop invalidation propagation
```

This can become a strong V2 feature.

---

## 32. Test Cases for the Engine

The engine must have deterministic unit tests.

### Case 1

```text
A → B → C
```

No changes.

Expected:

```text
A reuse
B reuse
C reuse
```

### Case 2

B code changes.

Expected:

```text
A reuse
B execute
C execute
```

### Case 3

A prompt changes.

Expected:

```text
A execute
B execute
C execute
```

### Case 4

Independent branch:

```text
   B
  /
A
  \
   C
```

B changes.

Expected:

```text
A reuse
B execute
C reuse
```

### Case 5

Tool schema used only by C changes.

Expected:

```text
A reuse
B reuse
C execute
```

### Case 6

Unknown dependency.

Expected:

```text
rerun rather than unsafe reuse
```

---

## 33. Example Agent for Development

Build AbilityBench alongside a realistic example.

Recommended:

### Startup Research Agent

Stages:

```text
discover
   ↓
researchWeb
   ↓
researchGitHub
   ↓
analyze
   ↓
rank
   ↓
report
```

Why this example is useful:

- expensive web/tool operations
- multiple LLM calls
- clear dependencies
- easy to intentionally change one stage
- easy to measure saved work
- close to a real problem already experienced
- makes for a strong demo

Do not make the example itself the main project.

It exists to prove AbilityBench.

---

## 34. Demo Scenario

### Baseline

Run full agent:

```text
6 stages
53k tokens
74 tool calls
5m 20s
$2.04
```

Result:

```text
17/20 tests passed
```

### Change

Modify only ranking prompt.

```diff
- prioritize popularity
+ prioritize active OSS + low contributor saturation
```

### AbilityBench

```text
discover       reused
researchWeb    reused
researchGitHub reused
analyze        reused
rank           rerun
report         rerun
```

Candidate:

```text
19/20 tests passed

9k tokens
5 tool calls
47s
$0.39
```

Then show:

```text
65 tool calls avoided
44k tokens avoided
4m33s avoided
```

This should become the core launch video.

---

## 35. CI Direction — Later

Eventually:

```yaml
- run: npx abilitybench run
```

Pull request output:

```text
Agent regression detected.

Pass rate:
92% → 84%

Affected stage:
rank

Regression:
company-activity-eval
```

CI is valuable, but not necessary for the first working prototype.

---

## 36. Security and Privacy

Because agent runs may contain private information:

### MVP principles

- local-first
- no automatic uploads
- no AbilityBench cloud
- secrets excluded where possible
- configurable redaction

Possible config:

```ts
redact: [
  "authorization",
  "apiKey",
  "password",
  "cookie"
]
```

Also allow:

```ts
recordInput: false
```

for sensitive stages.

This does not need enterprise-grade policy management initially.

---

## 37. Failure Modes We Must Handle

### Cached artifact missing

Rerun the stage.

### Cached artifact corrupted

Rerun the stage.

### Fingerprint algorithm changes

Invalidate safely.

### Stage removed

Remove from current graph, retain historical run metadata.

### Stage renamed

Treat as new stage initially.

### Circular dependency

Fail before execution.

### Failed previous run

Do not reuse failed output by default.

### Tool response too large

Respect storage limits and mark it non-replayable if necessary.

---

## 38. Important Product Rules

### Rule 1

Never silently reuse something when AbilityBench is uncertain.

### Rule 2

Always explain why a stage was reused or rerun.

Bad:

```text
Rank reran.
```

Good:

```text
Rank reran because prompts/rank.ts changed.
```

### Rule 3

Do not claim agent quality improved without an evaluation metric.

Lower token usage alone does not mean better.

### Rule 4

Do not call tool replay “token savings.”

Stage reuse saves LLM work.

Tool replay primarily saves external calls, money, time, and side effects.

### Rule 5

No hidden magic in the MVP.

Explicit and understandable behavior is better.

---

## 39. Development Phases

# Phase 0 — Technical Spike

Goal:

Prove incremental stage reuse works.

Build only:

```text
A → B → C
```

Requirements:

- run once
- store outputs
- modify B
- rerun
- A reused
- B reruns
- C reruns

No web UI.

No LLM integration required yet.

Success condition:

The invalidation engine behaves correctly.

---

# Phase 1 — Core Engine

Build:

- workflow definition
- stage API
- DAG validation
- topological execution
- stage fingerprints
- artifact storage
- SQLite metadata
- reuse/rerun logic
- CLI output

Target command:

```bash
abilitybench run
```

At the end of this phase, the product idea must already work.

---

# Phase 2 — Real AI Workflow

Integrate:

- one LLM provider
- token accounting
- model metadata
- one or two tool types
- startup research example

Measure:

- full run
- partial rerun
- tokens saved
- time saved
- tool calls saved

This is the point where we validate whether AbilityBench delivers meaningful value.

---

# Phase 3 — Run Comparison

Add:

- baseline vs candidate
- metrics
- simple eval assertions
- regressions
- savings report

CLI:

```bash
abilitybench diff
```

---

# Phase 4 — Local UI

Build the three screens:

1. Runs
2. Impact Graph
3. Stage Detail

Do not expand beyond these until the core experience is good.

---

# Phase 5 — Tool Replay

Add:

- tool request recording
- response artifacts
- argument matching
- replay mode
- live/replay indicator

Validate using:

- web research call
- GitHub API call
- safe mock side-effecting tool

MCP support can be explored here.

---

# Phase 6 — Landing Page + Public Release

Build:

- minimal landing page
- documentation
- example repo
- launch demo
- clear README
- architecture explanation

Open source the project.

Possible license:

```text
MIT
```

---

## 40. Milestones

### Milestone 1

Incremental DAG engine works locally.

### Milestone 2

Real LLM agent demonstrates measurable token savings.

### Milestone 3

Run comparison catches an intentional regression.

### Milestone 4

Tool replay prevents repeated external calls.

### Milestone 5

Local UI clearly communicates impact and savings.

### Milestone 6

Public demo + GitHub release.

---

## 41. Validation Questions

Before spending too much time, prove these:

### Technical

Can we reliably fingerprint stages?

Can we safely determine downstream invalidation?

Can large artifacts be stored cheaply enough?

Can outputs be reused without changing program behavior?

### Product

Does partial rerunning save meaningful cost on a realistic workflow?

Does the developer understand why a stage was reused?

Is adding stages simple enough?

Would a developer prefer this over manually splitting scripts and caching outputs?

### Career signal

Does the final project demonstrate:

- AI system understanding
- product thinking
- backend architecture
- developer experience
- evaluation
- cost/latency awareness
- frontend/product polish

If the answer becomes “mostly cache library,” we need to rethink the product.

---

## 42. Kill Criteria

We should be willing to stop the project if any of these become true.

### Kill if:

- incremental execution requires so much manual setup that normal caching is easier
- dependency invalidation cannot be made trustworthy
- realistic agent workflows save very little
- existing tools ship essentially the same developer experience before AbilityBench is mature
- the project becomes mostly a generic tracing dashboard
- the MVP requires supporting many frameworks before being useful
- developers must rewrite their architecture around AbilityBench

The goal is not to protect the idea.

The goal is to build something genuinely useful and technically defensible.

---

## 43. Possible V2 Features

Only after MVP works:

- automatic import dependency analysis
- output-equality invalidation stopping
- MCP proxy
- GitHub Actions integration
- PR comments
- Python SDK
- remote shared artifacts
- team baselines
- distributed execution
- model/provider comparison
- automatic eval subset selection
- semantic output comparison
- production traces → regression tests
- replay policies for side-effecting tools
- artifact encryption
- test impact prediction

---

## 44. Possible Naming

AbilityBench is a good working name because it communicates testing.

But the product is becoming more about incremental execution than generic benchmarking.

Potential later names could emphasize:

```text
delta
impact
reuse
incremental
rerun
checkpoint
```

Do not spend serious time naming until the core engine works.

---

## 45. One-Sentence Pitch

> **AbilityBench finds what your agent change can affect, reuses everything else, and reruns only the work needed to test it.**

Shorter:

> **Change your agent. Rerun only what matters.**

---

## 46. What Makes the Project Technically Interesting

The interesting problems are not the UI.

They are:

- DAG execution
- cache invalidation
- change-impact analysis
- deterministic fingerprints
- artifact reuse
- content-addressed storage
- checkpointing
- tool replay
- evaluation comparison
- token/cost measurement
- safe conservative invalidation

That gives the project genuine backend/system depth while still leaving room for a polished AI-native developer product.

---

## 47. What This Project Should Prove About the Builder

The finished project should communicate:

> I understand that building an agent is only part of the problem.

> I understand how expensive and nondeterministic agent development becomes.

> I can reason about execution graphs, caching, invalidation, storage, tools, LLM costs, and evaluation.

> I can turn that systems problem into a product developers can actually use.

That combination is what makes AbilityBench useful for AI Product Engineer, Applied AI Engineer, AI-native startup engineer, backend, and full-stack AI roles.

---

# Final MVP

If the project starts becoming confusing, return to this:

```text
1. Developer defines a multi-stage agent workflow.

2. AbilityBench runs it and records each stage.

3. Developer changes one stage.

4. AbilityBench detects the changed stage.

5. Valid earlier stages are reused.

6. Changed + downstream stages rerun.

7. AbilityBench compares the two runs.

8. Developer sees:
   - did quality improve?
   - what reran?
   - what was reused?
   - how many tokens/tool calls/time were avoided?
```

If we can make those eight steps work extremely well, we have a strong project.

Everything else is optional.
