# HTTP endpoints: usage guide

An Emberflow operation with `http` metadata is a live HTTP endpoint — no
separate router to write, no controller code. This is a usage guide, not a
design doc; it's grounded directly in the current implementation.

## 1. What makes an operation an endpoint

Every workflow (`WorkflowDefinition`, `src/engine/types.ts`) has an optional
`http` field:

```ts
export interface HttpTrigger {
  method: string;
  path: string;
  inputSchema?: unknown;
}

export interface WorkflowDefinition {
  // ...
  /** Present → this flow is (or will be) an HTTP endpoint. Absent → internal sub-flow. */
  http?: HttpTrigger;
  // ...
}
```

- **`http` present** → the flow is routed: `method` + `path` become a live
  route (e.g. `{ method: 'POST', path: '/echo' }` serves `POST /echo`).
- **`http` absent** → the flow is an internal sub-flow. It still runs (from
  the studio, from a `Subflow` node, via the CLI), it's just never mounted as
  a route.
- **`inputSchema`** is optional. When present, it's checked against the
  request body before the flow runs (see §4).

## 2. What the flow receives

The routed operation's entry node gets the whole request as its run input:

```ts
{ params, query, body, headers }
```

(`server/httpOperations.ts`, `makeOperationHandler`) — `params` are Express
route params, `query` the parsed query string, `body` the parsed JSON body,
`headers` the request headers. Map whichever pieces you need off of this
object in your flow's `Input` node / field mappings, the same way any other
flow input is wired.

## 3. The Response node

`Response` (`src/nodes/response.ts`) is the terminal node for shaping the
HTTP response. Its input is `{ status, body }`; `status` defaults to `200`
when omitted:

```ts
async (ctx) => {
  const input = (ctx.input ?? {}) as { status?: unknown; body?: unknown };
  const status = typeof input.status === 'number' ? input.status : 200;
  return { status, body: input.body };
}
```

At the end of a run, `extractResponse` (`server/operationResult.ts`) decides
what goes on the wire:

- If the flow has a `Response` node and it produced `{ status, body }`, that
  wins.
- Otherwise the response is `200` with the run's `Result` node output as the
  body.

So a flow with no `Response` node still works as an endpoint — it just always
answers `200` with whatever its `Result` node produced. Add a `Response` node
when you need a different status code (`201` for a created resource, `404`
for "not found", etc.) or a response shape distinct from the flow's result.
Since `status` is just a number wired into the node's input, picking the
status code is a builder-time (visual) decision, not code you write.

## 4. Input validation (400s)

When `http.inputSchema` is set, the request body is checked against it before
the flow runs, using `validateAgainstSchema`
(`src/engine/schemaCheck.ts`). This is a **minimal** validator — it supports:

- `type: 'object'` — the body must be an object.
- `required: string[]` — listed keys must be present and not `undefined`.
- `properties: { [key]: { type } }` — for keys present in the body, checks
  the value's primitive type (`string` / `number` / `boolean` / `object` /
  `array`).

Any other schema shape (or no schema) imposes no constraint — unsupported
JSON-Schema keywords (`enum`, nested `properties`, `array`/`items`, etc.) are
silently ignored, not rejected. Example schema:

```json
{
  "type": "object",
  "required": ["name"],
  "properties": {
    "name": { "type": "string" }
  }
}
```

If validation fails, the request never reaches the flow — the server
responds immediately with:

```
400 { "error": "<first validation failure message>" }
```

e.g. `{ "error": "missing required field: name" }` or
`{ "error": "field name must be a string" }`.

## 5. HttpError — throwing your own response

A node can throw `HttpError` (`src/engine/httpError.ts`) to control the
response directly, bypassing `Response`/`Result` entirely:

```ts
export class HttpError extends Error {
  readonly status: number;
  readonly body?: unknown;
  constructor(status: number, body?: unknown) { /* ... */ }
}
```

`makeOperationHandler` catches it and responds `status` + `body` (or `null`
if no body was given). Any other uncaught error during the run is logged
server-side (`console.error`) and responds with a generic
`500 { "error": "internal error" }` — the raw error message is never sent to
the client, since it could contain secrets (e.g. a DB connection string or an
API key embedded in a URL).

