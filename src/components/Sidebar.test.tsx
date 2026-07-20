import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LedgerGlyph, PlannedApiGroup, PlannedRow } from './Sidebar';

// LedgerGlyph is the op row's build-activity indicator, driven by the
// sidebar build ledger (`buildLedger` in builderStore): a spinner while the
// agent is actively writing an op this poll tick, a check once it's moved
// on to another op. Tested directly via props (rather than through the full
// Sidebar + live store) because zustand's SSR snapshot is frozen at store
// creation — renderToStaticMarkup can never observe a later setState.
describe('LedgerGlyph', () => {
  it('shows a spinner while the agent is actively writing this op', () => {
    const out = renderToStaticMarkup(<LedgerGlyph state="building" />);
    expect(out).toContain('aria-label="agent working"');
    expect(out).toContain('animate-spin');
  });

  it('shows a check once the agent has moved on from this op', () => {
    const out = renderToStaticMarkup(<LedgerGlyph state="done" />);
    expect(out).toContain('aria-label="built"');
  });

  it('renders nothing outside of a build-api run', () => {
    expect(renderToStaticMarkup(<LedgerGlyph state={undefined} />)).toBe('');
  });
});

describe('LedgerGlyph queued state', () => {
  it('a created-but-unbuilt shell shows the dashed queue glyph, not a built check', () => {
    const out = renderToStaticMarkup(<LedgerGlyph state="queued" />);
    expect(out).toContain('queued');
    expect(out).not.toContain('built');
  });
});

describe('PlannedRow / PlannedApiGroup', () => {
  const op = { id: 'billing/charge', name: 'Charge Card', method: 'POST', path: '/billing/charge' };

  it('renders a declared op as a non-clickable ghost row with a planned tag', () => {
    const out = renderToStaticMarkup(<PlannedRow op={op} depth={1} />);
    expect(out).toContain('Charge Card');
    expect(out).toContain('planned');
    expect(out).toContain('POST');
    expect(out).toContain('/billing/charge');
    expect(out).toContain('border-dashed');
    expect(out).not.toContain('role="button"');
  });

  it('internal sub-flows get the dashed-circle glyph instead of a method badge', () => {
    const out = renderToStaticMarkup(<PlannedRow op={{ id: 'billing/reconcile', name: 'Reconcile' }} depth={1} />);
    expect(out).toContain('Reconcile');
    expect(out).not.toContain('POST');
  });

  it('a planned API with nothing on disk renders as a ghost group with its ops', () => {
    const out = renderToStaticMarkup(<PlannedApiGroup name="billing" ops={[op]} />);
    expect(out).toContain('billing');
    expect(out).toContain('Charge Card');
    expect(out).toContain('planned');
  });
});
