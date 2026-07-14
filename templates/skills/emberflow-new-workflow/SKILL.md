---
name: emberflow-new-workflow
description: Use when creating a BRAND-NEW Emberflow API operation from scratch (greenfield) — the user describes a goal or endpoint they want and no existing code models it yet. Guides choosing method + path, wiring Input → logic → Response, choosing built-in vs custom nodes, and covering branches with scenarios. For porting an EXISTING system, use emberflow-model-process instead.
metadata:
  version: 2.6.0
---

# Building a new Emberflow operation (greenfield)

Read **emberflow-basics** first for file layout and node mechanics. This skill
is the recipe for authoring an HTTP operation that doesn't exist yet.

## 0. Intake — interview the user before you build

An operation touches four things only the user can decide: environments,
secrets, mocks, and scenarios. Interview them BEFORE designing — one question
at a time, short questions, never a wall of them. Skip any question whose
answer is already obvious from the project (an existing
`emberflow.environments.json`, existing ops on the same API). Do not invent
answers to fill gaps.

Check `emberflow/infrastructure.json` FIRST: if the scout has mapped this
project's databases, APIs and providers, reuse those systems and their secret
NAMES rather than re-interviewing the user about infrastructure they already
have.

1. **Environments — but only when the project doesn't already answer it.**
   Environments are PROJECT-level (`emberflow.environments.json` is shared by
   every API and operation), not per-operation. Read it first. If it exists
   and covers what this operation needs, say so in one line and move on —
   do NOT re-interview the user about environments for every new operation.
   Ask only when: the file doesn't exist yet ("Which environments should this
   run against — local, dev, staging, prod? Which is the default? Which are
   production-like?"), or this operation introduces a genuine delta (needs a
   var/env no existing environment carries). Production-like environments get
   `protected: true` (runs there default to safe mode; mutations dry-run).
   Scaffolding goes through the `setup-environments` path; environment auth
   through `set-environment-auth` — never a hand-edit.
2. **Secrets — same scoping.** Existing keys that already cover this
   operation need no questions. Ask only about NEW secret keys this operation
   introduces: "this needs <an API key for X> — what should the key be
   called, and does the value differ per environment?" You only ever name
   `secretRef` keys; the user enters actual values in the studio's Manage
   Environment dialog — never in chat, never in a file you write, never in a
   CLI argument. Both `emberflow.secrets.json` and
   `emberflow.environments.json` are gitignored; say so if the user asks
   where values live.
3. **Mocks.** "For mock mode, what should the canned data look like — do you
   have a captured response or a representative row I should mirror?" Every
   infra node (traceKind db/http/llm) needs a mock; realistic shapes make
   mock runs trustworthy. If the user has nothing, propose representative
   values and ask them to confirm the shape.
4. **Scenarios.** "Which cases matter to you — the happy path plus what
   failures/edge cases?" Every branch gets a scenario regardless; this
   question is about which EXTRA cases the user cares to see named and
   asserted (a specific customer shape, a known outage pattern).

Summarize what you heard in two or three sentences and confirm before
building. The answers drive steps 2, 7, and 8 below.

## 1. State the goal as one sentence

