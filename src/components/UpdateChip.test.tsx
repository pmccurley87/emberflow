import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdateChip } from './StatusBar';

/** Props-driven chip (StatusBar owns the /update-status fetch), so the test
 *  renders it directly — same pattern as InfrastructureDialog.test.tsx. */
describe('UpdateChip', () => {
  it('renders nothing while the status is unknown (fetch failed / pending)', () => {
    expect(renderToStaticMarkup(<UpdateChip status={null} />)).toBe('');
  });

  it('renders nothing when the runner is current', () => {
    const out = renderToStaticMarkup(
      <UpdateChip status={{ current: '0.3.0', latest: '0.3.0', updateAvailable: false }} />,
    );
    expect(out).toBe('');
  });

  it('renders nothing when the check was unavailable (no latest)', () => {
    const out = renderToStaticMarkup(<UpdateChip status={{ current: '0.3.0', updateAvailable: false }} />);
    expect(out).toBe('');
  });

  it('shows the chip with both versions when an update is available', () => {
    const out = renderToStaticMarkup(
      <UpdateChip status={{ current: '0.3.0', latest: '0.4.0', updateAvailable: true }} />,
    );
    expect(out).toContain('update');
    expect(out).toContain('Update available — 0.3.0 → 0.4.0');
  });
});
