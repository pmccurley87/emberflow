// Runtime-mode decision for the Emberflow bin.
//
// The bin must decide — BEFORE loading any TypeScript — whether this invocation
// needs the tsx loader (source checkout, a `.ts` project config, or an explicit
// override) or can run on plain Node against the compiled `dist/`. A JS consumer
// with a `.mjs`/`.js` config runs entirely on `node` with NO tsx: no tsx child
// IPC, so the agent in-process CLI works inside the codex sandbox.
//
// This module is plain JS on purpose — it imports NO server/TS code, so probing
// it never triggers the tsx requirement it is trying to decide about. Everything
// here is pure and injectable (fsExists/env) so the decision matrix is unit
// testable without touching a real filesystem.

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

// Mirrors server/projectConfig.ts CONFIG_BASENAMES. Kept as a tiny local copy
// (not imported) because that module is TypeScript and pulls in server code.
const CONFIG_BASENAMES = ['emberflow.config.mjs', 'emberflow.config.js', 'emberflow.config.ts'];

/** Actionable message shown when a `.ts` config / source mode needs tsx but it
 *  isn't installed. Exported so both the bin and its tests reference one string. */
export const TSX_MISSING_MESSAGE =
  '[emberflow] This project needs tsx to run, but tsx is not installed.\n' +
  '  Either a TypeScript config (emberflow.config.ts) or source mode requires the tsx loader.\n' +
  '  Fix: install it as a dev dependency —  npm i -D tsx\n' +
  '  Or:  rename emberflow.config.ts to emberflow.config.mjs (plain JS) so Emberflow runs on plain Node.';

/** The emberflow.config.* basename present in `dir`, or undefined. Local probe
 *  of the same basenames server/projectConfig.ts#configPathFor checks. */
export function configBasenameFor(dir, fsExists = existsSync) {
  const root = resolve(dir);
  return CONFIG_BASENAMES.find((b) => fsExists(join(root, b)));
}

/** Resolve the project directory the same way the commands do, in the binding
 *  order EMBERFLOW_PROJECT → --project → cwd. Values are resolved against cwd. */
export function resolveProjectDir(argv, env, cwd) {
  const fromEnv = env.EMBERFLOW_PROJECT;
  if (fromEnv) return isAbsolute(fromEnv) ? fromEnv : resolve(cwd, fromEnv);
  const i = argv.indexOf('--project');
  if (i !== -1 && argv[i + 1]) return resolve(cwd, argv[i + 1]);
  return cwd;
}

/**
 * Decide how to run.
 *
 * @param packageRoot absolute path to the package root (dir above bin/).
 * @param projectDir  resolved project dir (see resolveProjectDir).
 * @param env         process.env-shaped object.
 * @param fsExists    existsSync-shaped probe (injectable for tests).
 *
 * Returns:
 *   needsTsx    – register tsx and spawn the runner under tsx.
 *   runnerMode  – 'node' (spawn `node dist/server/*.js`) or 'tsx' (spawn tsx source).
 *   useDist     – import the compiled `dist/bin/commands.js` rather than source.
 *   sourceMode  – repo checkout (dev loop) rather than an installed package.
 *   configBasename / reason – for the EMBERFLOW_DEBUG_RUNTIME trace.
 */
export function decideRuntime({ packageRoot, projectDir, env = {}, fsExists = existsSync }) {
  const hasDist = fsExists(join(packageRoot, 'dist'));
  const hasSrc = fsExists(join(packageRoot, 'src'));
  const underNodeModules = packageRoot.split(sep).includes('node_modules');

  // source-mode = repo checkout, where we always run the TypeScript sources under
  // tsx (the dev loop). `dist/` may EXIST in the repo after `build:lib`, so its
  // presence can't be the signal. Heuristic: src/ exists AND we're not installed
  // under node_modules. EMBERFLOW_SOURCE is an explicit escape hatch either way.
  let sourceMode;
  if (env.EMBERFLOW_SOURCE === '1') sourceMode = true;
  else if (env.EMBERFLOW_SOURCE === '0') sourceMode = false;
  else sourceMode = hasSrc && !underNodeModules;

  const configBasename = configBasenameFor(projectDir, fsExists);
  const tsConfig = configBasename?.endsWith('.ts') ?? false;
  const forced = env.EMBERFLOW_FORCE_TSX === '1';

  // Import compiled commands only when we have a dist AND we're not in the source
  // dev loop. Otherwise fall back to the TypeScript source (which requires tsx —
  // and needsTsx is already true whenever sourceMode is).
  const useDist = hasDist && !sourceMode;

  // INVARIANT: importing TypeScript source requires tsx. When there is no dist
  // to fall back on (`!useDist`), the launcher will import ./commands.ts, so tsx
  // is required even if nothing else demanded it — otherwise plain node dies
  // with a cryptic ERR_UNKNOWN_FILE_EXTENSION instead of TSX_MISSING_MESSAGE.
  const needsTsx = sourceMode || forced || tsConfig || !useDist;

  // A node-mode runner needs the compiled server; if there's no dist we can't run
  // plain node, so fall back to tsx even when nothing else demanded it.
  const runnerMode = !needsTsx && hasDist ? 'node' : 'tsx';

  const reason = sourceMode
    ? 'source-mode (repo checkout)'
    : forced
      ? 'EMBERFLOW_FORCE_TSX=1'
      : tsConfig
        ? `ts-config (${configBasename})`
        : runnerMode === 'node'
          ? 'js-consumer (plain node)'
          : 'no-dist fallback';

  return { needsTsx, runnerMode, useDist, sourceMode, hasDist, configBasename, reason };
}
