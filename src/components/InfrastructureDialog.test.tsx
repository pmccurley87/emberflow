import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InfraPanel, KIND_EXPLANATION } from './InfraPanel';
import { formatScoutedAt } from './InfrastructureDialog';
import type { InfrastructureManifest } from '../store/infraClient';

/** The modal reuses InfraPanel with `explainKinds` — same manifest the Dock tab
 *  renders, plus the per-kind plain-words gloss. */
const MANIFEST: InfrastructureManifest = {
  version: 1,
  scannedAt: '2026-07-11T00:00:00Z',
  greenfield: false,
  summary: 'Express app with Postgres (Prisma) and Stripe.',
  items: [
    {
      id: 'postgres-main',
      kind: 'database',
      name: 'Postgres (Prisma)',
      evidence: [{ file: 'prisma/schema.prisma' }],
      suggestedSecretRefs: ['DATABASE_URL'],
      suggestedVars: [],
    },
    {
      id: 'stripe',
      kind: 'http-api',
      name: 'Stripe',
      evidence: [{ file: 'package.json' }],
      suggestedSecretRefs: ['STRIPE_SECRET_KEY'],
      suggestedVars: [],
    },
  ],
};

describe('InfrastructureDialog', () => {
  describe('manifest render with per-kind explanations', () => {
    const out = renderToStaticMarkup(
      <InfraPanel data={{ present: true, manifest: MANIFEST }} explainKinds />,
    );

    it('renders the item cards', () => {
      expect(out).toContain('Postgres (Prisma)');
      expect(out).toContain('Stripe');
    });

    it('renders the plain-words gloss for each present kind', () => {
      expect(out).toContain(KIND_EXPLANATION.database);
      expect(out).toContain(KIND_EXPLANATION['http-api']);
    });

    it('does NOT render explanations when explainKinds is off (Dock tab)', () => {
      const plain = renderToStaticMarkup(<InfraPanel data={{ present: true, manifest: MANIFEST }} />);
      expect(plain).not.toContain(KIND_EXPLANATION.database);
    });
  });

  describe('greenfield / empty state', () => {
    it('renders the greenfield state from the shared panel', () => {
      const out = renderToStaticMarkup(
        <InfraPanel
          data={{
            present: true,
            manifest: { version: 1, greenfield: true, summary: 'Clean slate — no infrastructure yet.', items: [] },
          }}
          explainKinds
        />,
      );
      expect(out).toContain('Greenfield project');
      expect(out).toContain('Clean slate');
    });
  });

  describe('formatScoutedAt', () => {
    const base = new Date('2026-07-13T00:00:00Z').getTime();

    it('returns null for an absent timestamp (tolerant)', () => {
      expect(formatScoutedAt(undefined, base)).toBeNull();
    });

    it('returns null for an unparseable timestamp', () => {
      expect(formatScoutedAt('not-a-date', base)).toBeNull();
    });

    it('formats a 2-day-old scan as "scouted 2 days ago"', () => {
      expect(formatScoutedAt('2026-07-11T00:00:00Z', base)).toBe('scouted 2 days ago');
    });

    it('formats a very recent scan as "scouted just now"', () => {
      expect(formatScoutedAt('2026-07-12T23:59:30Z', base)).toBe('scouted just now');
    });

    it('formats hours and minutes with correct pluralization', () => {
      expect(formatScoutedAt('2026-07-12T23:00:00Z', base)).toBe('scouted 1 hour ago');
      expect(formatScoutedAt('2026-07-12T22:00:00Z', base)).toBe('scouted 2 hours ago');
      expect(formatScoutedAt('2026-07-12T23:58:00Z', base)).toBe('scouted 2 minutes ago');
    });
  });
});
