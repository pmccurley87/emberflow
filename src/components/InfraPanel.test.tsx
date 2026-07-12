import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InfraPanel } from './InfraPanel';
import type { InfrastructureManifest, InfrastructureResponse } from '../store/infraClient';

const MANIFEST: InfrastructureManifest = {
  version: 1,
  scannedAt: '2026-07-12T00:00:00Z',
  greenfield: false,
  summary: 'Express app with Postgres (Prisma), Stripe, and SendGrid.',
  items: [
    {
      id: 'postgres-main',
      kind: 'database',
      name: 'Postgres (Prisma)',
      evidence: [{ file: 'prisma/schema.prisma', note: 'datasource db provider=postgresql' }],
      suggestedSecretRefs: ['DATABASE_URL'],
      suggestedVars: [],
      notes: 'Schema defines User, Order, Invoice models.',
    },
    {
      id: 'stripe',
      kind: 'http-api',
      name: 'Stripe',
      evidence: [{ file: 'package.json', note: 'stripe dependency' }],
      suggestedSecretRefs: ['STRIPE_SECRET_KEY'],
      suggestedVars: [],
    },
  ],
};

const html = (data: InfrastructureResponse | null): string =>
  renderToStaticMarkup(<InfraPanel data={data} />);

describe('InfraPanel', () => {
  it('renders the summary, each item card, kind, evidence, secretRefs and notes', () => {
    const out = html({ present: true, manifest: MANIFEST });
    expect(out).toContain('Express app with Postgres');
    // Item names + kinds.
    expect(out).toContain('Postgres (Prisma)');
    expect(out).toContain('database');
    expect(out).toContain('Stripe');
    expect(out).toContain('http-api');
    // Evidence file + note.
    expect(out).toContain('prisma/schema.prisma');
    expect(out).toContain('datasource db provider=postgresql');
    // Secret ref chips (NAMES only).
    expect(out).toContain('DATABASE_URL');
    expect(out).toContain('STRIPE_SECRET_KEY');
    // Notes.
    expect(out).toContain('User, Order, Invoice');
  });

  it('renders the not-scouted empty state with the scout button when absent', () => {
    const out = renderToStaticMarkup(<InfraPanel data={{ present: false }} onScout={() => {}} />);
    expect(out).toContain('Not scouted yet');
    expect(out).toContain('emberflow/infrastructure.json');
    expect(out).toContain('Scout infrastructure');
  });

  it('treats a null (unreachable) response like not-scouted', () => {
    const out = html(null);
    expect(out).toContain('Not scouted yet');
  });

  it('renders a distinct greenfield state', () => {
    const out = html({
      present: true,
      manifest: { version: 1, greenfield: true, summary: 'Clean slate — no infrastructure yet.', items: [] },
    });
    expect(out).toContain('Greenfield project');
    expect(out).toContain('Clean slate');
    // No item cards.
    expect(out).not.toContain('data-kind');
  });

  it('disables the scout button with the reason tooltip when canScout is false (no agent CLI)', () => {
    const out = renderToStaticMarkup(
      <InfraPanel
        data={{ present: false }}
        onScout={() => {}}
        canScout={false}
        canScoutReason="Detect a coding agent first"
      />,
    );
    expect(out).toContain('disabled');
    expect(out).toContain('Detect a coding agent first');
  });

  it('shows the scouting state on the button when a scout run is active', () => {
    const out = renderToStaticMarkup(
      <InfraPanel data={{ present: false }} onScout={() => {}} scouting />,
    );
    expect(out).toContain('Scouting…');
  });

  it('never renders a secret VALUE — only names appear', () => {
    const out = html({ present: true, manifest: MANIFEST });
    // The chip carries the NAME; there is no value anywhere in the manifest to leak.
    expect(out).toContain('DATABASE_URL');
    expect(out).not.toContain('postgres://');
  });
});