## 6. Running it

> ⚠ **Auth is available (Increment 3), but it's opt-in per subtree/operation
> — see §9. An operation with no auth policy anywhere in its ancestor chain
> is public by design. Before exposing `emberflow serve` to untrusted
> networks / a public reverse proxy, set an auth policy on every endpoint
> that shouldn't be public.**

- **`emberflow dev`** — studio + runner + a browser tab. This is the normal
  day-to-day loop: build/edit flows visually, and any flow with `http` is
  simultaneously live as an endpoint on the same server.
- **`emberflow serve`** — the runner only: API + routed operations, no
  studio, no browser tab. Use this as the headless API host (e.g. in
  production or CI) once your flows are built.

Both commands boot the same `server/index.ts`; `serve` just omits
`EMBERFLOW_SERVE_STUDIO`/`EMBERFLOW_OPEN_BROWSER`.

`emberflow init` scaffolds `emberflow/apis/default/` (`bin/init.ts`) — an
empty directory the API host reads from — so the moment you author an
operation there (with or without `http`), `dev`/`serve` picks it up on the
next boot. You don't set up routing separately; you build the operation in
the studio and the HTTP layer is just there, mounted automatically for any
operation that declares `http`.

At boot, `server/index.ts` logs:

```
[runner] mounted N HTTP operation(s)
```

Routed operations run against the project's **default environment**'s
secrets and vars, resolved once at boot — there is no per-request
environment override for a live endpoint (unlike a studio-triggered run,
which can pick an environment per run).

## 7. Current limitation: read-once at boot

Operations (and their `http` triggers) are read from disk **once, at server
boot**. Adding a new operation with an `http` trigger, or editing an
existing one's `method`/`path`/`inputSchema`, requires **restarting** the
server (`emberflow dev` / `emberflow serve`) before the change is routed.
Live re-mounting without a restart is not implemented yet.

Also note: a duplicate `method` + `path` across operations throws at boot —
a loud failure rather than one route silently shadowing another.

## 8. Worked example: an echo operation

A minimal operation: `Input → Response`, routed as `POST /echo`, with an
`inputSchema` requiring `name`:

```json
{
  "http": {
    "method": "POST",
    "path": "/echo",
    "inputSchema": {
      "type": "object",
      "required": ["name"],
      "properties": { "name": { "type": "string" } }
    }
  }
}
```

The `Response` node is wired to answer `201` with the request body echoed
back as-is.

Verified live:

```sh
curl -X POST http://127.0.0.1:8092/echo \
  -H 'Content-Type: application/json' \
  -d '{"name":"Patrick","msg":"hello api"}'
```

```
201
{"name":"Patrick","msg":"hello api"}
```

Missing the required field:

```sh
curl -X POST http://127.0.0.1:8092/echo \
  -H 'Content-Type: application/json' \
  -d '{"msg":"no name"}'
```

```
400
{"error":"missing required field: name"}
```

The second request never touched the flow — it was rejected by the input
schema check before any node ran.

## 9. Authentication

Auth is an **inheritable policy**, resolved per operation and enforced
in-engine — before input validation, before the flow runs. There is no
separate auth router; protecting an endpoint is a config file, not code.

### 9.1 Protect a subtree

Drop a `_meta.json` next to an API (or any folder under it), in
`emberflow/apis/<api>/`:

```json
{
  "auth": {
    "scheme": "bearer",
    "secretRef": "API_TOKEN"
  }
}
```

Every operation under that directory — recursively, through subfolders —
inherits this policy by default. A deeper folder can drop its own
`_meta.json` with its own `auth`; the **nearest ancestor** to the operation
wins (a folder's `_meta.json` overrides the API root's, and so on down the
tree). `_meta.json` itself is never treated as an operation — it's skipped
by the store's scan.

### 9.2 Per-operation override

An operation's own `http.auth` field overrides whatever it would otherwise
inherit:

