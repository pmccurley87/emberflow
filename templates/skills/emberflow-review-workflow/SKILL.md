---
name: emberflow-review-workflow
description: Use to code-review an Emberflow API operation before it ships — after authoring or modeling one, or when asked to check/audit/review an existing operation. A rubric covering HTTP trigger + auth, wiring integrity, branch coverage, effects/safe-mode correctness, determinism, and readability. Reports findings by severity; does not rubber-stamp.
metadata:
  version: 2.4.0
---

# Reviewing an Emberflow operation

Read **emberflow-basics** for the mechanics. Review the operation JSON, its
scenario sidecar, any `_meta.json` in its path, and any custom nodes it uses.
Report findings by severity (Critical / Important / Minor) with the node id or
file:line. Do not approve an operation with an open Critical or Important
finding. Verify, don't assume — run the scenarios.

## 0. HTTP trigger, id, and auth (for operations with `http`)

- **`id` matches the file path.** The in-file `id` MUST equal the file's path
  relative to the apis dir (`emberflow/apis/billing/charge.json` → `"billing/charge"`).
  A mismatch makes the op unreachable — Critical.
- **`http` is sane.** `{ method, path }` — method is a real HTTP verb; path is
  well-formed and doesn't collide with another operation's method+path. Params in
  the path (`/users/:id`) are actually read from `input.params`.
- **Terminus is `Response`, not `Result`.** An HTTP operation must end in a
  `Response` node emitting `{ status, body }` (status omitted → 200). An HTTP op
  ending in `Result` produces no wire response — Critical. Each branch that
  returns to the client reaches a `Response` with the right status.
- **Auth is intentional.** Resolve the effective policy: nearest ancestor
  `_meta.json` `auth`, then the op's `http.auth` override (`'none'` = public,
  policy object = that policy, `'inherit'`/absent = inherited). A should-be-
  protected endpoint that resolves to public (no `_meta.json`, no `http.auth`) is
  Critical; an unintended `http.auth: "none"` under a protected folder is
  Critical. A corrupt `_meta.json` fails closed by design — flag it to fix, but
  it is not a fail-open hole.

## 1. Wiring integrity

- **Validation clean?** Run the flow through the runner (open it in the studio or
  `emberflow run`). Unknown node types, missing edges/handles, orphan regions =
  Critical.
- **Every `inputMap` has a matching edge.** An inputMap `{sourceNodeId: A}` on
  node B with no `A→B` edge is a bug: it renders as a floating node and the
  topological order can't see the dependency (wrong execution order, or a race).
  This is the single most common defect. Flag each occurrence.
- **No orphan nodes.** Every node is reachable from `Input` and (unless it's a
  terminal `Response`/`Result`) feeds something.
- **Branch handles exist.** Every edge with a `sourceHandle` names a real branch
  the source node emits; every branch a `Conditional`/`Route` can emit has a
  destination (including the fallback).

## 2. Branch coverage

- **One scenario per path.** Count the distinct paths through the flow; count the
  scenarios. A multi-branch flow with one scenario has only ever tested one path
  — Important. Each branch needs a scenario whose input drives it, named for the
  case.
- **Scenarios carry `expect`.** A branch-covering scenario with no `expect` (or
  `expect: {}`) is silently skipped by `emberflow test` — it doesn't fail, it's
  just not asserted. Flag it as Important: each branch's scenario should assert
  at least `status` and `executedNodes` so the branch is actually proven, not
  just exercised.
- Run every scenario. A scenario that errors or reaches the wrong branch is a
  Critical finding.

## 3. Plain Run / default input check

- Run the flow once with the studio's plain **Run** path (or
  `npx emberflow run <id> --input '{}'`). This uses only the Input node's
  `config.defaults`.
- If a required Input field is missing from defaults and plain Run fails with
  `Missing required input field(s)`, that is Important unless the flow explicitly
  documents that plain Run is unsupported.
- Scenario success does not cover this. Scenarios can supply required fields that
  the plain Run button does not.

## 4. Effects and safe mode

- **Every side-effecting node is `effects: 'mutation'`.** DB writes, external
  POSTs that create/change state, emails, queue sends. A mutation node that isn't
  marked can't be dry-run under safe mode — Important.
- Mutation nodes should compute a graceful dry-run output (never crash) and only
  perform the real effect under an explicit opt-in / when safe mode is off.
- Reads that look like writes (SELECT-only queries) are fine as `read` (default).

## 4b. Mock coverage and dual-mode

An operation must be runnable in BOTH worlds: real implementations for live
serving, mocks for mock mode. Check both halves.

