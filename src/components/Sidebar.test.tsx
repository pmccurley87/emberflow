import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LedgerGlyph } from './Sidebar';

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