```ts
export interface HttpTrigger {
  method: string;
  path: string;
  inputSchema?: unknown;
  auth?: AuthPolicy | 'none' | 'inherit';
}
```

- A policy object (`{ scheme, secretRef, verify?, header? }`) — replaces the
  inherited policy with this one, for this operation only.
- `'none'` — makes this ONE operation explicitly public, even though its
  API/folder is protected. Useful for e.g. a health-check or signup endpoint
  living under an otherwise-protected API.
- `'inherit'` or the field absent — defers to the nearest ancestor
  `_meta.json`'s policy (or public, if none exists).

### 9.3 Public by default

**An operation with no policy anywhere in its ancestor chain — no
`_meta.json` up to the API root, and no `http.auth` override — is public.**
This is the same rule the Increment-2 warning in §6 pointed at: Emberflow
does not force auth on you. Protecting an endpoint is something you opt
into by adding a `_meta.json` or an `http.auth` policy; an operation you
never gave a policy stays open.

### 9.4 Schemes

Two default verifiers ship out of the box (`src/engine/authVerify.ts`):

- **`bearer`** — reads `Authorization: Bearer <token>`; the token must
  exactly match the resolved secret.
- **`apiKey`** — reads a header (`x-api-key` by default; override with
  `policy.header`) whose value must exactly match the resolved secret.

Both are shared-secret comparisons (plain `===`, not timing-safe — a later
hardening item), not JWT/OAuth. `secretRef` names a key in the run
environment's `secrets` map — i.e. an entry under `environments.<name>.secrets`
in `emberflow.environments.json`, or (legacy single-environment projects)
a key in `emberflow.secrets.json`. The **default environment**'s secrets are
what a live endpoint runs with (same as any other operation — see §6).

### 9.5 Custom verifiers (real JWT/OAuth)

For anything beyond a shared secret, register a named `Verifier` in
`emberflow.config.mjs`:

```js
// emberflow.config.mjs
import { defineConfig } from 'emberflow';
import { HttpError } from 'emberflow/engine';

export default defineConfig({
  registerVerifiers(registry) {
    registry.register('myJwt', ({ request }) => {
      const auth = request.headers['authorization'];
      const token = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : undefined;
      if (!token) throw new HttpError(401, { error: 'unauthorized' });
      // ... verify the JWT (signature, expiry, issuer) with your library of choice ...
      const claims = verifyJwt(token); // throws on invalid/expired
      return { user: { sub: claims.sub, roles: claims.roles } };
    });
  },
});
```

