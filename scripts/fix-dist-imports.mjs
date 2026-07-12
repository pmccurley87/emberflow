// Post-emit fixer for `build:lib`.
//
// The Emberflow source is written with extensionless relative imports
// (`export * from './engine'`, `import { x } from '../server/projectConfig'`).
// That is fine for the repo's own dev loop, which runs the TypeScript sources
// directly under tsx/vite/vitest — both tolerate extensionless and directory
// specifiers. But a *published* dist has to run on plain Node's ESM loader,
// which requires fully specified paths: no extension search and no directory
// `index` resolution. `tsc` never adds extensions to emitted imports, and
// `rewriteRelativeImportExtensions` only rewrites explicit `.ts` -> `.js`, so
// neither helps here. CommonJS emit is not an option either: the codebase uses
// `import.meta.url`, which TypeScript leaves verbatim and Node rejects in CJS.
//
// So we emit ESM (module: esnext) and rewrite the emitted `.js`/`.d.ts`
// specifiers here: append `.js` when `<spec>.js` exists on disk, or
// `/index.js` when `<spec>/index.js` exists. This touches only the compiled
// dist artifact; no source file changes and the dev loop is untouched.

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist');

// Matches the specifier in: `from '...'`, `import '...'`, and `import('...')`.
// The leading (?<!\.) guard keeps `foo.import(...)` member calls from matching.
const SPECIFIER = /(\bfrom\s*|(?<!\.)\bimport\s*|\bimport\()\s*(['"])(\.\.?\/[^'"]*?)\2/g;

function fixFile(file) {
  const dir = dirname(file);
  const original = readFileSync(file, 'utf8');
  let changed = false;

  const updated = original.replace(SPECIFIER, (match, prefix, quote, spec) => {
    if (/\.(js|mjs|cjs|json)$/.test(spec)) return match; // already specified
    const base = resolve(dir, spec);
    let next;
    if (existsSync(`${base}.js`)) {
      next = `${spec}.js`;
    } else if (existsSync(join(base, 'index.js'))) {
      next = `${spec.replace(/\/$/, '')}/index.js`;
    } else {
      return match; // leave anything we can't resolve (e.g. bare packages)
    }
    changed = true;
    return `${prefix}${quote}${next}${quote}`;
  });

  if (changed) writeFileSync(file, updated);
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.js$/.test(entry) || /\.d\.ts$/.test(entry)) fixFile(full);
  }
}

if (!existsSync(root)) {
  console.error(`fix-dist-imports: ${root} does not exist — run tsc first`);
  process.exit(1);
}
walk(root);
