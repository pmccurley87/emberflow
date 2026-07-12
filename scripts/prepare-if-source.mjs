// Guarded `prepare` for git installs.
//
// npm runs `prepare` (not `prepack`) when a dependency is installed straight
// from a git URL — `npm i github:owner/repo` / `npm i git+file://…`. A git
// checkout ships the SOURCE but not the build outputs (`dist/`, `studio-dist/`
// are git-ignored), so without a build step the install is broken: the exports
// map points at `dist/**` files that do not exist and the studio has no bundle.
//
// This script bridges that gap WITHOUT slowing the two paths that must stay
// fast:
//   • The repo's own `npm install` — `dist/` + `studio-dist/` already present,
//     so we exit 0 immediately (no rebuild on every dev install).
//   • A consumer installing the published package / a tarball — npm does NOT
//     run `prepare` for those at all, and the tarball already contains the
//     build outputs anyway. The dist-present check is belt-and-braces.
//
// We build only when ALL of these hold:
//   • `src/` exists (this is a real source tree, not a stripped install), AND
//   • `dist/` OR `studio-dist/` is missing (something actually needs building),
//     AND
//   • the build toolchain is resolvable (vite + typescript on disk — npm
//     installs devDependencies before preparing a git dep, so this normally
//     holds; if it does not we cannot build and must say so clearly rather
//     than emit a half-broken install).
//
// Anything short of "needs building AND can build" exits 0 silently.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const has = (p) => existsSync(join(root, p));

// Not a source tree (should never happen — src ships in the tarball too, but a
// stripped/pruned install might drop it). Nothing to build from.
if (!has('src')) process.exit(0);

// Build outputs already present → repo dev install or tarball. Nothing to do.
if (has('dist') && has('studio-dist')) process.exit(0);

// Something needs building. Confirm the toolchain is here before we try.
const require = createRequire(join(root, 'package.json'));
const buildable = ['vite', 'typescript'].every((pkg) => {
  try {
    require.resolve(pkg);
    return true;
  } catch {
    return false;
  }
});

if (!buildable) {
  console.error(
    '\n[emberflow] Cannot build from source: the build toolchain (vite + ' +
      'typescript) is not installed, so `dist/` and `studio-dist/` cannot be ' +
      'produced.\n' +
      '[emberflow] Install Emberflow from the npm registry or a packed ' +
      'tarball (both ship the prebuilt outputs) instead of a bare git/source ' +
      'checkout without dev dependencies.\n',
  );
  process.exit(1);
}

console.error('[emberflow] git/source install: building studio-dist + dist…');
const run = (args) => {
  const r = spawnSync('npm', args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run(['run', 'build:studio']);
run(['run', 'build:lib']);
