---
name: emberflow-model-process
description: Use when modeling or MIGRATING EXISTING functionality into Emberflow — a single process (script, controller, job, runbook) as one operation, or a whole subsystem (a worker, a pipeline, a service's job handlers) as an API of operations. Emphasises verbatim porting, branch fidelity, determinism, and (at subsystem scale) decomposition and seam verification. For designing something brand-new, use emberflow-new-workflow instead.
metadata:
  version: 2.9.0
---

# Modeling an existing process as an Emberflow operation

Read **emberflow-basics** first. This skill is the discipline for turning a real,
already-working process into an operation that mirrors it — the goal is
*fidelity*, not reinvention. Done well, the operation becomes executable
documentation of the system. Sections 1–6 govern each individual port; when
the source is a whole subsystem spanning several operations, ALSO apply
**At subsystem scale** at the end.

**Fidelity means preserving behaviour and real execution boundaries, not
copying the source's file, class, helper-function, or implementation-task
boundaries into the canvas.** The visible graph tells the domain process in the
language of its intended readers; existing functions sit underneath those
domain steps as their implementations.

If the process is (or is triggered by) an HTTP endpoint, model it as an HTTP
operation: create `emberflow/apis/<api>/<folder…>/<name>.json` with `id` equal to
that path (`emberflow/apis/billing/charge.json` → `"billing/charge"`), add the
`http` trigger `{ method, path }` matching the real route, start with an `Input`
receiving `{ params, query, body, headers }`, and end in a `Response` emitting
`{ status, body }` — mirror the real endpoint's status codes. A process with no
HTTP surface is an internal flow (no `http`) ending in `Result`.

## 0. Intake — interview the user before you port

The source code tells you the logic; it cannot tell you how the user wants the
model to run. Interview them BEFORE porting — one short question at a time,
skipping anything already answered by the project or the source:

Check `emberflow/infrastructure.json` FIRST: if the scout has already mapped
this project's databases, APIs and providers, reuse those systems and their
secret NAMES instead of re-deriving infrastructure the manifest already names.

1. **Environments — only when the project doesn't already answer it.**
   Environments are PROJECT-level (`emberflow.environments.json` is shared by
   every API and operation) — read it first. If it already covers what the
   port needs, note that and move on; don't re-interview per operation. Ask
   only when the file doesn't exist ("Which environments — local, dev,
   staging, prod? Default? Production-like?") or the port introduces a delta
   (a var or environment nothing carries yet). Production-like →
   `protected: true` (safe mode by default; mutations dry-run). Scaffold via
   `setup-environments`; environment auth via `set-environment-auth`, never a
   hand-edit.
2. **Secrets — same scoping.** Existing keys need no questions. For NEW keys
   the ported dependencies introduce (the DB URL, API keys you found in the
   source), propose names and ask whether values differ per environment. You
   only handle `secretRef` NAMES — the user enters values in the studio's
   Manage Environment dialog, never in chat or any file/argument you produce.
3. **Mocks.** "Do you have a captured response or a real representative row
   from the source system I should use as the canned data?" Mock values
   sourced from the real system make mock runs exercise real shapes — this is
   the difference between a trustworthy model and a green-but-lying one.
4. **Scenarios.** "Beyond one scenario per branch of the source, which
   specific cases do you want named and asserted?" (A known incident, a
   particular account shape, the case that motivated the port.)
5. **Domain read-through.** "Who must be able to read this flow, and which
   decisions or conclusions must they be able to explain from the canvas?"
   Skip the question when the user has already named the audience and the
   domain questions. Record those terms verbatim; they become node and branch
   labels rather than names copied from helper functions.

Confirm the summary before porting. The answers feed sections 4–6.

### Process-model proposal — required before implementation

Present one compact proposal before authoring operation files. It contains:

