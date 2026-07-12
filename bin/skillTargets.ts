import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type Harness = 'claude' | 'codex';
export interface HarnessPresence {
  claude: boolean;
  codex: boolean;
}

const HARNESSES: Harness[] = ['claude', 'codex'];

/** Detect which harnesses the project/user uses: a harness counts as present if
 *  its repo dir (<cwd>/.claude or /.codex) OR its home dir (<home>/.claude or /.codex) exists. */
export function detectHarnesses(cwd: string, home: string): HarnessPresence {
  const presence = {} as HarnessPresence;
  for (const h of HARNESSES) {
    presence[h] = existsSync(join(cwd, `.${h}`)) || existsSync(join(home, `.${h}`));
  }
  return presence;
}

/** The skills destination dirs to install into. For each PRESENT harness, choose
 *  the repo root (<cwd>/.<harness>/skills) when scope='repo', else the home root
 *  (<home>/.<harness>/skills). If NEITHER harness is present, default to Claude Code
 *  at the chosen scope (so a fresh project still gets skills). Returns absolute dirs. */
export function resolveSkillDirs(
  presence: HarnessPresence,
  scope: 'repo' | 'global',
  cwd: string,
  home: string
): string[] {
  const root = scope === 'repo' ? cwd : home;
  const present = HARNESSES.filter((h) => presence[h]);
  const targets = present.length > 0 ? present : (['claude'] as Harness[]);
  return targets.map((h) => join(root, `.${h}`, 'skills'));
}
