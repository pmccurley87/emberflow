import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newer } from './agents/detect';

/**
 * Update notifier + installer plumbing for consumer projects (they install
 * @xdelivered/emberflow from npm and run `npx emberflow dev`).
 *
 * - checkForUpdate: asks the npm registry for the latest published version and
 *   compares it against the running one. Fail-SILENT by design: any network,
 *   HTTP, or parse failure returns null — an update nudge must never break or
 *   slow the studio. Results (including failures) are cached in-memory for an
 *   hour so /update-status stays cheap and the registry isn't hammered.
 * - runNpmInstall: the actual one-click updater — `npm install <pkg>@latest`
 *   spawned (no shell) in the project root. Injectable spawn for tests.
 */

export const EMBERFLOW_PACKAGE = '@xdelivered/emberflow';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000; // 5min
const OUTPUT_TAIL_BYTES = 4096;

export interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export interface CheckForUpdateOpts {
  /** Registry base URL. Defaults to EMBERFLOW_REGISTRY env, then npmjs. */
  registry?: string;
  /** Cache TTL in ms (default 1h). */
  ttlMs?: number;
  /** Injectable clock for TTL tests. */
  now?: () => number;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
}

// Single-entry cache: the runner only ever checks one package/version pair.
// Failures are cached too — a flaky network shouldn't retrigger a fetch on
// every /update-status poll.
let cache: { at: number; result: UpdateCheckResult | null } | null = null;

/** Test hook: clear the in-memory check cache. */
export function resetUpdateCheckCache(): void {
  cache = null;
}

/**
 * Latest-version check against the npm registry. Returns null when the check
 * is disabled (EMBERFLOW_UPDATE_CHECK=0) or unavailable for ANY reason —
 * never throws.
 */
export async function checkForUpdate(
  currentVersion: string,
  opts: CheckForUpdateOpts = {},
): Promise<UpdateCheckResult | null> {
  if (process.env.EMBERFLOW_UPDATE_CHECK === '0') return null;
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (cache && now() - cache.at < ttlMs) return cache.result;

  const registry = opts.registry ?? process.env.EMBERFLOW_REGISTRY ?? DEFAULT_REGISTRY;
  const fetchFn = opts.fetchFn ?? fetch;
  let result: UpdateCheckResult | null = null;
  try {
    const res = await fetchFn(`${registry}/${EMBERFLOW_PACKAGE}/latest`);
    if (res.ok) {
      const body = (await res.json()) as { version?: unknown };
      if (typeof body.version === 'string' && body.version.length > 0) {
        result = {
          current: currentVersion,
          latest: body.version,
          updateAvailable: newer(body.version, currentVersion),
        };
      }
    }
  } catch {
    result = null; // fail-silent: network error, bad JSON, anything
  }
  cache = { at: now(), result };
  return result;
}

/**
 * The running package's own version, read from its package.json. Two layouts,
 * same probe as prompt.ts's EMBERFLOW_BIN: in the source repo this file is
 * server/updateCheck.ts and the package root is one level up; in the shipped
 * package it runs from dist/server/updateCheck.js and the root is two up.
 */
export function ownVersion(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const root of [resolve(here, '..'), resolve(here, '../..')]) {
    const file = join(root, 'package.json');
    if (!existsSync(file)) continue;
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
      if (typeof pkg.version === 'string') return pkg.version;
    } catch {
      // malformed — try the next candidate
    }
  }
  return null;
}

/**
 * True when the consumer's node_modules/@xdelivered/emberflow is a symlink —
 * a `file:`/`npm link` dev setup that an npm install would clobber. POST
 * /update refuses in that case.
 */
export function isLinkedInstall(projectRoot: string): boolean {
  try {
    return lstatSync(join(projectRoot, 'node_modules', '@xdelivered', 'emberflow')).isSymbolicLink();
  } catch {
    return false;
  }
}

export type InstallResult = { ok: true } | { ok: false; error: string };

export interface RunNpmInstallOpts {
  /** Injectable spawner so tests never actually npm install. */
  spawnFn?: typeof spawn;
  /** Kill-and-fail deadline (default 5min). */
  timeoutMs?: number;
}

/**
 * Runs `npm install @xdelivered/emberflow@latest` in the project root via
 * spawn (no shell). Captures the last ~4KB of combined output; on failure
 * that tail is the error. Never rejects.
 */
export function runNpmInstall(projectRoot: string, opts: RunNpmInstallOpts = {}): Promise<InstallResult> {
  const spawnFn = opts.spawnFn ?? spawn;
  const timeoutMs = opts.timeoutMs ?? INSTALL_TIMEOUT_MS;
  return new Promise((resolveInstall) => {
    let tail = '';
    const append = (chunk: unknown): void => {
      tail = (tail + String(chunk)).slice(-OUTPUT_TAIL_BYTES);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn('npm', ['install', `${EMBERFLOW_PACKAGE}@latest`], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolveInstall({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    let settled = false;
    const settle = (result: InstallResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveInstall(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ ok: false, error: `npm install timed out after ${Math.round(timeoutMs / 1000)}s\n${tail}`.trim() });
    }, timeoutMs);
    child.on('error', (err) => settle({ ok: false, error: err.message }));
    child.on('close', (code) =>
      settle(code === 0 ? { ok: true } : { ok: false, error: tail.trim() || `npm install exited with code ${code}` }),
    );
  });
}
