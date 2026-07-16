import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Spy on spawn so runDev/runServe/launchServer never actually spawn a child
// process during these tests — we only care about what commands.ts decided
// to launch (or not).
const spawnCalls: Array<{ cmd: string; args: string[]; env: Record<string, string | undefined> }> = [];
vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[], opts: { env: Record<string, string | undefined> }) => {
    spawnCalls.push({ cmd, args, env: opts.env });
    const listeners: Record<string, ((code: number) => void)[]> = {};
    queueMicrotask(() => listeners.exit?.forEach((cb) => cb(0)));
    return { on: (event: string, cb: (code: number) => void) => {
      (listeners[event] ??= []).push(cb);
    } };
  },
}));

const { parseArgs, runCommand } = await import('./commands');

describe('parseArgs', () => {
  it('parses dev with flags', () => {
    expect(parseArgs(['dev', '--port', '9000', '--project', './x'])).toEqual({
      command: 'dev', port: 9000, project: './x', scenario: undefined, rest: [],
    });
  });
  it('defaults to help when no command', () => {
    expect(parseArgs([]).command).toBe('help');
  });
  it('parses run with a flow and scenario', () => {
    const p = parseArgs(['run', 'order-triage', '--scenario', 'vip']);
    expect(p.command).toBe('run');
    expect(p.rest).toEqual(['order-triage']);
    expect(p.scenario).toBe('vip');
  });
  it('parses init with --no-skills', () => {
    const p = parseArgs(['init', '--no-skills']);
    expect(p.command).toBe('init');
    expect(p.noSkills).toBe(true);
  });
  it('defaults noSkills to undefined when absent', () => {
    expect(parseArgs(['init']).noSkills).toBeUndefined();
  });
  it('parses --global as scope global', () => {
    expect(parseArgs(['init', '--global']).scope).toBe('global');
  });
  it('parses --local as scope repo', () => {
    expect(parseArgs(['init', '--local']).scope).toBe('repo');
  });
  it('parses --no-launch', () => {
    expect(parseArgs(['init', '--no-launch']).noLaunch).toBe(true);
  });
  it('parses the serve command with flags', () => {
    expect(parseArgs(['serve', '--port', '9001', '--project', './p'])).toEqual({
      command: 'serve', port: 9001, project: './p', scenario: undefined, rest: [],
    });
  });
  it('parses --js', () => {
    expect(parseArgs(['init', '--js']).js).toBe(true);
  });
  it('parses --ts', () => {
    expect(parseArgs(['init', '--ts']).ts).toBe(true);
  });
});

describe('runCommand init --js/--ts', () => {
  it('errors when both --js and --ts are passed', async () => {
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const code = await runCommand(parseArgs(['init', '--js', '--ts', '--no-skills', '--no-launch']));
      expect(code).toBe(1);
      expect(errors.join(' ')).toContain('mutually exclusive');
    } finally {
      console.error = origError;
    }
  });
});

// Repo root — a nested scratch dir here still resolves `tsx` by walking up to
// this repo's own node_modules, which is what a "tsx IS resolvable" fixture
// needs without faking a whole install.
const REPO_ROOT = process.cwd();

function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  return fn().finally(() => process.chdir(prev));
}

function silenceLog<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.log;
  console.log = () => {};
  return fn().finally(() => { console.log = orig; });
}

describe('runCommand init --ts auto-launch (stale vs fresh runtime decision)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    spawnCalls.length = 0;
  });

  it('skips the launch and prints guidance when tsx is not resolvable from the project', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ef-cmd-notsx-'));
    dirs.push(d);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const code = await withCwd(d, () => runCommand(parseArgs(['init', '--ts', '--no-skills', '--yes'])));
      expect(code).toBe(0);
      expect(spawnCalls).toEqual([]); // no launch attempt at all
      const out = logs.join('\n');
      expect(out).toContain('npm i -D tsx typescript');
      expect(out).toContain('npx emberflow dev');
    } finally {
      console.log = origLog;
    }
  });

  it('re-decides the runtime against the scaffolded project when tsx IS resolvable, instead of trusting the stale bin-startup context', async () => {
    // A "consumer install" context decided BEFORE scaffolding: dist/ present,
    // no src/, decided runnerMode 'node' (no config existed yet at bin startup).
    const consumerRoot = mkdtempSync(join(tmpdir(), 'ef-cmd-consumer-'));
    mkdirSync(join(consumerRoot, 'dist'));
    dirs.push(consumerRoot);
    // Project dir nested under THIS repo so tsx resolves via the repo's own
    // node_modules (see REPO_ROOT comment above).
    const projectDir = mkdtempSync(join(REPO_ROOT, '.tmp-ef-cmd-project-'));
    dirs.push(projectDir);
    const staleCtx = { runnerMode: 'node' as const, packageRoot: consumerRoot };

    await silenceLog(async () => {
      const code = await withCwd(projectDir, () =>
        runCommand(parseArgs(['init', '--ts', '--no-skills', '--yes']), staleCtx)
      );
      expect(code).toBe(0);
    });

    // The launched server process is spawned via `npx tsx …` (fresh decision),
    // NOT plain `node …` (the stale decision passed in as staleCtx.runnerMode).
    const serverLaunch = spawnCalls.find((c) =>
      c.args.some((a) => a.endsWith('index.ts') || a.endsWith('index.js'))
    );
    expect(serverLaunch?.cmd).toBe('npx');
    expect(serverLaunch?.args).toContain('tsx');
  });
});

describe('runDev/runServe project-dir precedence (EMBERFLOW_PROJECT env first)', () => {
  afterEach(() => { spawnCalls.length = 0; delete process.env.EMBERFLOW_PROJECT; });

  it('dev: an already-set EMBERFLOW_PROJECT wins over cwd when --project is absent', async () => {
    process.env.EMBERFLOW_PROJECT = '/env/project';
    await runCommand(parseArgs(['dev']));
    expect(spawnCalls[0]?.env.EMBERFLOW_PROJECT).toBe('/env/project');
  });

  it('dev: --project wins over cwd when EMBERFLOW_PROJECT is unset', async () => {
    const code = await runCommand(parseArgs(['dev', '--project', './somewhere']));
    void code;
    expect(spawnCalls[0]?.env.EMBERFLOW_PROJECT).toBe(join(process.cwd(), 'somewhere'));
  });

  it('dev: EMBERFLOW_PROJECT wins over --project when both are set', async () => {
    process.env.EMBERFLOW_PROJECT = '/env/project';
    await runCommand(parseArgs(['dev', '--project', './somewhere']));
    expect(spawnCalls[0]?.env.EMBERFLOW_PROJECT).toBe('/env/project');
  });

  it('dev: falls back to cwd when neither env nor --project is set', async () => {
    await runCommand(parseArgs(['dev']));
    expect(spawnCalls[0]?.env.EMBERFLOW_PROJECT).toBe(process.cwd());
  });

  it('serve: same precedence as dev', async () => {
    process.env.EMBERFLOW_PROJECT = '/env/project';
    await runCommand(parseArgs(['serve', '--project', './somewhere']));
    expect(spawnCalls[0]?.env.EMBERFLOW_PROJECT).toBe('/env/project');
  });
});
