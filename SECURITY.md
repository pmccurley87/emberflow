# Security

Emberflow is a **local development tool**. It runs a studio + operation runner
on your machine and can dispatch coding agents against your project. Read this
before running it anywhere other than your own workstation.

## Threat model in one line

The Emberflow runner is trusted, unsandboxed local tooling. It is **not**
hardened for exposure to untrusted networks or untrusted callers. Treat it like
`vite` or a local `node` dev server, not like a production service.

## Loopback-only binding

The runner binds to **loopback only** — `server/index.ts` sets
`const HOST = '127.0.0.1'` and listens on that address. It is not reachable from
other machines. **Do not** change the bind address, put it behind a public
reverse proxy, or forward its port. There is no authentication on the control
API (see below) because it assumes only local processes can reach it.

## The agent execution model (important)

The studio can spawn coding agents (Codex / Claude Code) to author flows,
scenarios, and nodes. Those agents run **against your project directory with
broad permissions**:

- Claude Code is launched with `--permission-mode bypassPermissions`.
- Codex is launched with `-s workspace-write` (file writes scoped to the
  workspace) **with network access enabled**.

In other words, an agent run is **unsandboxed by design**: it can read and write
files in the project and run commands. This is acceptable for a tool you drive
on your own machine against your own code. It is **not** acceptable to expose the
runner's port to anyone else — a caller who can reach the control API can trigger
agent runs, i.e. arbitrary local code execution. Never run Emberflow on a shared
or public host.

## Served operations vs. the control API

There are two distinct HTTP surfaces:

- **Served operations** (your API endpoints) enforce the auth policy you attach
  to each operation (API key, bearer, etc.). These are the endpoints you design
  and can expose to your own app in development.
- **The control API** (studio actions, agent dispatch, environment management)
  has **no auth** and relies entirely on loopback trust — the assumption that
  only processes on your machine can reach `127.0.0.1`.

Keep that distinction in mind: adding auth to a served operation does not protect
the control API, which must stay loopback-only.

## Secrets

Secret values live in `emberflow.secrets.json`, which is git-ignored and should
be `chmod 600`. The committed `emberflow.environments.json` holds only the
*names* of secrets, never values. Agents never read the secrets file.

## Reporting a vulnerability

Please report security issues privately to **patrick@xdelivered.com**. Do not
open a public issue for anything exploitable. We'll acknowledge and work a fix
before any public disclosure.