1. The process trigger and outcome in one sentence.
2. The intended reader and what they must be able to explain from the canvas.
3. Each proposed operation boundary and the real trigger, durability, retry, or
   lifecycle reason that justifies it.
4. The visible read-through in domain language, including meaningful decisions
   and intermediate conclusions.
5. How existing source functions map underneath those visible steps, plus any
   genuinely opaque dependency or deliberate divergence.

Get the user's approval when working interactively. Route names, file lists,
helper names, or implementation tasks are not a substitute for this proposal.

## 1. Read the source first, fully

Find and read the actual implementation — the script, controller, job, or written
runbook. Identify:

- **The steps**, in execution order.
- **The decisions** — every `if`/`switch`/early-return/threshold. These become
  `Conditional`/`Route` nodes. Note the exact conditions and constants.
- **The side effects** — DB writes, external POSTs, emails, queue sends. These
  become custom nodes marked `effects: 'mutation'`.
- **The inputs and external data sources** it reads.
- **The domain story** — trigger, meaningful actions and decisions, and the
  outcome the intended reader cares about. Keep this separate from source helper
  calls, modules, controllers, repositories, and technical layers.
- **The real process boundaries** — independently triggered HTTP/queue/cron
  handlers, durable hand-offs, separate lifecycles, and independently invoked
  reusable domain processes. A function call or file boundary alone is not a
  process boundary.

Do not skim. A faithful model requires knowing what the code actually does,
including the edge cases.

## 2. Port logic VERBATIM

Copy the real constants, formulas, thresholds, and branch order into your custom
node implementations — do not "improve", round, or simplify them. If the source
uses `>= 0.7` and `MAX = 30`, your node uses `>= 0.7` and `30`. The whole value
is that the flow behaves exactly like the system.

- Keep a `PORT NOTE:` comment where your model diverges from the source for a
  real reason (e.g. the original interleaves two passes; the flow does them in
  order). Divergences must be deliberate and documented.
- Where the source calls an in-process function you can't run here, model it as a
  node with the same inputs/outputs and note the substitution.

## 3. Call out ambiguities — do not silently resolve them

If the source is contradictory (a comment says one threshold, the code uses
another), port the **code** (the source of truth), and surface the discrepancy to
the user rather than quietly picking one. Dead code, unreachable branches, and
stale constants are findings worth reporting — not things to tidy away.

## 4. Map the shape onto Emberflow

Before choosing files or operation ids, write the visible domain read-through
as `trigger → domain action/decision → outcome`. A person in the audience
named during intake must be able to follow that sequence from node and branch
labels without opening the node implementations. Then map the existing source
underneath it:

- Request in → an `Input` node reading `{ params, query, body, headers }` (for an
  HTTP op); response out → a `Response` node `{ status, body }` per real exit,
  matching the source's status codes (internal flow → `Result`).
- Domain-meaningful linear steps → a chain of nodes with `inputMap` + edges.
  A node may call one existing function or coordinate several helpers; its
  boundary is the result the intended reader needs to inspect, not the number of
  functions involved.
- Decisions → `Conditional` (ordered rules) or `Route` (switch on a field), one
  branch per real code path, including the else/default. A branch that returns a
  different HTTP status gets its own `Response`.
- Loops over collections → `ForEach`/`Collect`.
- Existing helper functions and technical layers → implementation code beneath
  the relevant domain node. Promote a helper to its own visible node when it
  produces a meaningful intermediate domain result, owns an infrastructure
  or effect boundary, or needs distinct retry/inspection behaviour.
- **Port by importing, never by copying.** A node implementation that wraps
  existing source IMPORTS it from where it lives — the studio resolves the
  import and navigates to the real code, so the port stays verbatim and the
  source of truth stays single. Copying helper bodies into the registering
  file forks them. New glue you write for the port (adapters, small
  reshaping helpers) follows the one-file rule: it lives in the registering
  module itself, not in new satellite files. After porting, open each node's
  source in the studio: every project-owned reference must resolve —
  an unresolved reference hiding ported business logic defeats the port's
  documentation purpose (the review skill treats it as Important/Critical).
