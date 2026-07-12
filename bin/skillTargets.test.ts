// bin/skillTargets.test.ts
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectHarnesses, resolveSkillDirs } from './skillTargets';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ef-skilltargets-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('detectHarnesses', () => {
  it('detects neither present when no markers exist', () => {
    const cwd = scratch();
    const home = scratch();
    expect(detectHarnesses(cwd, home)).toEqual({ claude: false, codex: false });
  });

  it('detects claude present via repo dir', () => {
    const cwd = scratch();
    const home = scratch();
    mkdirSync(join(cwd, '.claude'));
    expect(detectHarnesses(cwd, home)).toEqual({ claude: true, codex: false });
  });

  it('detects claude present via home dir', () => {
    const cwd = scratch();
    const home = scratch();
    mkdirSync(join(home, '.claude'));
    expect(detectHarnesses(cwd, home)).toEqual({ claude: true, codex: false });
  });

  it('detects codex present via repo dir', () => {
    const cwd = scratch();
    const home = scratch();
    mkdirSync(join(cwd, '.codex'));
    expect(detectHarnesses(cwd, home)).toEqual({ claude: false, codex: true });
  });

  it('detects codex present via home dir', () => {
    const cwd = scratch();
    const home = scratch();
    mkdirSync(join(home, '.codex'));
    expect(detectHarnesses(cwd, home)).toEqual({ claude: false, codex: true });
  });

  it('detects both present', () => {
    const cwd = scratch();
    const home = scratch();
    mkdirSync(join(cwd, '.claude'));
    mkdirSync(join(home, '.codex'));
    expect(detectHarnesses(cwd, home)).toEqual({ claude: true, codex: true });
  });
});

describe('resolveSkillDirs', () => {
  it('picks repo dirs for present harnesses at repo scope', () => {
    const cwd = scratch();
    const home = scratch();
    const dirs = resolveSkillDirs({ claude: true, codex: true }, 'repo', cwd, home);
    expect(dirs.sort()).toEqual(
      [join(cwd, '.claude', 'skills'), join(cwd, '.codex', 'skills')].sort()
    );
  });

  it('picks home dirs for present harnesses at global scope', () => {
    const cwd = scratch();
    const home = scratch();
    const dirs = resolveSkillDirs({ claude: true, codex: true }, 'global', cwd, home);
    expect(dirs.sort()).toEqual(
      [join(home, '.claude', 'skills'), join(home, '.codex', 'skills')].sort()
    );
  });

  it('returns only the present harness dir when just one is present (repo scope)', () => {
    const cwd = scratch();
    const home = scratch();
    const dirs = resolveSkillDirs({ claude: true, codex: false }, 'repo', cwd, home);
    expect(dirs).toEqual([join(cwd, '.claude', 'skills')]);
  });

  it('returns only the present harness dir when just one is present (global scope)', () => {
    const cwd = scratch();
    const home = scratch();
    const dirs = resolveSkillDirs({ claude: false, codex: true }, 'global', cwd, home);
    expect(dirs).toEqual([join(home, '.codex', 'skills')]);
  });

  it('falls back to claude at repo scope when neither harness is present', () => {
    const cwd = scratch();
    const home = scratch();
    const dirs = resolveSkillDirs({ claude: false, codex: false }, 'repo', cwd, home);
    expect(dirs).toEqual([join(cwd, '.claude', 'skills')]);
  });

  it('falls back to claude at global scope when neither harness is present', () => {
    const cwd = scratch();
    const home = scratch();
    const dirs = resolveSkillDirs({ claude: false, codex: false }, 'global', cwd, home);
    expect(dirs).toEqual([join(home, '.claude', 'skills')]);
  });
});
