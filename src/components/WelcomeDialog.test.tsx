import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WelcomeChecklist } from './WelcomeDialog';
import type { SetupStatus } from '../store/setupClient';

/** A pristine, just-initialized project: no agent, no environments, no skills,
 *  only the hello example op. */
const FRESH: SetupStatus = {
  agents: [],
  environments: { configured: false, count: 0, protectedCount: 0, anyAuthConfigured: false },
  skills: { claude: false, codex: false },
  language: 'typescript',
  ops: { count: 1, onlyHello: true },
  servingMode: 'mock',
  infrastructure: { present: false },
};

/** A project that's been set up: agent on PATH, environments + auth, skills
 *  installed, infrastructure scouted, several ops. */
const CONFIGURED: SetupStatus = {
  agents: [
    { kind: 'claude', version: '2.1.0' },
    { kind: 'codex', version: '0.5.3' },
  ],
  environments: { configured: true, count: 2, protectedCount: 1, anyAuthConfigured: true },
  skills: { claude: true, codex: false },
  language: 'typescript',
  ops: { count: 4, onlyHello: false },
  servingMode: 'real',
  infrastructure: { present: true, itemCount: 3 },
};

const html = (status: SetupStatus): string =>
  renderToStaticMarkup(<WelcomeChecklist status={status} />);

describe('WelcomeChecklist', () => {
  it('renders every checklist row', () => {
    const out = html(FRESH);
    for (const title of [
      'Coding agent detected',
      'Environments configured',
      'Secrets &amp; auth',
      'Agent skills installed',
      'Infrastructure scouted',
      'First operation',
    ]) {
      expect(out).toContain(title);
    }
  });

  it('fresh project: shows the install hint and no completed rows', () => {
    const out = html(FRESH);
    // Skills-missing hint is the copyable init command, no action button.
    expect(out).toContain('npx emberflow init --local --no-launch');
    expect(out).toContain('None detected on PATH');
    // Nothing is done yet — no "done" glyph.
    expect(out).not.toContain('aria-label="done"');
  });

  it('fresh project: the scout button is disabled without an agent', () => {
    const out = html(FRESH);
    // The Scout button carries the "detect an agent first" tooltip and is disabled.
    expect(out).toContain('Detect a coding agent first');
    expect(out).toMatch(/Scout/);
    expect(out).toContain('disabled');
  });

  it('configured project: shows completed rows and agent versions', () => {
    const out = html(CONFIGURED);
    expect(out).toContain('aria-label="done"');
    expect(out).toContain('claude 2.1.0');
    expect(out).toContain('codex 0.5.3');
    expect(out).toContain('2 environments, 1 protected');
    // Skills present → no install hint.
    expect(out).not.toContain('npx emberflow init');
  });

  it('configured project: scout is enabled (agent present)', () => {
    const out = html(CONFIGURED);
    expect(out).not.toContain('Detect a coding agent first');
  });
});