- A coherent in-process domain process that is repeated or independently
  useful → a `Subflow` node calling a separate internal operation. Subflow
  extraction must make the domain read-through clearer. Do not mirror a
  helper call merely because the source factors it out.
- **Asynchronous hand-offs (queue jobs, cron pipelines, workers) → model the
  downstream pipeline as its own internal operation with a visible node graph.**
  Never collapse the phases a durable job runs into one node's output data or a
  description field to avoid implying synchronous execution — the reader gets
  their understanding from the canvas, not from opening code or JSON payloads.
  The triggering operation models the hand-off honestly (enqueue, dry-run by
  default) and names the downstream operation; the downstream operation (no
  HTTP trigger — studio-run only) shows each phase, gate, and tolerated-failure
  branch as nodes, annotated as running asynchronously in the worker. Both
  honesty rules hold at once: the boundary is a real hand-off AND the pipeline
  behind it is fully visible.
- Effects → `effects: 'mutation'` nodes that dry-run by default and only commit
  under an explicit opt-in. The commit path performs the REAL side effect the
  source performs — the same insert, the same webhook, the same send. A
  "[SIMULATED]"-success commit path is forbidden: if the credential isn't set,
  commit THROWS naming the secretRef. The port isn't operational until a
  mutation has committed for real against a real environment (or is explicitly
  reported "operational-pending" with the exact secrets needed).
- Infrastructure boundaries → set `traceKind` (`'db'|'http'|'llm'`) on every
  node that reads a database, calls an external service, or invokes a model.
  Mock mode intercepts by `traceKind`; an unmarked infra node silently executes
  for real during mock runs.

**Reuse a node when one fits; author a new one when none does** — inventing
nodes is expected, it's how a process becomes real code. The only rule: register
a node's implementation in `registerNodes` before you reference its `type`; the
runner rejects an unregistered type (a name with no implementation), but a type
you register in the same change is exactly how you model the step.

### Keep domain logic visible

A generic bridge such as `RunStage`, `ExecuteScript`, or `CallService` may be a
leaf implementation detail, but it is not a faithful visible model when it
contains several domain actions or decisions. A graph shaped only as
`Input → RunWholeStage → Result` documents plumbing, not the process.

For each bridge or broad adapter, inspect the source it invokes:

1. Put each reader-relevant decision and intermediate conclusion on the
   canvas as a specifically named node or branch.
2. Keep formulas and constants in the existing implementation when duplicating
   them would risk drift; call that implementation from the domain-named node.
3. Expose the inputs, calculation basis, outcome, and provenance needed to
   explain the result in the run trace.
4. If the dependency is genuinely opaque and cannot yet be decomposed, label it
   explicitly as an opaque external step and report the model as
   `process-logic-opaque`; do not call it executable documentation.

## 5. Make it deterministic and reproducible

Real processes read the clock, the DB, live data. For a faithful, testable model,
lift those into node **inputs** (a `now` timestamp, a fetched snapshot) so a
scenario can pin them. Every branch of the original gets a scenario whose pinned
input drives exactly that path — named for the case it reproduces
("critically-low", "poor-forecast", "already-ran-today").
Also set Input `defaults` for every required field needed by the studio's plain
Run button, or explicitly report that plain Run is intentionally unsupported.
Scenarios prove branches; defaults prove the unscoped authoring run works.

**Model both worlds: real implementations AND mocks.** The ported node
implementations call the real dependencies (the actual query, the actual API,
the actual model) — verbatim porting means real code, not canned data in the
implementation. Then, in the same change, author the sidecar `mocks` maps so
the model also runs in mock mode: a top-level `"mocks": { "<nodeId>": <output> }`
covering every `traceKind` infra node, plus per-scenario `mocks` where a branch
needs different canned data. Source the mock values from realistic outputs of
the original system (a captured response, a representative row) so mock runs
exercise the same shapes the real system produces. An infra node with no mock
fails the mock run loudly; `doctor` reports it as `missing-node-mock`. A model
that only runs against live infrastructure isn't executable documentation —
and one that only runs mocked was never proven faithful.

