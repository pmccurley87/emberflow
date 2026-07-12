#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { decideRuntime, resolveProjectDir, TSX_MISSING_MESSAGE } from './runtime.mjs';

// Decide the runtime BEFORE importing anything TypeScript: a JS consumer runs on
// plain Node (no tsx), a source checkout / `.ts` config runs under tsx.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const projectDir = resolveProjectDir(argv, process.env, process.cwd());
const decision = decideRuntime({ packageRoot, projectDir, env: process.env });

if (process.env.EMBERFLOW_DEBUG_RUNTIME) {
  console.error(`[emberflow] runtime ${JSON.stringify(decision)}`);
}

if (decision.needsTsx) {
  try {
    const { register } = await import('tsx/esm/api');
    register();
  } catch {
    console.error(TSX_MISSING_MESSAGE);
    process.exit(1);
  }
}

// Compiled commands for JS consumers (plain node); TypeScript source under tsx
// for the repo dev loop. The dynamic specifier is a string literal in each
// branch so Node's ESM loader resolves it directly.
const { parseArgs, runCommand } = decision.useDist
  ? await import('../dist/bin/commands.js')
  : await import('./commands.ts');

const code = await runCommand(parseArgs(argv), {
  runnerMode: decision.runnerMode,
  packageRoot,
});
process.exit(code);
