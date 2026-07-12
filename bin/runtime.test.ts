import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  configBasenameFor,
  decideRuntime,
  resolveProjectDir,
  TSX_MISSING_MESSAGE,
} from './runtime.mjs';

// A fake filesystem: `decideRuntime`/`configBasenameFor` take an injectable
// `fsExists`, so the whole decision matrix runs without touching disk.
function fsWith(paths: string[]) {
  const set = new Set(paths);
  return (p: import('node:fs').PathLike) => set.has(String(p));
}

// An installed JS consumer: package under node_modules, dist present, no src.
const CONSUMER_ROOT = '/app/node_modules/emberflow';
const PROJECT = '/app';

function consumerFs(configBasename?: string) {
  const paths = [join(CONSUMER_ROOT, 'dist')];
  if (configBasename) paths.push(join(PROJECT, configBasename));
  return fsWith(paths);
}

describe('configBasenameFor', () => {
  it('finds .mjs before .ts', () => {
    const fsExists = fsWith([join(PROJECT, 'emberflow.config.mjs')]);
    expect(configBasenameFor(PROJECT, fsExists)).toBe('emberflow.config.mjs');
  });
  it('finds a .ts config', () => {
    const fsExists = fsWith([join(PROJECT, 'emberflow.config.ts')]);
    expect(configBasenameFor(PROJECT, fsExists)).toBe('emberflow.config.ts');
  });
  it('returns undefined when no config exists', () => {
    expect(configBasenameFor(PROJECT, () => false)).toBeUndefined();
  });
});

describe('resolveProjectDir', () => {
  it('prefers EMBERFLOW_PROJECT (absolute) over --project and cwd', () => {
    expect(
      resolveProjectDir(['--project', './other'], { EMBERFLOW_PROJECT: '/env/proj' }, '/cwd')
    ).toBe('/env/proj');
  });
  it('resolves a relative EMBERFLOW_PROJECT against cwd', () => {
    expect(resolveProjectDir([], { EMBERFLOW_PROJECT: 'proj' }, '/cwd')).toBe('/cwd/proj');
  });
  it('falls back to --project when no env var', () => {
    expect(resolveProjectDir(['--project', 'p'], {}, '/cwd')).toBe('/cwd/p');
  });
  it('falls back to cwd when neither is set', () => {
    expect(resolveProjectDir([], {}, '/cwd')).toBe('/cwd');
  });
});

describe('decideRuntime — JS consumer (installed under node_modules, dist present)', () => {
  it('.mjs config → plain node, use dist, no tsx', () => {
    const d = decideRuntime({
      packageRoot: CONSUMER_ROOT,
      projectDir: PROJECT,
      env: {},
      fsExists: consumerFs('emberflow.config.mjs'),
    });
    expect(d).toMatchObject({ needsTsx: false, runnerMode: 'node', useDist: true, sourceMode: false });
  });

  it('no config → still plain node + dist (e.g. `init`)', () => {
    const d = decideRuntime({
      packageRoot: CONSUMER_ROOT,
      projectDir: PROJECT,
      env: {},
      fsExists: consumerFs(),
    });
    expect(d).toMatchObject({ needsTsx: false, runnerMode: 'node', useDist: true });
  });

  it('.ts config → needs tsx, still imports dist commands', () => {
    const d = decideRuntime({
      packageRoot: CONSUMER_ROOT,
      projectDir: PROJECT,
      env: {},
      fsExists: consumerFs('emberflow.config.ts'),
    });
    expect(d).toMatchObject({ needsTsx: true, runnerMode: 'tsx', useDist: true });
  });

  it('EMBERFLOW_FORCE_TSX=1 forces tsx even with a .mjs config', () => {
    const d = decideRuntime({
      packageRoot: CONSUMER_ROOT,
      projectDir: PROJECT,
      env: { EMBERFLOW_FORCE_TSX: '1' },
      fsExists: consumerFs('emberflow.config.mjs'),
    });
    expect(d).toMatchObject({ needsTsx: true, runnerMode: 'tsx' });
  });

  it('no dist installed → falls back to tsx AND requires it (importing .ts source without tsx would die with ERR_UNKNOWN_FILE_EXTENSION)', () => {
    const d = decideRuntime({
      packageRoot: CONSUMER_ROOT,
      projectDir: PROJECT,
      env: {},
      fsExists: fsWith([join(PROJECT, 'emberflow.config.mjs')]), // no dist
    });
    expect(d).toMatchObject({ needsTsx: true, runnerMode: 'tsx', useDist: false });
  });
});

describe('decideRuntime — source checkout (repo dev loop)', () => {
  const REPO_ROOT = '/work/emberflow';
  // src/ present, NOT under node_modules — the checkout signal. dist/ may or may
  // not exist (after build:lib); source-mode must ignore it.
  function repoFs(withDist: boolean, configBasename?: string) {
    const paths = [join(REPO_ROOT, 'src')];
    if (withDist) paths.push(join(REPO_ROOT, 'dist'));
    if (configBasename) paths.push(join(PROJECT, configBasename));
    return fsWith(paths);
  }

  it('always tsx + source commands, even with a .mjs project config', () => {
    const d = decideRuntime({
      packageRoot: REPO_ROOT,
      projectDir: PROJECT,
      env: {},
      fsExists: repoFs(false, 'emberflow.config.mjs'),
    });
    expect(d).toMatchObject({ needsTsx: true, runnerMode: 'tsx', useDist: false, sourceMode: true });
  });

  it('dist present in the repo does NOT switch to node/dist', () => {
    const d = decideRuntime({
      packageRoot: REPO_ROOT,
      projectDir: PROJECT,
      env: {},
      fsExists: repoFs(true, 'emberflow.config.mjs'),
    });
    expect(d).toMatchObject({ sourceMode: true, useDist: false, needsTsx: true });
  });

  it('EMBERFLOW_SOURCE=0 escape hatch opts a checkout out of source mode', () => {
    const d = decideRuntime({
      packageRoot: REPO_ROOT,
      projectDir: PROJECT,
      env: { EMBERFLOW_SOURCE: '0' },
      fsExists: repoFs(true, 'emberflow.config.mjs'),
    });
    expect(d).toMatchObject({ sourceMode: false, runnerMode: 'node', useDist: true });
  });

  it('EMBERFLOW_SOURCE=1 forces source mode for an installed package', () => {
    const d = decideRuntime({
      packageRoot: CONSUMER_ROOT,
      projectDir: PROJECT,
      env: { EMBERFLOW_SOURCE: '1' },
      fsExists: consumerFs('emberflow.config.mjs'),
    });
    expect(d).toMatchObject({ sourceMode: true, needsTsx: true, useDist: false });
  });
});

describe('TSX_MISSING_MESSAGE', () => {
  it('is actionable: names the install command and the JS-config alternative', () => {
    expect(TSX_MISSING_MESSAGE).toContain('npm i -D tsx');
    expect(TSX_MISSING_MESSAGE).toMatch(/emberflow\.config\.mjs/);
  });
});
