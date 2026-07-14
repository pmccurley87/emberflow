import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyState } from './EmptyState';
import type { SetupStatus } from '../store/setupClient';

/** A project that finished onboarding but still has only the hello example. */
const ONLY_HELLO: SetupStatus = {
  agents: [{ kind: 'claude', version: '2.1.0' }],
  git: { repo: true },
  environments: { configured: true, count: 2, protectedCount: 1, anyAuthConfigured: true },
  skills: { claude: true, codex: false },
  language: 'typescript',
  ops: { count: 1, onlyHello: true },
  servingMode: 'mock',
  infrastructure: { present: true, itemCount: 2 },
};

const html = (status: SetupStatus | null, dismissed = false): string =>
  renderToStaticMarkup(
    <EmptyState status={status} dismissed={dismissed} onCreate={() => {}} onExplore={() => {}} />,
  );

describe('EmptyState', () => {
  it('renders when the project has only the hello example and is not dismissed', () => {
    const out = html(ONLY_HELLO);
    expect(out).toContain('Build your first API');
    expect(out).toContain('Describe what you want and the agent builds it');
    expect(out).toContain('Create your first API');
    expect(out).toContain('Explore the hello example');
  });

  it('hidden once dismissed', () => {
    expect(html(ONLY_HELLO, true)).toBe('');
  });

  it('hidden once the project has more than the hello op (condition stops matching)', () => {
    expect(html({ ...ONLY_HELLO, ops: { count: 3, onlyHello: false } })).toBe('');
  });

  it('hidden with no setup status yet', () => {
    expect(html(null)).toBe('');
  });

  it('the template button is disabled and marked coming soon', () => {
    const out = html(ONLY_HELLO);
    expect(out).toMatch(/disabled=""[^>]*title="Coming soon"|title="Coming soon"[^>]*disabled=""/);
    expect(out).toContain('Start from a template');
  });
});