- **`traceKind` is honest.** Every node whose implementation reads a database,
  calls an external service, or invokes a model carries `traceKind`
  (`'db'|'http'|'llm'`). An unmarked infra node silently executes for real
  during mock runs — Critical (mock mode's no-real-touch guarantee is broken).
- **Every infra node has a mock.** The sidecar's top-level `mocks` map covers
  every `traceKind` node (plain Run needs it); scenarios that drive a branch
  needing different canned data carry per-scenario `mocks`. `doctor` reports
  gaps as `missing-node-mock` — Important.
- **Mock values match the node's output shape.** A mock is the node's OUTPUT
  verbatim; a mock whose shape drifts from the implementation's return value
  makes mock runs lie — Important. No secret values in mocks — Critical.
- **Implementations are real.** A custom node that returns canned data instead
  of calling its actual dependency is a mock posing as an implementation — the
  op can never serve live. Critical for an op meant to go real.
- **Commit paths commit.** A mutation node whose commit branch logs
  "[SIMULATED]" (or otherwise returns success without performing the real side
  effect) is fake success on an operational API — Critical. The valid states
  are mock (canned), dry-run (`wouldSend`/`wouldWrite`), and real commit;
  missing credentials at commit time must THROW naming the secretRef, never
  succeed quietly. `doctor` reports these as `simulated-commit`.

## 4c. Source inspectability

A node is executable documentation only if its displayed implementation shows
(or navigates to) the behaviour it delegates. Open each custom node's source
in the studio and check:

- **No unresolved project-owned references.** Every project function, constant
  or class the implementation uses must resolve — either declared in the same
  file or reachable through the studio's reference navigation (ordinary
  imports resolve automatically). An unresolved project-owned reference that
  hides a business decision, formula, classification, or side effect is
  **Important** — **Critical** when the operation's documentation value
  depends on it (a thin adapter presenting `computeX(ctx.input)` as if it
  were the implementation, with `computeX` unreachable).
- **Newly-authored logic lives in ONE file.** Node logic written for this
  operation belongs in the registering module — helpers as named functions in
  the same file. New logic scattered across multiple new files is Important:
  it fragments the readable story without buying anything. (Imports of code
  the project ALREADY owned are correct and expected — that's what navigation
  is for.)
- **Nobody inlined to appease the inspector.** Pre-existing shared code that
  was copy-pasted into the registering file (instead of imported) is Important
  — it forks the source of truth.
- Runtime-generated implementations (factories) must carry an explicit
  `sourceRef` (third argument to `register`) — a generated function with no
  navigable source is Important.
- **Both modes verified.** Run the scenarios in mock mode; if an environment
  exists, run the real path too. Green in only one world is an unproven
  operation — Important.

## 5. Determinism

- **No hidden clock/random/live-data inside nodes** for anything a scenario needs
  to reproduce. Time, randomness, and fetched snapshots should be node **inputs**
  so scenarios can pin them. A node calling `Date.now()` internally makes its
  scenarios non-reproducible — Important for a flow meant to be tested.

## 6. Attribution and legibility

- **Outputs echo identity.** If a node's result must be attributed downstream (an
  id, category, token), it's carried in the node's output — not re-derived later.
  Lossy outputs make runs hard to debug — Minor→Important depending on impact.
- **Names say what nodes do**, not their type. `Result` nodes are labelled for
  what they show.
- **Layout reads left-to-right, no overlaps** (auto-layout in the studio). Minor,
  but a jumbled graph hides wiring bugs.

### Domain read-through (for modeled processes)

When an operation claims to model an existing process or serve as executable
documentation, read the source process and identify its audience before
approving it. The canvas itself must read as:

`trigger → reader-relevant actions/decisions → explained outcome`

- **Domain decisions are visible.** Decisions needed to explain the result
  appear as domain-named nodes and `Conditional`/`Route` branches. Existing formulas
  may remain in source functions called by those nodes; do not require copied
  logic merely to make it visible.
- **Intermediate conclusions are inspectable.** Outputs carry the facts,
  calculation basis, outcome, and provenance the named audience needs to
  explain why the process reached its result.
- **The graph is not a generic bridge.** `Input → RunWholeStage → Result` is
  Important when `RunWholeStage` hides several reader-relevant actions or
  decisions. Report `process-logic-opaque` and name the hidden decisions.
- **The graph is not source/task decomposition.** Files, classes, helper
  functions, source-code phases, implementation-plan tasks, and test seams do
  not justify separate operations. Fragmentation that replaces the domain
  read-through with technical stage names is Important.
- **Real process boundaries remain real.** Independently triggered HTTP,
  queue, and cron handlers and durable hand-offs remain separate operations;
  collapsing one into a synchronous `Subflow` is Critical when it changes
  lifecycle, retry, or delivery semantics.
- **A hand-off is not an excuse to hide the pipeline.** When an operation
  enqueues a durable job whose downstream phases are only described — in a
  node's output payload, a description field, or a doc string — instead of
  modeled as a visible node graph in their own internal operation, that is
  Important. Report `pipeline-hidden-in-data` and name the phases the reader
  cannot see on any canvas. Honesty about the async boundary and visibility
  of what runs behind it are both required; satisfying one by sacrificing
  the other fails review.

A typed proxy to a genuinely opaque external service is not required to expose
that service's unavailable internals. It must be described as a proxy or opaque
step, not as executable documentation of the external process.

## 7. Fidelity (for modeled processes)

If the flow models existing code (see emberflow-model-process): spot-check the
ported constants/thresholds/branch-order against the source. A silently "cleaned
up" constant or dropped branch is a Critical fidelity break. Documented
`PORT NOTE:` divergences are fine; undocumented ones are findings.

Also compare operation and `Subflow` boundaries with the source's real trigger,
durability, retry, and lifecycle boundaries. Matching function/file structure
is not fidelity; preserving behaviour while making its domain explanation
visible is.

## Output format

```
CRITICAL  <node/file>: <the defect>. <why it breaks>. <the fix>.
IMPORTANT <node/file>: ...
MINOR     <node/file>: ...
```

If nothing survives verification, say so plainly — but only after actually
running the scenarios and reading the wiring. A clean bill without a run is not a
review.