Then reference it by name in a policy's `verify` field — `scheme` is still
required (it's part of the `AuthPolicy` shape) but is ignored once `verify`
names a registered verifier:

```json
{ "auth": { "scheme": "bearer", "secretRef": "unused", "verify": "myJwt" } }
```

`registerVerifiers` runs once at boot, alongside the default `bearer`/`apiKey`
registrations (`server/index.ts`) — custom verifiers augment, not replace,
the defaults.

### 9.6 The verified `user`

On success, a verifier returns `{ user }`. The handler attaches it to the
run's input alongside `params`/`query`/`body`/`headers`:

```ts
{ params, query, body, headers, user }
```

so any node downstream reads it off `ctx.input.user` — e.g. `{ scheme:
'bearer' }` for the default bearer verifier, or whatever shape your custom
verifier returned (`{ sub, roles }` in the sketch above).

The same verify logic is also available as an explicit in-flow node,
`requireAuth` (`src/nodes/requireAuth.ts`) — config carries the policy
fields (`scheme`, `secretRef`, `verify?`, `header?`); it reads
`ctx.input.headers` and `ctx.secrets`, and returns `{ user }` or throws
`HttpError(401/500)`. This is a second entry point onto the same
`enforceAuth` used by the HTTP handler — useful when you want the auth
check to appear as a visible node in the flow rather than an implicit
pre-check. It only has the default bearer/apiKey verifiers available (a
project's `registerVerifiers` custom verifiers are a server-side handler
concern), unless `policy.verify` happens to name `bearer`/`apiKey`.

### 9.7 Fail-closed guarantees

- **Auth precedes everything else.** `enforceAuth` runs before input-schema
  validation and before the flow runs (`server/httpOperations.ts`) — so an
  unauthorized request never reaches a `400` from validation, and never
  triggers a run of secret-bearing flow logic. 401 precedes 400.
- **Missing verifier or missing secret → 500, never open.** If a policy
  names a `verify` (or `scheme`) that isn't registered, or `secretRef`
  doesn't resolve to a string in the environment's secrets, the verifier
  throws `HttpError(500)` — it never falls through to treating the request
  as authenticated or the endpoint as public.
- **A corrupt `_meta.json` fails the whole subtree closed, not open.** If a
  `_meta.json` file exists but fails to parse (partial write, typo), the
  boot-time route mount for every operation under it responds `500
  {"error":"auth misconfigured"}` instead of mounting with whatever policy
  it would otherwise have resolved to. This is deliberate: a broken
  `_meta.json` could plausibly have been meant to protect the subtree, so
  the runner refuses to guess and silently mount it public
  (`server/apiStore.ts` `resolveAuth`, `server/index.ts` boot loop). A
  merely **absent** `_meta.json` is fine and contributes no policy — only a
  present-but-broken one trips this.

### 9.8 Worked example

A bearer-protected `POST /svc/echo`, with `emberflow/apis/svc/_meta.json`:

```json
{ "auth": { "scheme": "bearer", "secretRef": "API_TOKEN" } }
```

and the default environment's secret `API_TOKEN=s3cr3t-token`. Verified live:

No token:

```sh
curl -i -X POST http://127.0.0.1:8092/svc/echo \
  -H 'Content-Type: application/json' -d '{"x":1}'
```

```
401
{"error":"unauthorized"}
```

With the token:

```sh
curl -i -X POST http://127.0.0.1:8092/svc/echo \
  -H 'Authorization: Bearer s3cr3t-token' \
  -H 'Content-Type: application/json' -d '{"x":1}'
```

```
201
{"x":1,"ok":true}
```

A sibling operation under the same protected API, but with its own
`http.auth: "none"`, answers without any token — `201` with no
`Authorization` header sent at all — because the per-operation override
takes precedence over the inherited `_meta.json` policy.

## 10. Building operations in the studio (Increment 4)

Everything above is about what an operation's `http` metadata *does* once it
exists. This section is about *creating and editing* that metadata from the
studio itself — no hand-written JSON required, though the JSON is still what
ends up on disk.

### 10.1 The sidebar tree

The studio sidebar (`src/components/Sidebar.tsx`) renders operations as a
Postman-like tree, built from the on-disk `apis/` layout by
`buildApiTree` (`src/store/apiTree.ts`):

- **APIs** — the top-level nodes, one per `apis/<api>/` directory.
- **Folders** — nested directories under an API, arbitrarily deep.
- **Operations** — leaves. Each row shows a method badge (`GET`/`POST`/`PUT`/
  `PATCH`/`DELETE`, color-coded — green for `GET`, a highlight color for
  `POST`, red for `DELETE`, neutral for `PUT`/`PATCH`) and, on the right, its
  HTTP path in monospace. An operation with no `http` trigger shows
  **`internal`** on its badge instead of a method, and no path — this is the
  same internal/routed distinction from §1.

Clicking an operation row switches the canvas to that operation
(`switchWorkflow`), same as picking it any other way. Clicking an API or
folder row toggles it collapsed/expanded; each row also shows a count of the
operations it (recursively) contains.

The tree is derived, not stored — it's rebuilt from the flat list of
workflow summaries (`id`, `path`, `http`) every time the workflow list
changes, grouping by the `/`-separated segments of each operation's `path`
(first segment = API, last segment = operation, everything in between =
folders).

### 10.2 Creating an operation

The **"New operation"** control (the `+` button above the tree) opens a
popover (`NewOperationForm` in `Sidebar.tsx`) with:

- **API** — required. A text input with autocomplete against existing API
  names (so you can add to an existing API or type a new one).
- **Folder** — optional. A plain text field; leave it blank to create the
  operation directly under the API.
- **Name** — required. Slugified into the operation's on-disk filename.
- **Method** — optional. Defaults to "internal" (no HTTP trigger). Choosing a
  method reveals the path field.
- **Path** — only editable once a method is chosen.

Submitting calls `createOperation` (`src/store/builderStore.ts`), which:

1. Builds the operation's id/path as
   `<api>/<folder>/<slug(name)>` (folder segment omitted if blank).
2. Starts the flow with a bare `Input` node, adding a `Response` node wired
   to it only if a method was chosen (an internal-only operation gets just
   `Input`).
3. Sets `http: { method, path }` on the flow only when both a method and a
   non-empty path were given.
4. Calls `createOperationOnServer`, which `POST`s `{ flow, path }` to
   `server/index.ts`'s `POST /operations`.

On disk this lands at `emberflow/apis/<api>/<folder>/<slug>.json` (via
`ApiStore.save`, `server/apiStore.ts`) — the same file layout every other
section of this doc assumes.

**Collision handling.** `POST /operations` is deliberately *create-only*: it
checks `apiStore.existsAt(path)` and, if a file already exists at that exact
path, responds `409 { "error": "operation already exists at <path>" }`
instead of overwriting it (overwriting an existing operation goes through
`PUT /workflows/:id` instead). The form surfaces this as an inline error
under the fields — `result.error` is shown as-is — and does *not* close the
popover or navigate away, so you can change the name/folder and retry. The
endpoint also 400s if the path isn't a safe relative path (no `..` /
absolute paths) or if the flow's `id` doesn't equal the target `path` — both
are internal-consistency guards, not user-facing input mistakes in the
normal flow through the form.

