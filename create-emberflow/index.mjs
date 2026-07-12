#!/usr/bin/env node
// create-emberflow — `npm create emberflow@latest` entry point.
// Ensures `emberflow` is installed in the cwd, then runs `emberflow init`, which
// scaffolds, installs skills, and launches the studio itself — no separate `dev` call.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();
const binExt = process.platform === 'win32' ? '.cmd' : '';
const localBin = join(cwd, 'node_modules', '.bin', `emberflow${binExt}`);

console.log('[create-emberflow] scaffolding and launching an Emberflow project...');

if (!existsSync(localBin)) {
  const install = spawnSync('npm', ['i', '-D', '@xdelivered/emberflow'], { cwd, stdio: 'inherit' });
  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }
}

function runEmberflow(args) {
  const result = existsSync(localBin)
    ? spawnSync(localBin, args, { cwd, stdio: 'inherit' })
    : spawnSync('npx', ['@xdelivered/emberflow', ...args], { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Forward the language choice flags straight through to `emberflow init`.
const languageFlags = process.argv.slice(2).filter((a) => a === '--js' || a === '--ts');

runEmberflow(['init', ...languageFlags]);
