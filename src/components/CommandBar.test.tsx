import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandBarPanel } from './CommandBar';

describe('CommandBarPanel', () => {
  it('renders the input, all routed options, and highlights the default', () => {
    const out = renderToStaticMarkup(
      <CommandBarPanel
        text="build an api for invoices"
        ctx={{ currentFlowId: 'default/hello', currentFlowName: 'Hello', hasOps: true }}
        highlighted={0}
        onText={() => {}}
        onPick={() => {}}
      />,
    );
    expect(out).toContain('Build something new');
    expect(out).toContain('Ask about this project');
    expect(out).toContain('Change Hello');
    // Highlighted row carries the ember treatment.
    expect(out).toContain('bg-highlight/[0.08]');
    // Kbd hints for discoverability.
    expect(out).toContain('↵');
  });

  it('shows a quiet hint instead of the picker options implying a fresh run when an agent run is in progress', () => {
    const out = renderToStaticMarkup(
      <CommandBarPanel
        text="build an api for invoices"
        ctx={{ currentFlowId: 'default/hello', currentFlowName: 'Hello', hasOps: true }}
        highlighted={0}
        running
        onText={() => {}}
        onPick={() => {}}
      />,
    );
    expect(out).toContain('An agent run is in progress — steer it from the Agent panel.');
    expect(out).toContain('text-[11px]');
  });

  it('omits the running hint when no agent run is in progress', () => {
    const out = renderToStaticMarkup(
      <CommandBarPanel
        text="build an api for invoices"
        ctx={{ currentFlowId: 'default/hello', currentFlowName: 'Hello', hasOps: true }}
        highlighted={0}
        onText={() => {}}
        onPick={() => {}}
      />,
    );
    expect(out).not.toContain('An agent run is in progress');
  });
});
