# JavaScript-driven vs TypeScript-driven runners — design

Date: 2026-07-12
Status: proposed, pending user review.

## Goal

A consumer chooses their project language BEFORE creating APIs — JavaScript or
TypeScript — and everything downstream honours the choice: what `init`
scaffolds, what language nodes are authored in (by humans and by agents), and
what the runtime needs installed. A pure-JS project must run on plain Node
with no TypeScript toolchain; a TS project gets typed node authoring with
tsx-based loading exactly as today.

## Current state (why this needs work)

- `bin/emberflow.mjs` registers `tsx/esm/api` unconditionally — every command,
  every consumer, pays for tsx even when nothing is TypeScript.
- `package.json#exports` ships RAW `.ts` sources (`"." → ./src/config.ts`,
  `"./engine" → ./src/engine/index.ts`) — a JS consumer cannot even
  `import { defineConfig } from 'emberflow'` without tsx in the loader chain.
- The runner is spawned as `npx tsx server/index.ts` (`bin/commands.ts:59`).
- `emberflow.config.(mjs|js|ts)` is already extension-flexible
  (`server/projectConfig.ts:14`) — the config LOADING side is fine.
- `init` scaffolds `.mjs` config only; no language question; skills and agent
  prompts say "emberflow.config.(mjs|js|ts)" but author examples untyped.

## Design

### D1. The package builds to JS; tsx becomes conditional (the enabler)

Ship compiled output. `tsc` emits `dist/` (JS + `.d.ts`) for `src/` and
`server/`; `exports` points at `dist/` (types + import conditions). The bin
becomes a thin plain-Node launcher:

```
bin/emberflow.mjs:
  needsTsx = project config is .ts OR nodes modules are .ts (cheap check:
             configPathFor extension, plus an explicit override flag)
  if (needsTsx) { try { register tsx } catch { fail with "install tsx or
             typescript-less mode" guidance } }
  import('../dist/bin/commands.js')
```

- Runner spawn: `node dist/server/index.js` for JS projects;
  `npx tsx server-entry` only when `needsTsx` (or in the Emberflow repo
  itself, which stays source-run for development).
- `tsx` moves from `dependencies` to `peerDependencies` (optional) +
  `devDependencies`. JS consumers never install it.
- The repo's own dev loop (`npm run server`, vitest) is unchanged — source
  under tsx as today. `prepack` gains `tsc -b` so tarballs carry `dist/`.

### D2. Language is a project-level choice, recorded in config

`defineConfig` gains an optional, purely-declarative field:

```js
export default defineConfig({
  language: 'javascript' | 'typescript',   // default: inferred from config ext
  ...
})
```

Inference fallback: `.ts` config → typescript; `.mjs`/`.js` → javascript.
The field exists so agents and skills can read ONE authoritative signal
instead of sniffing extensions.

**Deferred:** `language: 'typescript'` with an `.mjs`/`.js` config (stray
`.ts` node modules in an otherwise-JS project) is NOT wired — the runtime
decision (`bin/runtime.mjs`) only reads the config file's own extension, not
the declared `language:` field, so this combination currently runs on plain
node. Workaround: `EMBERFLOW_FORCE_TSX=1` forces the tsx loader. `doctor`'s
language-drift check flags the mismatch so it doesn't fail silently.

### D3. `init` asks — once, up front

New interactive prompt (same pattern as the existing skills-scope prompt;
non-TTY default + flags `--ts` / `--js` to skip):

> "Author your APIs in [j]avascript or [t]ypescript? [j]"

- **javascript** → scaffolds `emberflow.config.mjs` with JSDoc-typed
  `registerNodes` (`/** @param {import('emberflow').NodeRegistry} registry */`)
  so editors still get IntelliSense from the shipped `.d.ts`.
- **typescript** → scaffolds `emberflow.config.ts` (typed imports), plus a
  minimal `tsconfig.json` if the project has none, and installs `tsx` as a
  devDependency if absent (or prints the command).
- `create-emberflow` forwards `--ts`/`--js`.
- The choice also stamps `language:` explicitly in the scaffolded config.

### D4. Agents and skills honour the language

- Agent preamble (`server/agents/prompt.ts`): one line — "This project is
  <language>-driven (from emberflow.config): author nodes and any modules in
  that language; do not introduce TypeScript files into a JavaScript project
  or vice versa." Language is read from the loaded project config and
  injected into `buildPrompt`.
- Skills (`emberflow-basics` config section): show both scaffold shapes (the
  JSDoc-typed .mjs and the typed .ts), state the rule that the project's
  configured language governs, note `language:` as the authoritative signal.
- `doctor`: advisory `language-drift` check — a `.ts` nodes module in a
  `language: 'javascript'` project (or config/nodes extension disagreeing
  with `language:`) gets a warning naming the file.

### D5. Runtime support matrix (the contract)

| | JS project | TS project |
|---|---|---|
| config | `.mjs`/`.js` (JSDoc types optional) | `.ts` (typed) |
| node modules | plain ESM JS | TS, loaded via tsx |
| runtime deps | `emberflow` only (plain Node ≥20) | `emberflow` + `tsx` |
| runner spawn | `node dist/server/index.js` | tsx-registered entry |
| typecheck | none required | consumer's own `tsc` (init's tsconfig) |
| agents author | `.mjs`/JSDoc | `.ts`/typed |

## Alternatives considered

- **Keep tsx for everyone (status quo), just scaffold .mjs vs .ts** — smallest
  change, but JS users still install the TS toolchain and the "JS-driven
  runner" is cosmetic. Rejected: doesn't deliver the runtime half of the ask.
- **Dual package (emberflow + emberflow-ts)** — heavier maintenance, confusing
  install story. Rejected.
- **Bundle (esbuild single-file dist)** — faster cold start, but obscures
  stack traces into node code users read from the Inspector; tsc emit keeps
  file structure 1:1. Rejected for now (revisit if startup matters).

## Risks / open points

- `exports` flip from `.ts` to `dist/` is a breaking change for anything
  importing deep paths (`emberflow/server/...` — the sample e2e did this once
  for the env loader); mitigate with an explicit `./server/environments`
  export if needed.
- The repo itself must keep running from source (dev loop, vitest, agent
  in-process CLI) — the bin needs a "source mode" branch when running inside
  the Emberflow repo (detect: `dist/` absent + `src/` present → tsx).
- pg/dotenv-style optional deps unaffected; studio-dist unchanged.
- Agent sandbox (codex) blocked tsx child IPC before — plain-node dist paths
  actually IMPROVE that story for JS projects.

## Out of scope

- Deno/Bun runtimes; CJS consumers (package stays ESM).
- Rewriting existing example projects (the repo stays a TS project).

## Plan skeleton (tasks, if approved)

1. `tsc` build config for `src/` + `server/` → `dist/` (+ d.ts), prepack wires
   it, exports flip with compatibility subpath for the env loader; smoke
   still green.
2. Conditional-tsx bin + `node dist` runner spawn + repo source-mode branch;
   `tsx` → peer/optional. Smoke matrix: JS-only temp project (no tsx
   installed!) and TS temp project.
3. `language:` config field + inference + `init` prompt/flags + scaffolds
   (JSDoc mjs / typed ts + tsconfig) + create-emberflow passthrough.
4. Agent preamble language line + skills update + doctor `language-drift`.
5. E2E: extend smoke-install to run BOTH language matrices; update the
   consuming-emberflow doc.
