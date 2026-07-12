// bin/init.test.ts
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit, tsxResolvable } from './init';

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
