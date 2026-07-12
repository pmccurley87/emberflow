# Installing Emberflow in your project

Emberflow is not yet on the npm registry — the bare `emberflow` name there is
an unrelated package, so **never `npm i emberflow`**. Until the scoped package
`@xdelivered/emberflow` is published, install straight from git or from a
packed tarball. Both are fully supported and end-to-end tested.

## Option A — git install (recommended)

```sh
# install from GitHub (runs the package's guarded `prepare` build):
npm i -D 'git+https://github.com/pmccurley87/emberflow.git'

# pin to a branch, tag, or commit:
npm i -D 'git+https://github.com/pmccurley87/emberflow.git#main'
```

npm runs the package's guarded `prepare` script on git installs: it builds the
studio and the compiled library from source, so the install takes a minute the
first time. Requirements: **Node ≥ 20** and npm ≥ 9 (npm installs the build
toolchain automatically for git dependencies).

## Option B — packed tarball

From a checkout of this repo:

```sh
npm run build:studio && npm run build:lib   # or just: npm pack (prepack builds)
npm pack                                    # → xdelivered-emberflow-0.2.0.tgz
```

Then in the consuming project:

```sh
npm i -D ../path/to/xdelivered-emberflow-0.2.0.tgz
```

Tarballs ship the prebuilt studio + compiled dist — no build on install.

## Then, in your project

```sh
npx emberflow init    # one question: JavaScript or TypeScript? (--js / --ts to skip)
```

`init` scaffolds:

- `emberflow.config.mjs` (JS, JSDoc-typed — runs on plain Node, no tsx) **or**
  `emberflow.config.ts` + `tsconfig.json` (TS — then `npm i -D tsx typescript`);
- `emberflow/apis/default/hello` — a working example HTTP operation + scenario;
- the four **agent skills** into `.claude/` / `.codex/` (repo or global scope —
  this is how your Claude Code / Codex knows how to build Emberflow APIs);
- `.gitignore` entries for the machine-local files.

Launch:

```sh
npx emberflow dev     # studio + runner at http://127.0.0.1:8092
```

First boot opens the **welcome checklist**: agent detection (with CLI
versions), environments + secrets setup, skills, the **infrastructure scout**
(reads a brownfield codebase and writes a committed, secrets-free
`emberflow/infrastructure.json` your agents build on), and your first
operation.

## What to commit vs what stays local

| Committed | Machine-local (gitignored by init) |
|---|---|
| `emberflow.config.*` | `emberflow.environments.json` (structure — safe, but per-machine) |
| `emberflow/apis/**` (operations + scenarios + mocks) | `emberflow.secrets.json` (values, `chmod 600`) |
| `emberflow/infrastructure.json` (scout manifest) | `studio-dist/`, `node_modules/` |

## Troubleshooting

- **`prepare` build fails** — Node < 20, or a proxy blocked dev-dependency
  install. Use the tarball channel instead.
- **`This project already has emberflow.config…`** on init — you're switching
  languages; port the existing config manually (init refuses to scaffold a
  dead duplicate).
- **`tsx is required`** — you chose TypeScript: `npm i -D tsx typescript`.
- Installing `emberflow` (bare name) gets you an unrelated package. Always use
  the scoped name / git URL.
