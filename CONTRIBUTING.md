# Contributing to Emberflow

This is the guide for working **on** Emberflow itself. If you just want to *use*
Emberflow in your project, see [README.md](README.md).

## Dev loop

Emberflow is a Vite/React studio (`src/`) plus an Express runner (`server/`),
with the CLI in `bin/` and the engine in `src/engine/`.

```sh
npm install          # fast — `prepare` skips the build when dist/ is present
npm run server       # runner (Express) with hot reload — tsx watch
npm run dev          # studio (Vite) with HMR, proxies to the runner
```

Open the Vite URL; the studio talks to the runner over HTTP. Use
`npm run dev:project` to point the runner at `examples/demo-project`.

## Gates

Run these before pushing:

```sh
npm run typecheck    # tsc -b + server tsconfig
npx vitest run       # unit + integration tests
npm run smoke        # packs a tarball, installs it into throwaway JS + TS
                     # projects, runs init/test/doctor, boots dev, hits healthz
npm run lint         # oxlint
```

`npm run smoke` is the highest-signal gate — it exercises `files` / `bin` /
`exports` / shebangs exactly as a consumer's `npm install` does, across both the
JS (plain Node) and TS (`tsx`) runtimes. Run it before any release.

## Build & packaging

```sh
npm run build:studio # vite build → studio-dist/
npm run build:lib    # tsc -p tsconfig.build.json + fix-dist-imports → dist/
npm pack             # prepack runs both builds, then tarballs
npm publish --dry-run  # inspect the file list before a real publish
```

- `prepack` builds `studio-dist/` + `dist/` when creating a tarball.
- `prepare` (`scripts/prepare-if-source.mjs`) covers **git installs** only: it
  builds from source when `dist/`/`studio-dist/` are missing and the toolchain
  is available, and exits silently otherwise — so the repo's own `npm install`
  and tarball/registry consumers never rebuild.
- The published surface is the `files` allow-list in `package.json`. Source
  ships alongside `dist/` so TS consumers keep a `tsx` loop; `tsconfig.build.json`
  excludes tests and `__fixtures__` from the emitted `dist/`.

## Releasing

1. Bump `version` in `package.json` **and** `create-emberflow/package.json`.
2. Green: `typecheck`, `vitest run`, `smoke` (both variants).
3. `npm publish --dry-run` — confirm the file list and size are sane.
4. Publish (registry publish itself is a manual, deliberate step).
</content>