## 6. Prove fidelity

Run both: plain Run and every scenario — in mock mode always, and against a
real environment when one exists. Confirm the flow reaches the same decision
the real system would for each input. Where you have reference outputs from the
source system, assert the flow matches them. Run `npx emberflow doctor <opId>`
and clear every finding (including `missing-node-mock`). Then run
**emberflow-review-workflow**.

## At subsystem scale (migrating a worker / pipeline / job family)

When the source is a whole subsystem, the per-operation discipline above still
governs each port — these rules govern the campaign around it. The core
lesson from real migrations: **the serious defects live in the wiring between
correct nodes, not in the ported logic** — an inputMap reading a field the
producer never emits, a single object wired where the consumer maps an array,
`timestamp` vs `date` keys, an identity (signalId, token) dropped between
phases — and a wrongly-shaped mock masks every one of them.

- **Scout first, completely.** Before designing, write down: entry points and
  triggers (cron/queue/HTTP), the phases in execution order with file:line,
  every constant in a table (that table becomes the fidelity checklist all
  reviews check against), external dependencies per phase, and the data
  shapes phases pass each other.
- **One operation per real process boundary.** A queue or cron hop in the source
  is an operation boundary in the model — do NOT collapse an async boundary
  into a synchronous `Subflow` (the fan-out op models the *send*; the per-job op
  is invoked separately). Files, classes, helper functions, source-code phases,
  implementation-plan tasks, and test seams are NOT operation boundaries. An
  in-process helper normally stays beneath a node; use a `Subflow` only for a
  coherent repeated or independently useful domain process.
- **Inventory existing nodes before authoring new ones** — migrations often
  land where partial models already exist. Reuse and extend.
- **Producers own their output contracts.** If a consumer needs rows, the
  producer emits rows — inputMap cannot compose objects or wrap arrays. When
  a seam mismatch surfaces, fix the producer node, never the mock.
- **Mocks are truthful.** A mock is the producer's real emittable output,
  verbatim — never the shape the consumer wishes for; that is exactly how
  wiring bugs go green. A `Subflow` mock uses whatever the child's Result
  terminals actually emit (run the child; don't imagine an aggregate).
- **Drive branch scenarios through real logic.** Prefer feeding the REAL
  detector/gate a crafted infra mock (a series that genuinely promotes, spend
  that genuinely overspends) over mocking the compute node itself — a
  scenario that cans the detector it claims to prove proves only wiring.
- **Verify the seams, then the system.** Check every inputMap sourceField
  against the producer's outputSchema as you wire (doctor's
  `inputmap-schema-mismatch` catches misnamed fields but NOT type/shape drift
  on a correctly-named field — that check is yours). After per-op reviews
  (emberflow-review-workflow on every op), run one whole-system review with
  fresh eyes over the full diff, tracing infra-node inputs through REAL node
  implementations with fixture data — mock-green proves nothing about real
  mode. Finish with a real-mode spot check against a real environment (safe
  mode on); if credentials block it, report "real-mode pending" — never imply
  live parity you didn't prove.

## The bar

Someone who knows the original system should read the flow and recognise it
exactly — same steps, same decisions, same constants, same effects — with every
divergence explicitly marked. If they'd be surprised by a branch, you modeled it wrong.
The intended reader should also be able to explain from the canvas why the
process reached its conclusion. If they must open a generic bridge node or read
source helper names to discover the domain logic, the model is too opaque.
For a subsystem migration the same bar holds system-wide, and both worlds must
work: every scenario green in mock mode, and the real path proven or explicitly
pending.
