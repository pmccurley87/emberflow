---
name: emberflow-model-process
description: Use when modeling or MIGRATING EXISTING functionality into Emberflow — a single process (script, controller, job, runbook) as one operation, or a whole subsystem (a worker, a pipeline, a service's job handlers) as an API of operations. Emphasises verbatim porting, branch fidelity, determinism, and (at subsystem scale) decomposition and seam verification. For designing something brand-new, use emberflow-new-workflow instead.
metadata:
  version: 2.7.0
---

# Modeling an existing process as an Emberflow operation

Read **emberflow-basics** first. This skill is the discipline for turning a real,
already-working process into an operation that mirrors it — the goal is
*fidelity*, not reinvention. Done well, the operation becomes executable
documentation of the system. Sections 1–6 govern each individual port; when
the source is a whole subsystem spanning several operations, ALSO apply
**At subsystem scale** at the end.

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

Confirm the summary before porting. The answers feed sections 4–6.

## 1. Read the source first, fully

Find and read the actual implementation — the script, controller, job, or written
runbook. Identify:

- **The steps**, in execution order.
- **The decisions** — every `if`/`switch`/early-return/threshold. These become
  `Conditional`/`Route` nodes. Note the exact conditions and constants.
- **The side effects** — DB writes, external POSTs, emails, queue sends. These
  become custom nodes marked `effects: 'mutation'`.
- **The inputs and external data sources** it reads.

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

- Request in → an `Input` node reading `{ params, query, body, headers }` (for an
  HTTP op); response out → a `Response` node `{ status, body }` per real exit,
  matching the source's status codes (internal flow → `Result`).
- Linear steps → a chain of nodes with `inputMap` + edges.
- Decisions → `Conditional` (ordered rules) or `Route` (switch on a field), one
  branch per real code path, including the else/default. A branch that returns a
  different HTTP status gets its own `Response`.
- Loops over collections → `ForEach`/`Collect`.
- Sub-procedures the source factors out → a `Subflow` node calling a separate
  operation (mirror the real call structure — if `handleA()` calls `handleB()`,
  operation A calls operation B).
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
- **One operation per process boundary.** A queue or cron hop in the source is
  an operation boundary in the model — do NOT collapse an async boundary into
  a synchronous `Subflow` (the fan-out op models the *send*; the per-job op is
  invoked separately). A sub-procedure called in-process IS a `Subflow`.
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
For a subsystem migration the same bar holds system-wide, and both worlds must
work: every scenario green in mock mode, and the real path proven or explicitly
pending.
