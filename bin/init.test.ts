// bin/init.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit, tsxResolvable } from './init';

/** Run git in `dir`, returning trimmed stdout. Pins an identity so commits work
 *  on a machine/CI with no global git config. */
function git(dir: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd: dir, encoding: 'utf8' },
  ).trim();
}

const dirs: string[] = [];
function scratch(): string { const d = mkdtempSync(join(tmpdir(), 'ef-init-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('runInit', () => {
  it('scaffolds config, an example apis/ operation, and its scenario sidecar', async () => {
    const d = scratch();
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'consumer', scripts: {} }));
    const code = await runInit(d);
    expect(code).toBe(0);
    expect(existsSync(join(d, 'emberflow.config.mjs'))).toBe(true);
    // No legacy flows/ tree — the current model is apis/ only.
    expect(existsSync(join(d, 'emberflow/flows'))).toBe(false);
    expect(existsSync(join(d, 'emberflow/apis/default/hello.json'))).toBe(true);
    expect(existsSync(join(d, 'emberflow/apis/default/hello.scenarios.json'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
    expect(pkg.scripts.emberflow).toBe('emberflow dev');
    const op = JSON.parse(readFileSync(join(d, 'emberflow/apis/default/hello.json'), 'utf8'));
    expect(op.id).toBe('default/hello');
    expect(op.http).toEqual({ method: 'GET', path: '/hello' });
    expect(op.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it('defaults to a javascript scaffold with language field and JSDoc typing', async () => {
    const d = scratch();
    await runInit(d, { skills: false });
    const config = readFileSync(join(d, 'emberflow.config.mjs'), 'utf8');
    expect(config).toContain("language: 'javascript'");
    expect(config).toContain("@param {import('@xdelivered/emberflow').NodeRegistry} registry");
    expect(existsSync(join(d, 'emberflow.config.ts'))).toBe(false);
    expect(existsSync(join(d, 'tsconfig.json'))).toBe(false);
  });

  it('scaffolds a typescript config, tsconfig.json, and a typed registerNodes when language: typescript', async () => {
    const d = scratch();
    await runInit(d, { skills: false, language: 'typescript' });
    expect(existsSync(join(d, 'emberflow.config.mjs'))).toBe(false);
    const config = readFileSync(join(d, 'emberflow.config.ts'), 'utf8');
    expect(config).toContain("language: 'typescript'");
    expect(config).toContain("import type { NodeRegistry } from '@xdelivered/emberflow'");
    expect(config).toContain('registerNodes(registry: NodeRegistry)');
    expect(existsSync(join(d, 'tsconfig.json'))).toBe(true);
    const tsconfig = JSON.parse(readFileSync(join(d, 'tsconfig.json'), 'utf8'));
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.include).toContain('emberflow.config.ts');
  });

  it('does not overwrite an existing tsconfig.json on re-init', async () => {
    const d = scratch();
    writeFileSync(join(d, 'tsconfig.json'), '{"custom": true}\n');
    await runInit(d, { skills: false, language: 'typescript' });
    expect(readFileSync(join(d, 'tsconfig.json'), 'utf8')).toContain('custom');
  });

  it('refuses to scaffold a second config in the OTHER language (dead-config guard)', async () => {
    const d = scratch();
    await runInit(d, { skills: false, language: 'javascript' });
    const code = await runInit(d, { skills: false, language: 'typescript' });
    expect(code).toBe(1);
    expect(existsSync(join(d, 'emberflow.config.ts'))).toBe(false);
    // And the mirror direction: existing .ts config blocks a javascript init.
    const d2 = scratch();
    await runInit(d2, { skills: false, language: 'typescript' });
    const code2 = await runInit(d2, { skills: false, language: 'javascript' });
    expect(code2).toBe(1);
    expect(existsSync(join(d2, 'emberflow.config.mjs'))).toBe(false);
  });

  it('does not clobber an existing config or emberflow script', async () => {
    const d = scratch();
    writeFileSync(join(d, 'emberflow.config.mjs'), 'export default { custom: true };\n');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { emberflow: 'mine' } }));
    await runInit(d);
    expect(readFileSync(join(d, 'emberflow.config.mjs'), 'utf8')).toContain('custom: true');
    expect(JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).scripts.emberflow).toBe('mine');
  });

  it('copies skills into .claude/skills by default (repo scope)', async () => {
    const d = scratch();
    await runInit(d, { skills: { scope: 'repo', home: d } });
    expect(existsSync(join(d, '.claude/skills/emberflow-basics/SKILL.md'))).toBe(true);
  });

  it('skips skills entirely when skills: false', async () => {
    const d = scratch();
    await runInit(d, { skills: false });
    expect(existsSync(join(d, '.claude'))).toBe(false);
  });

  it('creates .gitignore for emberflow infra, keeping apis + config committed', async () => {
    const d = scratch();
    await runInit(d, { skills: false });
    const gi = readFileSync(join(d, '.gitignore'), 'utf8');
    // infra ignored
    for (const line of ['node_modules/', 'studio-dist/', 'emberflow.secrets.json', 'emberflow.environments.json']) {
      expect(gi).toContain(line);
    }
    // the value stays committed — no ignore LINE for config or flows (the header
    // comment may name them, but they must not appear as active patterns)
    const patterns = gi.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(patterns).not.toContain('emberflow.config.mjs');
    expect(patterns).not.toContain('emberflow/');
    expect(patterns).not.toContain('emberflow/flows/');
  });

  it('scaffolds emberflow/apis/default so the API host is ready out of the box', async () => {
    const d = scratch();
    await runInit(d, { skills: false });
    expect(existsSync(join(d, 'emberflow', 'apis', 'default'))).toBe(true);
  });

  it('appends to an existing .gitignore without duplicating on re-run', async () => {
    const d = scratch();
    writeFileSync(join(d, '.gitignore'), 'bin/\nobj/\n');
    await runInit(d, { skills: false });
    await runInit(d, { skills: false });
    const gi = readFileSync(join(d, '.gitignore'), 'utf8');
    expect(gi).toContain('bin/'); // pre-existing preserved
    expect((gi.match(/emberflow\.secrets\.json/g) ?? []).length).toBe(1);
  });

  it('warns when stamping "type": "module" on an existing package.json without a type field', async () => {
    const d = scratch();
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'consumer', scripts: {} }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runInit(d, { skills: false, language: 'typescript' });
      expect(JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).type).toBe('module');
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('set "type": "module" in package.json');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn about stamping type:module when it is already set', async () => {
    const d = scratch();
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'consumer', type: 'module', scripts: {} }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runInit(d, { skills: false, language: 'typescript' });
      expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('set "type": "module" in package.json');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('runInit git bootstrap', () => {
  it('git-inits the folder and makes the load-bearing initial commit', async () => {
    const d = scratch();
    await runInit(d, { skills: false });
    expect(existsSync(join(d, '.git'))).toBe(true);
    // Exactly one commit, the scaffold commit — the snapshot/diff/revert safety
    // net needs a real HEAD to diff against (an unborn HEAD can't be reverted).
    expect(git(d, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(git(d, ['log', '--oneline'])).toContain('chore: emberflow init');
  });

  it('commits ONLY init-scaffolded files, never the user’s pre-existing code', async () => {
    const d = scratch();
    // A fresh dir may already hold the user's own uncommitted app code.
    writeFileSync(join(d, 'app.js'), 'console.log("mine");\n');
    await runInit(d, { skills: false });

    const tracked = git(d, ['ls-tree', '-r', 'HEAD', '--name-only']).split('\n');
    expect(tracked).toContain('emberflow.config.mjs');
    expect(tracked).toContain('emberflow/apis/default/hello.json');
    expect(tracked).toContain('.gitignore');
    // The user's file was NOT swept into the commit (no `git add -A`).
    expect(tracked).not.toContain('app.js');
    // It's still there, just untracked.
    expect(git(d, ['status', '--porcelain'])).toContain('?? app.js');
  });

  it('--no-git (git: false) skips repo creation entirely', async () => {
    const d = scratch();
    await runInit(d, { skills: false, git: false });
    expect(existsSync(join(d, '.git'))).toBe(false);
  });

  it('leaves a pre-existing repo untouched — no nested repo, no extra commit', async () => {
    const d = scratch();
    git(d, ['init']);
    writeFileSync(join(d, 'README.md'), '# mine\n');
    git(d, ['add', '-A']);
    git(d, ['commit', '-m', 'user commit']);
    const before = git(d, ['rev-list', '--count', 'HEAD']);

    await runInit(d, { skills: false });

    // `d` is still the repo root — init did not nest a new repo under it
    // (--show-cdup is empty only when cwd IS the toplevel).
    expect(git(d, ['rev-parse', '--show-cdup'])).toBe('');
    expect(existsSync(join(d, 'emberflow', 'apis', 'default'))).toBe(true);
    // init added no commit of its own.
    expect(git(d, ['rev-list', '--count', 'HEAD'])).toBe(before);
    // The scaffold is present but uncommitted — the user commits on their terms.
    expect(git(d, ['status', '--porcelain'])).toContain('emberflow.config.mjs');
  });

  it('re-running init on an already-scaffolded, non-git dir makes an empty anchor commit (no unborn HEAD)', async () => {
    const d = scratch();
    // Pre-scaffold everything init would normally write, as if a prior
    // `emberflow init --no-git` (or a non-interactive run) already wrote it
    // and the directory is still not a git repo — exactly what the
    // checklist's copyable skills command produces.
    await runInit(d, { skills: false, git: false });
    expect(existsSync(join(d, '.git'))).toBe(false);

    await runInit(d, { skills: false });

    expect(existsSync(join(d, '.git'))).toBe(true);
    // HEAD must resolve — an unborn HEAD (git init with zero commits) makes
    // snapshot.head null downstream, which the agent snapshot/diff/revert
    // safety net treats as "unrevertable".
    expect(() => git(d, ['rev-parse', 'HEAD'])).not.toThrow();
    expect(git(d, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(git(d, ['log', '--oneline'])).toContain('chore: emberflow init (anchor)');
  });

  it('folds repo-scope skill files into the same init commit as the rest of the scaffold', async () => {
    const d = scratch();
    await runInit(d, { skills: { scope: 'repo', home: join(d, '.home-unused') } });

    const tracked = git(d, ['ls-tree', '-r', 'HEAD', '--name-only']).split('\n');
    expect(tracked).toContain('emberflow.config.mjs');
    expect(tracked).toContain('.claude/skills/emberflow-basics/SKILL.md');
  });
});

describe('tsxResolvable', () => {
  it('returns true when tsx resolves from a project (this repo has it as a devDependency)', () => {
    expect(tsxResolvable(process.cwd())).toBe(true);
  });

  it('returns false in an isolated scratch dir with no node_modules', () => {
    const d = scratch();
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'isolated' }));
    expect(tsxResolvable(d)).toBe(false);
  });
});
