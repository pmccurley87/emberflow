---
name: emberflow-basics
description: Use whenever working with Emberflow in this project — running the studio, understanding the file layout, adding or editing API operations and scenarios, registering custom nodes, or using the CLI/MCP. The foundation the other emberflow-* skills build on. Trigger on "emberflow", "workflow builder", "operation", "api", "flow", "run a scenario", "emberflow dev".
metadata:
  version: 2.7.0
---

# Emberflow basics

Emberflow is a visual builder for **API operations** in this project. An operation
is a JSON file describing a node graph (a "flow"); the project's own code is
exposed as **nodes**; runs execute on a local runner and are visualised in a
browser studio. An operation with an `http` trigger is a live HTTP endpoint; one
without is an internal sub-flow other operations call. This skill is the
mechanics reference — how the pieces fit and how to drive them correctly.

## File layout (in the consumer project)

- `emberflow.config.mjs` (project root) — the contract. Exports `defineConfig({ flowsDir, registerNodes })`.
- `emberflow/apis/<api>/<folder…>/<operation>.json` — one operation per file, in a tree. `<api>` is the top-level API (e.g. `default`, `billing`); folders under it are free-form grouping.
- **An operation's `id` is its path relative to the apis dir, without `.json`.** `emberflow/apis/billing/charge.json` → `id: "billing/charge"`; `emberflow/apis/default/greet.json` → `id: "default/greet"`. The store keys ops by their in-file `id` but stores them by path, so the two MUST match — a mismatched id makes the op unreachable.
- `emberflow/apis/…/<operation>.scenarios.json` — that op's scenarios ("stories": named inputs), a sidecar array alongside the op file. The op file never contains a `scenarios` key.
- `emberflow/apis/<api>/<folder…>/_meta.json` — optional. Holds the `auth` policy inherited by every operation at or below that directory (see Auth below).
- `emberflow.environments.json` — **structure only**: named environments, their non-secret `vars`, and each env's `secrets` as a LIST of key NAMES (no values). Safe for you to read and edit. `emberflow.secrets.json` — secret **values only**, shape `{ "<envName>": { "<KEY>": "<value>" } }`, chmod `0600`; you NEVER read or write it (the user sets values via the studio's Manage Environment dialog or `login-environment`). A value of `"$ENV:VAR_NAME"` indirects to `process.env.VAR_NAME` at load. Both files are git-ignored (machine-local). The config and the `emberflow/apis` tree ARE committed.
- `emberflow/infrastructure.json` — **committed, structure-only** manifest of the infrastructure this project already uses (databases, external APIs, providers) with evidence pointing at the files that prove it. Written by the infrastructure scout (the studio's Infra tab / the `scout-infrastructure` agent intent); READ by agents before authoring operations so they REUSE existing systems and secret NAMES instead of inventing parallel config. Holds env-var NAMES only — never secret values.

## Running it

- `npx emberflow dev` — boots the runner **and** the studio in one process and opens the browser (`http://127.0.0.1:8092`). This is the primary loop: edit an operation file or config, the studio picks it up.
- `npx emberflow run <id> --scenario <name>` — run an operation to completion against a running runner; prints the result JSON. `<id>` is the operation's path-based id (e.g. `billing/charge`).
- `npx emberflow run <id> --input '{}'` — same as the studio's Plain Run button: it uses only the Input node's `defaults`. Use this to catch missing defaults before relying on scenarios.
- `npx emberflow mcp` — expose the MCP tools (list/get/save/validate/run/publish operations) to an agent.
- `npx emberflow init` — scaffold config + an example operation (already done if this project has an `emberflow.config.(mjs|js|ts)`).

Always have `emberflow dev` running while authoring — it's how you see and test.

## The config and custom nodes

The project's `language:` field (`'javascript'` or `'typescript'`, in
`emberflow.config.(mjs|js|ts)`) is the **authoritative signal for which
language to author in** — always match it, whichever scaffold shape below
the project actually uses.

JavaScript (`emberflow.config.mjs`, JSDoc types):

