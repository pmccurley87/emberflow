import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedFiles, diffSince, isGitRepo, revert, snapshot } from './gitScope';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

describe('gitScope', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gitscope-'));
    git(dir, ['init']);
    git(dir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init']);
    writeFileSync(join(dir, 'tracked.txt'), 'original content\n');
    git(dir, ['add', 'tracked.txt']);
    git(dir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'add tracked file']);
    // pre-existing untracked file that must survive revert untouched
    writeFileSync(join(dir, 'pre-existing-untracked.txt'), 'do not touch\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('isGitRepo returns true for a git repo and false otherwise', () => {
    expect(isGitRepo(dir)).toBe(true);
    const nonRepo = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    try {
      expect(isGitRepo(nonRepo)).toBe(false);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('changedFiles lists a mutated tracked file and a newly-added file, diffSince shows the mutation', () => {
    const snap = snapshot(dir);

    writeFileSync(join(dir, 'tracked.txt'), 'mutated content\n');
    writeFileSync(join(dir, 'new-file.txt'), 'brand new\n');

    const files = changedFiles(dir, snap);
    expect(files).toContain('tracked.txt');
    expect(files).toContain('new-file.txt');
    expect(files).not.toContain('pre-existing-untracked.txt');

    const diff = diffSince(dir, snap);
    expect(diff).toContain('mutated content');
  });

  it('revert restores the tracked file, removes the new file, and leaves pre-existing untracked files alone', () => {
    const snap = snapshot(dir);

    writeFileSync(join(dir, 'tracked.txt'), 'mutated content\n');
    writeFileSync(join(dir, 'new-file.txt'), 'brand new\n');

    const files = changedFiles(dir, snap);
    revert(dir, snap, files);

    expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe('original content\n');
    expect(existsSync(join(dir, 'new-file.txt'))).toBe(false);
    expect(existsSync(join(dir, 'pre-existing-untracked.txt'))).toBe(true);
  });

  it('revert restores a file that was mutated AND staged (git add) since the snapshot', () => {
    const snap = snapshot(dir);

    writeFileSync(join(dir, 'tracked.txt'), 'mutated content\n');
    git(dir, ['add', 'tracked.txt']);

    const files = changedFiles(dir, snap);
    expect(files).toContain('tracked.txt');

    revert(dir, snap, files);

    // Must be the snapshot content, not the staged (mutated) content.
    expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe('original content\n');
  });

  it('changedFiles/revert exclude a tracked file that was already dirty (WIP) at snapshot time', () => {
    // Simulate the user having uncommitted WIP on tracked.txt *before* the agent runs.
    writeFileSync(join(dir, 'tracked.txt'), 'user wip content\n');

    const snap = snapshot(dir);
    expect(snap.dirty).toContain('tracked.txt');

    // Agent runs: creates a new file, does NOT touch tracked.txt.
    writeFileSync(join(dir, 'new.txt'), 'agent created\n');

    const files = changedFiles(dir, snap);
    expect(files).toEqual(['new.txt']);
    expect(files).not.toContain('tracked.txt');

    revert(dir, snap, files);

    // The user's WIP edit must survive untouched.
    expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe('user wip content\n');
    // The agent's new file must be gone.
    expect(existsSync(join(dir, 'new.txt'))).toBe(false);
  });

  it('snapshot / changedFiles / revert work on a fresh repo with no commits', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'gitscope-empty-'));
    try {
      git(fresh, ['init']);
      writeFileSync(join(fresh, 'a.txt'), 'hello\n');

      const snap = snapshot(fresh);
      expect(snap.head).toBeNull();

      // Add a new file after the snapshot.
      writeFileSync(join(fresh, 'b.txt'), 'new\n');

      const files = changedFiles(fresh, snap);
      expect(files).toContain('b.txt');
      expect(files).not.toContain('a.txt'); // pre-existing untracked, not a change

      revert(fresh, snap, files);
      expect(existsSync(join(fresh, 'b.txt'))).toBe(false);
      expect(existsSync(join(fresh, 'a.txt'))).toBe(true); // left alone
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