"On `<METHOD path>`, given `<request>`, produce `<response>`, deciding `<the key
branch>` along the way." Write it down. Everything below serves this sentence. If
you can't write it, you don't understand the operation yet — ask.

## 2. Choose the endpoint and its home

- **Method + path.** Pick the HTTP `method` and `path` that fit the goal (e.g.
  `POST /charges`, `GET /users/:id`). The user described the goal, not the
  mechanics — you decide these.
- **Where it lives.** Create `emberflow/apis/<api>/<folder…>/<name>.json` with a
  clear kebab-case `<name>`. **Set the in-file `id` equal to the file's path
  relative to the apis dir** — `emberflow/apis/billing/charge.json` → `id:
  "billing/charge"`. A mismatched id makes the op unreachable.
- Add the `http` trigger `{ "method": …, "path": … }`. (Omit `http` only if you
  are building an internal sub-flow, not an endpoint.)

## 3. Decompose into steps, then nodes

List the steps the endpoint takes, in order. Each becomes a node:

- **Entry is always `Input`** — it receives `{ params, query, body, headers }`.
  Read a request part with a dotted `sourceField` (`body.amount`, `query.id`,
  `params.userId`).
- **Terminus is always `Response`** for an HTTP op — its `{ status, body }`
  becomes the wire response (omit `status` → 200). (Use `Result` only for an
  internal, non-HTTP flow.)
- **Control flow uses built-ins:** `Conditional`/`Route` (a decision),
  `ForEach`/`Collect` (repeat over a list), `Subflow` (delegate to another
  operation). Don't build custom nodes for branching.
- **Project logic is a custom node** you register in `emberflow.config.mjs`'s
  `registerNodes`. One node = one cohesive operation (fetch X, score Y, send Z).
  Put real side effects behind `effects: 'mutation'`, and set `traceKind`
  (`'db'|'http'|'llm'`) on every node that touches infrastructure — mock mode
  uses it to know what to intercept. An unmarked infra node silently executes
  for real during mock runs.
- **Node logic lives in ONE file.** Everything you write for a node — its
  implementation and any helpers — goes in the module the `registry.register`
  call sits in, helpers as named functions in that same file. The studio shows
  that whole file as the node's source, so a reader sees the complete story in
  one place. Never spread newly-authored node logic across multiple files.
  Code the project ALREADY owns is the exception: import it normally (never
  copy it) — the studio resolves imports and navigates to them.
- **Implementations are real.** A custom node's implementation calls the actual
  dependency (the real query, the real HTTP call, the real SDK) — never canned
  data pretending to be an implementation. Canned data belongs in the scenario
  `mocks` maps, not in node code. Every operation is designed for BOTH worlds
  from the start: real implementations so it serves live, plus mocks so it runs
  in mock mode — one without the other is half an operation.
- **Commit means commit.** A mutation node's commit path performs the real side
  effect — a "[SIMULATED]"-success commit path is forbidden (mock mode and
  dry-run already cover every design-time need). Can't make the real call
  because a secret isn't set? THROW, naming the exact secretRef the user must
  fill in. The operation isn't operational until at least one mutation has been
  exercised with `commit: true` against a real environment — or your final
  report explicitly marks it "operational-pending" with the exact secret list.

**Reuse a node when one fits; otherwise author a new one.** Inventing nodes is
normal and encouraged — when no registered node does what the goal needs (call
an external API, a custom transform, a domain rule), add it in `registerNodes`
(above) and reference it. The one rule: **register a node's implementation
before you reference its `type`.** The runner rejects an operation referencing
an unregistered type, so a made-up type with no implementation fails — but a
type you register in the same change is exactly how you extend the palette.
Don't under-build to avoid authoring: build the operation out with the nodes the
goal genuinely needs.

Name nodes for what they *do* ("Score Lead", "Fetch Orders"), not their type.

## 4. Design the data flow before wiring

For each node write its inputs and output shape. Draw the arrows: which node's
output feeds which node's input. This is your `inputMap` + `edges` plan. Two rules:

- Every input a node needs must come from exactly one upstream `sourceField`
  (or the node's `config`/`defaults`).
- **Echo identity through outputs.** If a node produces a result later nodes must
  attribute (an id, a category, a token), pass it through in its output — don't
  make downstream nodes re-derive it. This keeps runs debuggable.

## 5. Model decisions explicitly

A branch is a `Conditional` (ordered rules, first match wins) or `Route` (switch
on a field). The branch node emits `$branch`; each outgoing edge sets
`sourceHandle` to a branch name and only fires when that branch is taken. Give
every branch a destination — including a `fallback`, and often a distinct
`Response` (e.g. a 200 path and a 400/404 path). A node on an untaken branch is
skipped, not run.

## 6. Build incrementally, running as you go

Keep `npx emberflow dev` up. Add `Input → one node → Response`, run it, confirm
the response, then extend. Don't wire ten nodes then run once. Use the studio's
Run and Step buttons; click a node in the run console to see its exact
input/output. Run both: plain Run and scenarios. The plain Run button sends no
request, using only Input `defaults`, so every required Input field needs a
sensible default unless you intentionally want plain Run to fail and report it.

## 7. Cover every path with a scenario

For each path through the operation, add a scenario to
`<operation>.scenarios.json` whose `input` (the request shape `{ params?, query?,
body?, headers? }`) drives that path — name it for the path ("new-customer",
"over-limit", "missing-body"). An operation isn't done until every branch and
every distinct status code has a green scenario. If a step depends on
time/randomness, make it a node input and pin it in the scenario.

**Author mocks alongside the scenarios.** If the operation has any `traceKind`
infra node (db/http/llm), write the sidecar's `mocks` maps in the same change:
a top-level `"mocks": { "<nodeId>": <output> }` covering every infra node (plain
Run uses this), plus per-scenario `mocks` where a branch needs different canned
data. Each mock value is the node's OUTPUT verbatim — read the node
implementation to match its shape. An infra node with no mock fails the mock
run loudly, and `doctor` reports it as `missing-node-mock`. The bar: the
operation is green in BOTH modes — every scenario passes in mock mode, and the
real path works against a real environment. Never put secret values in mocks.

## 8. Set the auth intent

Decide whether the endpoint is public or protected. Protected → put an `auth`
policy in the nearest `_meta.json` (inherited) or in the op's `http.auth`; public
under a protected folder → set `http.auth: "none"`. Don't leave a
should-be-protected endpoint silently public.

## 9. Finish

- Auto-layout the operation (studio control) so it reads left-to-right, no overlaps.
- Confirm validation is clean (no orphan nodes, every inputMap has an edge).
- Run plain Run/default input once and fix any `Missing required input field(s)`
  error before relying on scenario results.
- Confirm the `id` equals the file's path under apis, and the op ends in `Response`.
- Run `npx emberflow doctor <opId>` — resolve every finding, including
  `missing-node-mock` on infra nodes.
- Run the scenarios in mock mode AND (when an environment exists) the real path
  — both must be green.
- Run **emberflow-review-workflow** on it before calling it done.

## Anti-patterns

- Referencing a node `type` you never registered — the op is rejected. Author the node in `registerNodes` in the same change (or reuse an existing one); don't reference a type with no implementation.
- Ending an HTTP op in `Result` instead of `Response` — no wire response.
- `id` that doesn't match the file path under apis — the op is unreachable.
- Custom nodes for branching/looping — use `Conditional`/`Route`/`ForEach`.
- Giant do-everything nodes — split by responsibility so runs are legible.
- inputMap without a matching edge — invisible wiring + wrong ordering.
- One scenario for a multi-branch operation — you've only tested one path.
- Scenario-only verification — misses required Input fields that have no defaults.
- Side effects with no `effects: 'mutation'` — safe mode can't protect the run.
- Canned data inside a node implementation instead of a real call — that's a mock
  wearing an implementation's clothes; the op can never go live. Real logic in the
  node, canned outputs in the sidecar `mocks`.
- A commit path that logs "[SIMULATED] …" and returns success — fake success on
  an operational API. Commit does the real thing or throws naming the missing
  secretRef; `doctor` reports these as `simulated-commit`.
- Infra node without `traceKind` — it silently runs for real in mock mode.
- Scenarios without `mocks` for an op that has infra nodes — mock runs fail loudly
  and the design-first loop is broken.
