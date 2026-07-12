# Onboarding, infrastructure scout, and packaging — design

Date: 2026-07-12
Status: goal-approved (user), executing.

## Goal

An external repo pulls Emberflow in and gets started immediately: agent
detection that actually tells the truth, a welcome checklist that walks the
user through setup before their first API or migration, an agent-driven
infrastructure scout that discovers what a brownfield project already uses
(databases, APIs, providers) and displays it in the studio, agents that reuse
that infrastructure when authoring operations — and, last, the package itself
made cleanly consumable.

## Phase 1 — Agent detection that tells the truth

Today `detect.ts` runs `<bin> --version` and keeps only the exit code; a
stale codex CLI that rejects modern models "detects" fine and dies at run
time with `codex exited with code N` (the live incident: codex 0.142.5 vs
gpt-5.6-sol).

- `detectAgents()` → `[{ kind, version: string|null }]` — parse the
  `--version` stdout (first semver-ish token), null when unparseable.
  `/agent/available` returns the richer shape; `agentClient` +
  `SettingsDialog` show the version next to each backend.
- Runtime failure mapping: when a codex/claude run exits nonzero having
  produced no `done`, the adapter's error event gains a hint when the stderr
  tail matches known model-rejection shapes ("unknown model", "unsupported
  model"): "your <kind> CLI may be too old for the selected model — upgrade
  it or switch backend in Settings". No hard version gate (model catalogs
  move too fast to pin), just honest surfacing.
- No probe runs — detection stays cheap and offline.

## Phase 2 — Welcome checklist (first-run service)

- **GET `/setup-status`** aggregates what exists today plus the new bits:
  `{ agents: [{kind,version}], environments: {configured, count, protectedCount,
  anyAuthConfigured}, skills: {claude: bool, codex: bool} (probe
  .claude/skills/emberflow-basics + .codex equivalents under the project
  root), language, ops: {count, onlyHello: bool}, servingMode,
  infrastructure: {present: bool, scannedAt?, itemCount?} }`.
