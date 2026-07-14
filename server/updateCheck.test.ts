import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkForUpdate,
  isLinkedInstall,
  ownVersion,
  resetUpdateCheckCache,
  runNpmInstall,
  type InstallResult,
} from './updateCheck';

/** A fetch stub returning a registry-shaped `{ version }` body. */
function fetchReturning(version: string, ok = true): typeof fetch {
  return vi.fn(async () => ({ ok, json: async () => ({ version }) })) as unknown as typeof fetch;
}

describe('checkForUpdate', () => {
  beforeEach(() => resetUpdateCheckCache());
  afterEach(() => {
    delete process.env.EMBERFLOW_UPDATE_CHECK;
    delete process.env.EMBERFLOW_REGISTRY;
  });

  it('reports updateAvailable when the registry version is newer', async () => {
    const result = await checkForUpdate('0.3.0', { fetchFn: fetchReturning('0.4.0') });
    expect(result).toEqual({ current: '0.3.0', latest: '0.4.0', updateAvailable: true });
  });

  it('reports no update when versions are equal', async () => {
    const result = await checkForUpdate('0.3.0', { fetchFn: fetchReturning('0.3.0') });
    expect(result).toEqual({ current: '0.3.0', latest: '0.3.0', updateAvailable: false });
  });

  it('reports no update when the registry version is OLDER (local ahead of npm)', async () => {
    const result = await checkForUpdate('0.10.0', { fetchFn: fetchReturning('0.9.9') });
    expect(result?.updateAvailable).toBe(false);
  });

  it('compares numerically, not lexically (0.10.0 beats 0.9.0)', async () => {
    const result = await checkForUpdate('0.9.0', { fetchFn: fetchReturning('0.10.0') });
    expect(result?.updateAvailable).toBe(true);
  });

  it('returns null on fetch rejection (fail-silent)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ENETDOWN');
    }) as unknown as typeof fetch;
    await expect(checkForUpdate('0.3.0', { fetchFn })).resolves.toBeNull();
  });

  it('returns null on a non-ok response (404 pre-publish)', async () => {
    await expect(checkForUpdate('0.3.0', { fetchFn: fetchReturning('irrelevant', false) })).resolves.toBeNull();
  });

  it('returns null on malformed json / missing version', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ nope: true }),
    })) as unknown as typeof fetch;
    await expect(checkForUpdate('0.3.0', { fetchFn })).resolves.toBeNull();
    resetUpdateCheckCache();
    const throwsOnJson = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error('bad json');
      },
    })) as unknown as typeof fetch;
    await expect(checkForUpdate('0.3.0', { fetchFn: throwsOnJson })).resolves.toBeNull();
  });

  it('caches within the TTL and refetches after it expires', async () => {
    let clock = 1_000;
    const fetchFn = fetchReturning('0.4.0');
    const opts = { fetchFn, ttlMs: 60_000, now: () => clock };

    expect(await checkForUpdate('0.3.0', opts)).toMatchObject({ latest: '0.4.0' });
    clock += 30_000; // inside TTL — served from cache
    expect(await checkForUpdate('0.3.0', opts)).toMatchObject({ latest: '0.4.0' });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    clock += 60_001; // past TTL — hits the registry again
    await checkForUpdate('0.3.0', opts);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('caches failures too (no registry hammering while offline)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await checkForUpdate('0.3.0', { fetchFn });
    await checkForUpdate('0.3.0', { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('is disabled entirely by EMBERFLOW_UPDATE_CHECK=0', async () => {
    process.env.EMBERFLOW_UPDATE_CHECK = '0';
    const fetchFn = fetchReturning('9.9.9');
    await expect(checkForUpdate('0.3.0', { fetchFn })).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('honors the EMBERFLOW_REGISTRY override', async () => {
    process.env.EMBERFLOW_REGISTRY = 'http://127.0.0.1:9999';
    const fetchFn = fetchReturning('0.4.0');
    await checkForUpdate('0.3.0', { fetchFn });
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:9999/@xdelivered/emberflow/latest');
  });
});

describe('ownVersion', () => {
  it('resolves this package version from package.json (source layout)', () => {
    // Running from the source repo: server/updateCheck.ts → root is one up.
    expect(ownVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

/** Minimal spawn-shaped fake: emits like a ChildProcess, never runs npm. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('runNpmInstall', () => {
  it('spawns npm install <pkg>@latest in the project root, no shell', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const done = runNpmInstall('/proj', { spawnFn: spawnFn as never });
    expect(spawnFn).toHaveBeenCalledWith('npm', ['install', '@xdelivered/emberflow@latest'], {
      cwd: '/proj',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.emit('close', 0);
    await expect(done).resolves.toEqual({ ok: true });
  });

  it('fails with the output tail on a nonzero exit', async () => {
    const child = fakeChild();
    const done = runNpmInstall('/proj', { spawnFn: (() => child) as never });
    child.stderr.emit('data', 'npm ERR! code E403\n');
    child.stderr.emit('data', 'npm ERR! forbidden\n');
    child.emit('close', 1);
    const result = (await done) as InstallResult & { ok: false };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('E403');
    expect(result.error).toContain('forbidden');
  });

  it('keeps only the last ~4KB of output in the error tail', async () => {
    const child = fakeChild();
    const done = runNpmInstall('/proj', { spawnFn: (() => child) as never });
    child.stdout.emit('data', 'EARLY-MARKER ' + 'x'.repeat(8000));
    child.stderr.emit('data', ' LATE-MARKER');
    child.emit('close', 1);
    const result = (await done) as InstallResult & { ok: false };
    expect(result.error).toContain('LATE-MARKER');
    expect(result.error).not.toContain('EARLY-MARKER');
    expect(result.error.length).toBeLessThanOrEqual(4096);
  });

  it('fails on a spawn error event (npm missing) without rejecting', async () => {
    const child = fakeChild();
    const done = runNpmInstall('/proj', { spawnFn: (() => child) as never });
    child.emit('error', new Error('spawn npm ENOENT'));
    await expect(done).resolves.toEqual({ ok: false, error: 'spawn npm ENOENT' });
  });

  it('kills and fails after the timeout', async () => {
    const child = fakeChild();
    const done = runNpmInstall('/proj', { spawnFn: (() => child) as never, timeoutMs: 10 });
    const result = await done; // child never closes — the timer settles it
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('timed out');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('isLinkedInstall', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ef-update-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('is false when the package is not installed at all', () => {
    expect(isLinkedInstall(root)).toBe(false);
  });

  it('is false for a real directory install', () => {
    mkdirSync(join(root, 'node_modules', '@xdelivered', 'emberflow'), { recursive: true });
    expect(isLinkedInstall(root)).toBe(false);
  });

  it('is true for a symlinked (file:/npm link) install', () => {
    mkdirSync(join(root, 'node_modules', '@xdelivered'), { recursive: true });
    mkdirSync(join(root, 'real-checkout'));
    symlinkSync(join(root, 'real-checkout'), join(root, 'node_modules', '@xdelivered', 'emberflow'));
    expect(isLinkedInstall(root)).toBe(true);
  });
});
