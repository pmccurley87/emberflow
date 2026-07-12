import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

export interface GitSnapshot {
  head: string | null;
  dirty: string[];
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** Untracked (non-ignored) files, relative to `dir`. */
function untrackedFiles(dir: string): string[] {
  const out = git(dir, ['ls-files', '--others', '--exclude-standard']);
  return out.split('\n').filter((line) => line.length > 0);
}

/**
 * Tracked files with uncommitted modifications (staged or unstaged), relative
 * to `dir`. Diffs against the given commit; when `head` is null (a repo with no
 * commits) there are no tracked-and-committed files, so returns [].
 */
function dirtyTrackedFiles(dir: string, head: string | null): string[] {
  if (!head) return [];
  const out = git(dir, ['diff', '--name-only', head]);
  return out.split('\n').filter((line) => line.length > 0);
}

export function isGitRepo(dir: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

export function snapshot(dir: string): GitSnapshot {
  let head: string | null = null;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    head = null;
  }
  const dirty = [...dirtyTrackedFiles(dir, head), ...untrackedFiles(dir)];
  return { head, dirty };
}

export function diffSince(dir: string, snap: GitSnapshot): string {
  if (snap.head) {
    return git(dir, ['diff', snap.head]);
  }
  return git(dir, ['diff']);
}

export function changedFiles(dir: string, snap: GitSnapshot): string[] {
  // Exclude any tracked file that was ALREADY dirty (uncommitted WIP) at
  // snapshot time — mirrors the untracked filter below. We can't cleanly
  // separate the user's pre-existing edits from the agent's own edits to the
  // same file, so the safest choice is to leave such files out of
  // `changedFiles` entirely: they won't be reported as agent changes, and
  // (critically) `revert` won't touch them, preserving the user's WIP.
  const trackedChanged = dirtyTrackedFiles(dir, snap.head).filter((f) => !snap.dirty.includes(f));

  const newlyUntracked = untrackedFiles(dir).filter((f) => !snap.dirty.includes(f));

  return [...new Set([...trackedChanged, ...newlyUntracked])];
}

/**
 * Reverts the given files, which are expected to come from `changedFiles`
 * (and therefore already exclude any untracked files that pre-date the
 * snapshot).
 *
 * Tracked files are restored from the snapshot commit (`git checkout
 * <snap.head> -- <file>`), NOT from the index — so a file that was `git add`ed
 * after the snapshot is still restored to its snapshot content, not its staged
 * (mutated) content. Files that are currently untracked (newly added since the
 * snapshot) are deleted.
 *
 * If `snap.head` is null (a repo with no commits at snapshot time) there is no
 * commit to restore tracked files from, so only the newly-added untracked files
 * are deleted; any tracked-file changes are left in place.
 */
export function revert(dir: string, snap: GitSnapshot, files: string[]): void {
  if (files.length === 0) return;

  const currentUntracked = new Set(untrackedFiles(dir));

  const toDelete = files.filter((f) => currentUntracked.has(f));
  const toCheckout = files.filter((f) => !currentUntracked.has(f));

  for (const file of toDelete) {
    rmSync(join(dir, file), { force: true });
  }

  if (toCheckout.length > 0 && snap.head) {
    git(dir, ['checkout', snap.head, '--', ...toCheckout]);
  }
}