```js
import { defineConfig } from '@xdelivered/emberflow';
export default defineConfig({
  language: 'javascript',
  flowsDir: 'emberflow/flows',      // anchor: the apis tree lives at emberflow/apis (sibling)
  /** @param {import('@xdelivered/emberflow').NodeRegistry} registry */
  registerNodes(registry) {
    registry.register(
      {
        type: 'Greet',                 // unique id, referenced by operations
        label: 'Greet',
        description: 'Greets by name.',
        category: 'my-app',
        inputSchema:  { fields: [{ name: 'name', type: 'string', required: true }] },
        outputSchema: { fields: [{ name: 'hello', type: 'string' }] },
        // effects: 'mutation'  ← add for nodes that write/POST/email; they dry-run under safe mode
        // traceKind: 'db'|'http'|'llm'  ← add for nodes that touch infrastructure; mock mode intercepts by this
      },
      async (ctx) => ({ hello: `Hello, ${ctx.input.name}!` }),
    );
  },
});
```

TypeScript (`emberflow.config.ts`, typed) — same shape, typed instead of JSDoc:

```ts
import { defineConfig } from '@xdelivered/emberflow';
import type { NodeRegistry } from '@xdelivered/emberflow';
export default defineConfig({
  language: 'typescript',
  flowsDir: 'emberflow/flows',
  registerNodes(registry: NodeRegistry) {
    registry.register(
      { type: 'Greet', label: 'Greet', /* schemas/category/effects/traceKind as above */ },
      async (ctx) => ({ hello: `Hello, ${ctx.input.name}!` }),
    );
  },
});
```

- A node = a **definition** (metadata: type/label/schemas/category/tags/effects — what the studio shows) plus an **implementation** (an `async (ctx) => output`). The studio fetches definitions over HTTP; implementations run on the runner (next to your app code, so they can touch your DB/services).
- `ctx.input` = the node's resolved inputs. `ctx.config` = its per-node config. Return a plain object; downstream nodes read fields off it.
- Mark side-effecting nodes `effects: 'mutation'` so safe mode can dry-run them,
  and infrastructure-touching nodes with `traceKind` so mock mode can intercept them.
- **Design for both worlds.** An operation ships with real node implementations
  (so it serves live) AND sidecar `mocks` covering every infra node (so it runs
  in mock mode). Neither substitutes for the other — see Mock mode below.
- **A mutation node has exactly three behaviours** — mock run → canned output
  from the sidecar; dry-run (`config.commit` false, or safe mode) → a
  `wouldSend`/`wouldWrite` summary, nothing touched; commit
  (`config.commit === true && !ctx.safeMode`) → the REAL side effect. There is
  no fourth state: a commit path that logs "[SIMULATED]" and returns success is
  FORBIDDEN — these are operational APIs, not demos. If the real call can't be
  made (a missing secretRef, no webhook configured), the commit path THROWS a
  clear error naming the missing key. Fake success is worse than failure;
  `doctor` flags simulated commit paths as `simulated-commit`.

## Operation file shape

```json
{
  "id": "default/greet", "name": "Greet", "version": 1,
  "http": { "method": "GET", "path": "/greet" },
  "nodes": [
    { "id": "in", "type": "Input", "label": "Request", "position": {"x":0,"y":0},
      "config": { "fields": [
        {"name":"params","type":"object"}, {"name":"query","type":"object"},
        {"name":"body","type":"object"},   {"name":"headers","type":"object"}
      ], "defaults": { "query": {"name":"world"} } } },
    { "id": "greet", "type": "Greet", "label": "Greet", "position": {"x":300,"y":0},
      "config": {}, "inputMap": { "name": {"sourceNodeId":"in","sourceField":"query.name"} } },
    { "id": "res", "type": "Response", "label": "Response", "position": {"x":600,"y":0},
      "config": {}, "inputMap": { "body": {"sourceNodeId":"greet","sourceField":"$"} } }
  ],
  "edges": [ {"id":"e1","source":"in","target":"greet"}, {"id":"e2","source":"greet","target":"res"} ],
  "createdAt": "2026-07-05T00:00:00Z", "updatedAt": "2026-07-05T00:00:00Z"
}
```

