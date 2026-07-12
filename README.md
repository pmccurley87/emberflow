# Emberflow

Emberflow gives your project a visual studio for **API operations modelled as
node graphs** — build an endpoint by wiring nodes, run it, test it, and ship it
from one place. Every operation runs in two modes from day one: **real**
(against your live environments) and **mock** (design-first, driven by scenario
data, nothing real touched). It is **agent-native** — Codex and Claude Code can
author flows, scenarios, nodes, and environments for you through installed
skills, and a scout that reads your codebase so agents reuse the infrastructure
you already have.

A consumer should be running in about five minutes. Read on, or jump to the
[CLI cheatsheet](#cli-cheatsheet).

## Quick start

> **⚠ Publish pending.** The package is scoped as `@xdelivered/emberflow`
> (the bare name `emberflow` on npm belongs to an unrelated package — don't
> `npm i emberflow`). Until the scoped package is published, install from
> **git** or a **packed tarball** (both fully supported, both ship or build
> the studio + runner). **Full instructions: [INSTALL.md](INSTALL.md).**

```sh
# add Emberflow to a project — git install (runs a guarded `prepare` build):
npm i -D 'git+https://github.com/pmccurley87/emberflow.git'

# …or from a packed tarball (built from a checkout of this repo):
npm pack                     # in the emberflow checkout → xdelivered-emberflow-0.2.0.tgz
npm i -D ../path/to/xdelivered-emberflow-0.2.0.tgz

# then, in your project:
npx emberflow init           # asks JS or TS, scaffolds config + a hello op + agent skills
```

Once published, this becomes `npm i -D @xdelivered/emberflow` /
`npm create @xdelivered/emberflow` — the scaffolding is already wired for it.

`init` asks one question — **JavaScript or TypeScript?** (`--js` / `--ts` to
skip the prompt) — and that decides your runtime:

- **`--js`** (default) scaffolds `emberflow.config.mjs` with JSDoc types. Runs
  on **plain Node** against Emberflow's compiled `dist/` — **no `tsx`**.
- **`--ts`** scaffolds `emberflow.config.ts` + a `tsconfig.json` and asks you to
  `npm i -D tsx typescript`. The runner boots your TypeScript under `tsx`.

`init` scaffolds: the config file, `emberflow/apis/default/hello` (a working
example operation + its scenarios), and the four Emberflow agent skills into
whatever harness it detects (`.claude/` and/or `.codex/`, global or local).

## First run — the welcome checklist

The studio opens on a **welcome checklist** for a fresh project (reach it any
time from the toolbar's **Setup** item). Each row is one setup step with a
status glyph and a button that deep-links to the surface that fixes it:

- **Coding agent detected** — shows which of Codex / Claude Code is on your
  `PATH`, with the detected **version** (a stale CLI that rejects modern models
  is surfaced honestly, not hidden).
- **Environments configured** — Emberflow splits config from secrets across two
  files:
  - `emberflow.environments.json` — **committed-safe**: environment names,
    non-secret `vars` (URLs, ids, flags), `protected` flags, and the *names* of
    the secrets each environment needs. Never any secret value.
  - `emberflow.secrets.json` — **git-ignored, `chmod 600`**: the actual values,
    keyed by environment. Agents never read it. A value of `"$ENV:VAR_NAME"`
    resolves from `process.env` at load.
- **Secrets present** for the default environment.
- **Agent skills installed** (re-run `npx emberflow init` to add them).
- **Infrastructure scouted** — dispatches the scout (below).
- **First operation** — open the hello op or ask the agent to build one.

A brand-new project **starts in Mock**: with no environments there is nothing
real to serve against, so everything previews from scenarios until you
deliberately create an environment. The environment dropdown (top-right) is the
single mode control — **Mock** is its first row, real environments follow, and
switching to a real one crosses a "Go live?" confirmation.

## The infrastructure scout

Point an agent at a brownfield repo and the **scout** reads it — dependencies,
lockfiles, ORM schemas, config files, env-var references, HTTP/SDK usage — and
writes a **committed, secrets-free manifest** at `emberflow/infrastructure.json`
describing what your project already uses. The studio's **Infra** dock tab
renders it, and agents read it before authoring operations so they **reuse**
your real databases/APIs/providers instead of inventing parallel config.

```json
{
  "version": 1,
  "greenfield": false,
  "summary": "Express app with Postgres (Prisma), Stripe, and SendGrid.",
  "items": [
    {
      "id": "postgres-main",
      "kind": "database",
      "name": "Postgres (Prisma)",
      "evidence": [{ "file": "prisma/schema.prisma", "note": "datasource provider=postgresql" }],
      "suggestedSecretRefs": ["DATABASE_URL"],
      "notes": "Schema defines User, Order, Invoice models."
    }
  ]
}
```

Names and env-var **names** only — never values. Run it from the welcome
checklist or the agent panel; it needs a coding agent on your `PATH`.

## Building APIs

You build operations visually (drag nodes, wire them, set HTTP metadata), and
your own code plugs in as **custom nodes** registered in the config's
`registerNodes(registry)` — they run server-side next to your app, so they reach
your DB and services. Or hand it to an agent: the installed **skills** teach it
Emberflow's file layout, node mechanics, and review rubric, and it consults the
**scout manifest** first so it reuses your infrastructure. Ask in the agent
panel ("build a checkout endpoint"), and it authors the flow, scenarios, and any
new nodes, then runs `doctor` to clean up before finishing.

**Operational commit posture** — an operation runs at one of three levels:

- **Mock** — infrastructure nodes return canned scenario outputs; nothing real
  is ever touched, no auth attached. Design-time default.
- **Dry-run** — real environment, but mutation nodes with `config.commit`
  unset (or a protected env's safe-mode on) perform reads and log what they
  *would* write, without doing it.
- **Commit** — `config.commit === true` on a real, unprotected env: mutation
  nodes perform the real side effect. Faking success on the commit path is
  forbidden and `doctor` flags it.

## CLI cheatsheet

| Command | What it does |
|---|---|
| `emberflow init [--js\|--ts] [--global\|--local] [--no-skills] [--no-launch]` | scaffold config, example op, agent skills |
| `emberflow dev [--port N] [--project DIR]` | studio + runner in one process, opens the browser |
| `emberflow serve [--port N] [--mock]` | run the API host headless (no studio) |
| `emberflow test [opId] [--environment NAME] [--json]` | assert scenario `expect` blocks in-process (CI-ready) |
| `emberflow doctor [opId] [--fix]` | report/repair operation invariants in-process |
| `emberflow run <opId> [--scenario NAME]` | run an operation against a live runner |
| `emberflow list-environments` / `login-environment <name>` | inspect / authenticate an environment |
| `emberflow mcp` | serve the MCP tools (list/get/save/validate/run workflows) |

## Docs

Depth on each area lives under [`docs/superpowers/specs/`](docs/superpowers/specs/):

- [Consuming Emberflow](docs/superpowers/specs/2026-07-05-consuming-emberflow.md) — config, custom nodes, runtime matrix.
- [Agent-native usage](docs/superpowers/specs/2026-07-06-agent-native-usage.md) — how the studio dispatches agents.
- [HTTP API endpoints](docs/superpowers/specs/2026-07-07-api-endpoints-usage.md) — auth policies, Response nodes, mock serving.
- [Onboarding & scout design](docs/superpowers/specs/2026-07-12-onboarding-infra-scout-design.md) — welcome checklist + infrastructure scout.

Working on Emberflow itself? See [CONTRIBUTING.md](CONTRIBUTING.md).
</content>