On success, the studio re-syncs its workflow list from the runner and
switches the canvas to the new operation.

### 10.3 Editing HTTP from the Inspector

Once an operation is open, its `HttpSection` in the Inspector
(`src/components/Inspector.tsx`) is where `http` gets edited going forward
(the "New operation" form only sets the *initial* method/path):

- **"HTTP endpoint" toggle** — checkbox that adds/removes the `http` field
  entirely. Turning it on when no `http` existed yet defaults to
  `{ method: 'GET', path: '/' }`; turning it off sets `http` to `undefined`
  (the operation becomes internal again, same as never having had a method
  in the "New operation" form).
- **Method / path** — a method `<select>` and a path `<input>`, editable
  whenever the toggle is on.
- **Input schema** — a JSON textarea bound to `http.inputSchema`. Edits are
  parsed on every keystroke; valid JSON updates the flow immediately,
  invalid JSON is left as a draft with an inline "invalid JSON: ..." error
  and does *not* touch the stored flow until it parses again.
- **Auth** — a select with **Inherit / None (public) / Bearer token / API
  key**, matching the `AuthKind`s in §9: `inherit` removes `http.auth`
  entirely (defers to the nearest ancestor `_meta.json`, or public), `none`
  sets `http.auth: 'none'`, and `bearer`/`apiKey` set
  `http.auth: { scheme, secretRef, header? }` with a secret-ref field (and,
  for `apiKey`, a header-name field, default `x-api-key`).

None of this calls a save endpoint directly — like every other flow edit,
changing `http` here just updates the in-memory flow, and the store's
autosave (an 800ms idle debounce, foreground-tab-only — see
`builderStore.ts`) writes it back through the normal `PUT /workflows/:id`
path shortly after you stop typing.

### 10.4 Restart still required to route it

Creating an operation with a method/path in the studio, or flipping the
"HTTP endpoint" toggle on for the first time, does **not** make it live
immediately. §7's read-once-at-boot limitation applies here unchanged: the
studio's sidebar tree and Inspector reflect the new/edited operation right
away (they read the workflow list the studio already has in memory), but
the actual Express route is only mounted from what `server/index.ts` read
at boot. A brand-new endpoint, or a method/path change to an existing one,
needs a restart of `emberflow serve` / `emberflow dev` before it's
reachable over HTTP — same restart already required for any other
`http`-metadata edit made outside the studio.