- **`http`** = `{ method, path }`. Present → the operation is mounted as an HTTP endpoint. Absent → it's an internal sub-flow (call it from another op's `Subflow` node). Optional `auth` field (see below).
- **`Input`** is the entry node. For an HTTP operation the run payload is the request shape `{ params, query, body, headers }` (plus the request body's own fields promoted to the top level, and `user` when auth ran). Read a request part with a dotted `sourceField` like `query.name` or `body.amount`.
- **`Response`** is the terminus of an HTTP operation. Its input `{ status, body }` becomes the HTTP response; omit `status` and it defaults to `200`.
- **`inputMap`** wires a node's input field to a source node's output: `{ sourceNodeId, sourceField }`. `sourceField: "$"` means the whole output; otherwise a dot-path into it.
- **`edges`** draw the graph and, critically, define execution order (topological). **Every inputMap needs a matching edge** — an inputMap without an edge renders as a floating node AND the ordering can't see the dependency. Rule: if node B reads from node A, there is an `A→B` edge.
- **Input defaults matter.** The studio's Plain Run button sends no request. Every required Input field must either have a sensible `config.defaults` value or the author must intentionally accept/report that Plain Run fails. Do not call an operation done after only scenario runs.

## Built-in node types

You'll use these most (custom project nodes come from `registerNodes`):

- `Input` — entry; emits the run payload merged over `defaults`. For an HTTP op the payload is `{ params, query, body, headers }`.
- `Response` — **HTTP terminus.** Input `{ status, body }` → the HTTP response. Use this for any operation with an `http` trigger.
- `Result` — **internal terminus / display sink.** The collected output of a non-HTTP (internal) flow comes from its `Result` nodes. Use `Response` for HTTP endpoints, `Result` for internal sub-flows and while iterating on logic in the studio.
- `Conditional`/`Route` — branching. Emit `$branch`; downstream edges carry a `sourceHandle` = branch name and only run when that branch is taken.
- `ForEach`/`Collect` — loop over an array and gather the results.
- `Subflow` — runs another operation (by id) with mapped input and emits its output. This is how one operation calls an internal flow.
- `requireAuth` — verifies the request against an auth policy and attaches `{ user }` for downstream nodes (usually you rely on `_meta.json`/`http.auth` instead; use this node only for in-flow checks).

## Auth

Auth is resolved per operation by walking its path from the API root down:

- `_meta.json` at any level sets a default `auth` policy `{ scheme: 'bearer'|'apiKey', secretRef, header?, verify? }` inherited by every op at or below it. The nearest ancestor wins.
- An operation overrides via `http.auth`: a policy object (use that policy), `'none'` (explicitly public, ignoring inherited policy), or `'inherit'`/absent (defer to the nearest `_meta.json`).
- No `_meta.json` and no `http.auth` → public. A present-but-corrupt `_meta.json` fails closed (the op is denied, not mounted open).

## Environment auth (login once, auto-attach)

Separate from operation `auth` above: an *environment* in `emberflow.environments.json`
(git-ignored) can carry an `auth` block so runs against a real backend authenticate
automatically instead of failing 401 — `{ attach: {as:'cookie'|'header', name, secretRef},
login?: {request:{method,url,headers?,bodyRef?}, capture} }`, where `capture` is
`{from:'set-cookie', cookieName?}` / `{from:'json', path}` / `{from:'header', name}`
and `bodyRef` names a secret holding the login credentials as a JSON string. Once
configured and logged in, the runner attaches the stored credential to every
studio/CLI run against that environment — you never see the secret value, only
`«secret:KEY»` in run output/logs. Run `login-environment <name>` when an op fails
401/unauthorized and `list-environments` shows auth configured but not authenticated
(also use it after scaffolding a new auth block, to verify capture works). If the
login target enforces CSRF origin checks (e.g. better-auth), add a trusted `origin`
header to `login.request.headers`.

`attach.prefix` prepends a fixed string to the credential at attach time (e.g.
`"Bearer "` for a captured token, `"Basic "` when the secret already holds
`base64(user:pass)`). Set (or clear with `--json 'null'`) an environment's auth
block from the CLI: `set-environment-auth <name> --json '<EnvAuth JSON>'`.

When a user asks you to set up auth for an environment (the studio's Manage
Environment dialog's "Set up with AI"), the flow is: compose the `EnvAuth`
JSON from what they describe (curl command, prose, or both) — `attach`
(`as`, `name`, `secretRef`, optional `prefix`) plus an optional `login`
(`request` + `capture`) — apply it with `set-environment-auth`, then tell the
user exactly which secret key(s) to fill in under the dialog's Secrets section
(a `bodyRef` for the login request body, or the `attach.secretRef` for a
static key with no login), and verify with `login-environment` once those
secrets are set. If `login-environment` fails, read the error, adjust the
auth JSON, re-apply, and retry.

Two rules are load-bearing here: **never** edit an environment's `auth`
block in `emberflow.environments.json` directly — `set-environment-auth` is
the only way to change it (the rest of the file is structure-only and safe to
read/edit); and **never** ask for, accept, or handle a credential value
yourself — secret values live in `emberflow.secrets.json` (chmod `0600`,
which you never touch), and the user always enters them in the studio dialog,
never in chat or a CLI arg.

## Scenarios

A scenario is `{ id, name, input, description?, expect? }` in the
`<operation>.scenarios.json` sidecar. For an HTTP operation, `input` is the
request shape `{ params?, query?, body?, headers? }` — running the scenario
passes it through the exact same path a live HTTP request uses, so a green
scenario is real parity. `emberflow run <id> --scenario <name>` runs the op
with that input. In the studio, the Run split-button's dropdown lists
scenarios; each row has a play (run) and a step (step-through) button.
Adding/removing scenarios in the studio round-trips to the sidecar file.

**IMPORTANT: when you build or edit an operation, give its scenarios an
`expect`** so `emberflow test` actually covers them — a scenario with no
`expect` (or `expect: {}`) is silently skipped, not asserted. `expect` is
`{ status?, body?, executedNodes? }`: `body` is checked as a **deep subset**
of the real response (every key you list must match, recursively; extra
response keys are fine — don't restate the whole payload), `executedNodes`
lists node ids that must have reached `succeeded`. Every scenario that
exercises a distinct branch should assert `status` + `executedNodes` for
that branch, so a suite of green scenarios is proof, not vibes:

```json
{
  "id": "not-found",
  "name": "unknown id",
  "input": { "params": { "id": "missing" } },
  "expect": { "status": 404, "executedNodes": ["lookup", "notFoundResponse"] }
}
```

Run the suite with `npx emberflow test [opId] [--environment NAME]
[--json]` — in-process, no runner needed, exit `0`/`1`/`2`. It does **not**
auto-attach environment auth (hermetic by design); a scenario that needs
auth must carry the header/cookie in its own `input`. It also never fires
`errorOperation` (below) — treat `emberflow test` failures as assertion
failures, not incidents.

Add `--mock` to run scenarios as Mock runs (`mockRun: true`) instead of for
real: infrastructure nodes (`traceKind` db/http/llm) return their sidecar
mock (op-level `mocks`, overlaid by the scenario's own `mocks` per nodeId)
instead of touching real Postgres/HTTP/LLM, and fail loudly if a scenario
exercises one with no mock. It's the hermetic way to prove branch coverage
on infra-heavy ops without live infrastructure — `npx emberflow test <opId>
--mock`.

**After creating or editing any operation, run `npx emberflow doctor
<opId>` and resolve every finding before you consider the work done.** It
reports coded diagnostics — `missing-param-default` (a `:param` in the
HTTP path with no value under the Input node's `defaults.params`; leaves
the studio Run button disabled), `param-no-real-scenario` (no scenario
supplies a real value for a path param), `no-expects` (nothing asserts the
operation). `doctor --fix` seeds missing param defaults as `""`
placeholders; real ids in scenarios are your job — pull one from the
project's data when you can. Exit `0` means advisory-only findings; the
studio shows the same diagnostics as a problems chip in the toolbar.

## Retry and error workflow

- **`retry` on a node** — `{ "maxTries": 3, "waitMs": 500 }`, sibling of
  `config`/`optional` in the node JSON. Reach for it on nodes that call a
  flaky external (HTTP, a third-party SDK): `maxTries` is total attempts
  including the first, `waitMs` a fixed delay between them, and only the
  implementation call retries (input/config resolve once). Pair with
  `"optional": true` when the flow should fail soft after retries exhaust
  rather than abort the run.
- **`errorOperation` in `emberflow.config.mjs`** — an op id to run whenever
  a *server* run (live HTTP endpoint or `POST /runs`) finishes `failed`. It
  receives `{ failedRunId, failedWorkflowId, failedNodeId, error,
  environment }`. Use it for alerting/logging side-effect ops, not for
  business logic — it never fires for its own runs, firing is best-effort,
  and `emberflow test`/scenario runs never trigger it.

## Mock mode

Mock is the studio's design-first mode. The environment dropdown's first
row is Mock; picking it is instant, and picking a real environment while
mocked goes live behind a "Go live?" confirm. A project with NO
`emberflow.environments.json` boots in Mock by default (nothing real to
serve against); creating environments — by hand, or via the dropdown's
"Manage environments…" modal whose Set-up-with-AI action opens the agent
panel in environment-setup mode (chat dispatches the `setup-environments`
intent) — is what unlocks going live. That intent scaffolds
environment entries, vars and `protected` flags but never secret values.

**Mock runs execute.** In Mock, Run/Step/scenario runs execute the flow
for real — routing, mappings, step-through — except infrastructure nodes
(`traceKind` `db`/`http`/`llm`) return canned outputs from the scenarios
sidecar's `mocks` maps instead of calling their implementations. Shape:
top-level `"mocks": { "<nodeId>": <output> }` (plain Run uses this) plus
optional per-scenario `mocks` (scenario wins per nodeId); the value is the
node's OUTPUT verbatim — read the node implementation to match its shape.
An infra node with no mock FAILS the mock run loudly (nothing real is ever
touched; no auth attached; subflow children inherit mock mode and use
their own op-level mocks). `compute`/unmarked nodes run their real logic —
so set `traceKind` honestly when authoring nodes: an unmarked infra node
silently executes for real in mock runs. `doctor` reports uncovered infra
nodes as `missing-node-mock`. When you author scenarios for an op with
infra nodes, ALWAYS write the mocks maps (cover-operation does this).
Never put secret values in mocks.

Serving is switchable at runtime via `POST /serving {mode}`, `emberflow serving <real|mock>` from the terminal, or the studio's environment dropdown; `emberflow serve --mock` / `dev --mock` mounts every HTTP endpoint but
answers purely from a scenario's `expect` — no auth, no node execution.
Selection order: `x-emberflow-scenario` request header (exact scenario
name) → `__scenario` query param → the first scenario on that op with an
`expect`. A named-but-unknown scenario is `404`; an op with no mockable
scenario is `501`. Every response carries `x-emberflow-mock: true`, and the
server logs a MOCK MODE banner at boot. Useful for pointing a frontend at
stable canned responses without wiring real backends — but it means an op
needs at least one scenario with `expect` before `--mock` can serve it.
Note: mock serves `expect.body` verbatim as the WHOLE response — a partial subset body written for testing is returned as-is.

## Validation

The runner validates operations: unknown node types, missing edges/handles, orphan
regions, self-referential subflows all surface as errors/warnings. A clean op
runs; an invalid one is rejected. Run the plain Run/default-input path plus one
scenario per branch, and check the run console — the logs stream node-by-node
with input/output you can click into.

## Related skills

- **emberflow-new-workflow** — design and build a brand-new HTTP operation from a goal.
- **emberflow-model-process** — port existing functionality into Emberflow: one process as an operation, or a whole subsystem as an API (its "At subsystem scale" section).
- **emberflow-review-workflow** — review an operation before it ships.
