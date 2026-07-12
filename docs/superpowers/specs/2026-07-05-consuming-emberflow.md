# Consuming Emberflow from your own project

> The root [README.md](../../../README.md) is now the canonical quick start for
> consumers (install channels, welcome checklist, scout, commit posture). This
> document is the deeper reference — config contract, custom nodes, runtime
> matrix — that the README links into.

Verified end-to-end on 2026-07-05: a tarball install in a scratch project
*outside* the Emberflow repo, scaffolded and launched with the CLI, running a
consumer's own custom node.

## Quick start

```bash
# scaffold + launch in one step
# NOTE: publish pending — the package is scoped as `@xdelivered/emberflow`
# (the bare `emberflow` name on npm belongs to an unrelated package).
# Install from git or a packed tarball until the scoped package is published (see README).
npm create @xdelivered/emberflow@latest   # (post-publish form)

# or, in an existing project:
npm i -D @xdelivered/emberflow
npx emberflow init          # asks JS or TS, then scaffolds the config + emberflow/apis/default/hello
npx emberflow dev           # boots the studio at http://127.0.0.1:8092 and opens the browser
```

### JavaScript or TypeScript?

`init` asks which language you want to author your config and nodes in (pass
`--js` / `--ts` to skip the prompt). The choice decides the runtime:

- **`--js`** (default) scaffolds `emberflow.config.mjs` with JSDoc types
  (`/** @param {import('@xdelivered/emberflow').NodeRegistry} registry */`). It runs on
  **plain Node** against Emberflow's compiled `dist/` — **no `tsx`** required.
- **`--ts`** scaffolds `emberflow.config.ts` + a minimal `tsconfig.json` and
  prompts you to `npm i -D tsx typescript`. The runner boots the TypeScript
  sources under `tsx`.

Either way the config carries an explicit `language: 'javascript' | 'typescript'`
field — that is the **authoritative signal** agents, skills, and `doctor` read
(never sniff the file extension). A `.ts` config forces `tsx` even in a JS
project; keep `language:` and your file extensions in agreement.

### Runtime support matrix

| | JS project | TS project |
|---|---|---|
| config | `emberflow.config.mjs` (JSDoc types optional) | `emberflow.config.ts` (typed) |
| nodes | plain ESM JS | TS, loaded via `tsx` |
| runtime deps | `@xdelivered/emberflow` only (plain Node ≥20) | `@xdelivered/emberflow` + `tsx` (dev dep) |
| runner spawn | `node dist/server/index.js` | `tsx`-registered entry |
| typecheck | none required | your own `tsc` (init's `tsconfig.json`) |
| agents author | `.mjs` / JSDoc | `.ts` / typed |

`tsx` is an **optional peer dependency**: a JS consumer's install never pulls
it, and a TS consumer adds it explicitly with `npm i -D tsx typescript`.

## Agent skills (auto-installed)

`emberflow init` installs four Emberflow skills into whatever agent harness the
project uses — it detects Claude Code (`.claude/`) and Codex (`.codex/`), asks
whether to install **globally** (all projects, `~/.claude` / `~/.codex`) or into
**this repo**, and drops the same `SKILL.md` files into each (both harnesses share
the skill format). Then it launches the studio so you can start immediately.

The skills teach an agent how to work with Emberflow correctly:

- **emberflow-basics** — file layout, CLI, MCP, node mechanics, running scenarios.
- **emberflow-new-workflow** — design + build a brand-new workflow from a goal.
- **emberflow-model-process** — port an existing process/codebase into a flow faithfully.
- **emberflow-review-workflow** — a review rubric run before a flow ships.

Flags: `--global` / `--local` (skip the prompt), `--no-skills` (don't install),
`--no-launch` (scaffold without starting the studio). `init` also prints an MCP
registration snippet for `emberflow mcp`.

## The config

`emberflow.config.mjs` at your project root is the whole contract:

```js
import { defineConfig } from '@xdelivered/emberflow';

export default defineConfig({
  flowsDir: 'emberflow/flows',        // default: emberflow/flows
  registerNodes(registry) {
    // your project's own nodes — they run on the server, next to your app code
    registry.register(
      {
        type: 'Greet',
        label: 'Greet',
        category: 'my-app',
        inputSchema: { fields: [{ name: 'name', type: 'string', required: true }] },
        outputSchema: { fields: [{ name: 'hello', type: 'string' }] },
      },
      async (ctx) => ({ hello: `Hello, ${ctx.input.name}!` }),
    );
  },
});
```

Custom nodes appear in the studio's Add-node palette (fetched from the runner
over `/api/nodes` — no browser build), and the Inspector shows their source.

## Flows and scenarios are files

- Flows live in `flowsDir` as `<id>.json`.
- Scenarios ("stories") live beside them as `<id>.scenarios.json` — reviewable,
  hand-editable named inputs. The studio round-trips them: adding a scenario in
  the UI writes the sidecar; the flow file never carries a `scenarios` key.

A flow references your custom node by its `type`:

```json
{ "id": "greet", "type": "Greet", "label": "Greet", "position": {"x":300,"y":0},
  "config": {}, "inputMap": { "name": {"sourceNodeId":"in","sourceField":"name"} } }
```

## Commands

| Command | What |
|---|---|
| `emberflow dev [--port N] [--project DIR]` | runner + studio in one process, opens the browser |
| `emberflow init [--with-skills]` | scaffold config, example flow, scenario, dev script |
| `emberflow run <flow> [--scenario NAME]` | run a flow to completion against a running runner |
| `emberflow mcp` | serve the MCP tools (list/get/save/validate/run/publish workflows) |

## How execution works

Custom nodes execute **server-side** (the runner has their real
implementations via `registerNodes`), so they can touch your app's code, DB, and
services. The studio needs only their *metadata* to draw the palette/inspector,
which it fetches over HTTP — that is why the studio bundle ships prebuilt and
project-agnostic. Verified: `emberflow run greeter --scenario ada` executed the
consumer's `Greet` node and returned `{ hello: "Hello, Ada!" }`.

## Known limitations / future work

- **Browser execution mode is built-in-only.** The in-tab engine can run
  built-in nodes; consumer nodes run on the server (which is correct — they
  reach your app). This is by design.
- **A JS project runs on plain Node against the compiled `dist/`; a TS
  project runs under `tsx`.** `tsx` is now an optional peer dep rather than a
  hard runtime dependency — see the runtime-support matrix above. The package
  still ships TS source alongside `dist/` so source checkouts and TS consumers
  keep their `tsx` loop.
- **Single package.** A consumer's install currently pulls Emberflow's frontend
  toolchain (React/Vite) transitively. A future workspace split would slim the
  runtime dependency tree.