- **Welcome view** (`src/components/WelcomeDialog.tsx`): a checklist rendered
  from `/setup-status`, one row per item with status glyph + one-line
  explanation + an action button that deep-links to the existing surface:
  - Coding agent detected → opens SettingsDialog (shows versions; "none
    detected" explains install options).
  - Environments configured → opens the agent panel in env-setup mode (the
    existing `agentEnvSetup` flow) or the Environments dialog.
  - Secrets present for the default env → Environments dialog.
  - Agent skills installed → shows the `npx emberflow init` re-run hint
    (skills-only) when missing.
  - Infrastructure scouted → runs the Phase-3 scout intent (button disabled
    with reason when no agent CLI detected).
  - First operation → "Open the hello op" / "Ask the agent to build one".
- Auto-opens on boot when the project looks fresh (`ops.onlyHello &&
  !environments.configured`) and hasn't been dismissed
  (`localStorage['emberflow.welcome.dismissed']`); always reachable from the
  Toolbar (a "Setup" item). Non-fresh projects never see it uninvited.
- Styling: existing tokens (SettingsDialog card/list pattern).

## Phase 3 — Infrastructure scout

### The manifest — `emberflow/infrastructure.json` (COMMITTED, no secrets)

```json
{
  "version": 1,
  "scannedAt": "<iso>",
  "greenfield": false,
  "summary": "Express app with Postgres (Prisma), Stripe, and SendGrid.",
  "items": [
    {
      "id": "postgres-main",
      "kind": "database",            // database|http-api|queue|cache|email|llm|auth|framework|storage|other
      "name": "Postgres (Prisma)",
      "evidence": [{ "file": "prisma/schema.prisma", "note": "datasource db provider=postgresql" }],
      "suggestedSecretRefs": ["DATABASE_URL"],
      "suggestedVars": [],
      "notes": "Schema defines User, Order, Invoice models."
    }
  ]
}
```

Names and env-var NAMES only — never values. Evidence points at files so the
studio can show provenance and agents can jump straight to the source.

### The scout intent — `scout-infrastructure`

New AgentIntent (prompt.ts), the deliberate inverse of `setup-environments`'s
don't-explore rule: this intent's JOB is to read the project. Prompt:
enumerate dependencies (package.json/lockfiles, requirements.txt, go.mod...),
config files, ORM schemas, env-var references, HTTP clients/SDK usage,
existing route definitions; classify into the manifest kinds; write
`emberflow/infrastructure.json` (create `emberflow/` if needed); NEVER copy a
secret value into it (env-var names only); end with a short summary + the
open questions (things it could not classify). Greenfield → `greenfield:
true`, empty items, one-line summary. Route validation mirrors
setup-environments (instruction only). Dispatched from the Welcome checklist
and the agent panel; `emberflow scout [instruction]` CLI can come later.

### Serving + display

- **GET `/infrastructure`** — re-read-on-GET like `/environments` (fresh after
  an agent writes it; malformed file keeps last good + warns).
- **Dock tab "Infra"** (third tab beside Logs/Output): card grid, one card
  per item — kind badge (small colored chip per kind), name, evidence list
  (file:note, clickable no-op for now), suggested secretRef names as chips,
  notes line. Empty state: "Not scouted yet" + the run-scout button (same
  dispatch as Welcome). Summary line on top. Greenfield state says so.

### Agents use it

- `AgentRunManager` gains an `infrastructure: () => InfrastructureManifest|null`
  getter (the `availableNodes` pattern); `buildPrompt` gains the param and a
  preamble block after the node palette: "Known project infrastructure (from
  emberflow/infrastructure.json): - <name> (<kind>) — secretRefs: …, see
  <evidence file>" plus one rule line: when an operation needs infrastructure
  this manifest already names, REUSE it — same secretRef names, same systems —
  instead of inventing parallel config; when the manifest is absent or stale,
  say so rather than guessing.
- Skills: `emberflow-basics` file layout gains `emberflow/infrastructure.json`
  (committed, structure-only); new-workflow + model-process intake sections
  point at the manifest as the FIRST place to look before asking the user
  about infrastructure (shrinks the interview further).

## Phase 4 — Brownfield e2e

Extend the consumer testing (not the smoke matrix — a separate deeper pass,
like the emberflow-sample exercise): a temp project that fakes a brownfield
app (package.json with pg + stripe + express, a couple of source files
referencing process.env.DATABASE_URL / STRIPE_SECRET_KEY, a prisma schema) →
tarball install → init → REAL scout run (claude backend) → assert the
manifest exists, has ≥2 sensible items, no secret values → `/infrastructure`
serves it → a `new-operation` prompt contains the manifest block. Keep the
sample repo at ~/dev/emberflow-brownfield-sample for the user.

## Phase 5 — Package as a consumable service (LAST)

- Version bump 0.1.0 → 0.2.0; README rewritten for consumers (quick start,
  language choice, welcome checklist, scout, dual-mode model, operational
  commit posture — short, links into docs/).
- `npm publish --dry-run` clean (files list, no stray artifacts, dist built
  by prepack). `prepare` script decision for git-installs: prepack doesn't
  run on git deps — add a guarded `prepare` (build only when src present and
  dist absent) so `npm i github:...` works, or document tarball/registry as
  the supported channels. Decide by testing a real git install.
- create-emberflow: version bump, README, forwards everything.
- Full gates: vitest, both smoke variants, sample repos still boot.

## Out of scope

- npm registry publish itself (user's call; everything up to `npm publish`
  proven with --dry-run).
- Live infra probing (scout reads code, never connects to databases).
- CLI `emberflow scout` command (studio + agent panel first; CLI later).

## Order

Phases 1→2→3→4 sequential (each builds on the last), 5 strictly last.
