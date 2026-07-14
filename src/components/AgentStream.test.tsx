import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentStream, partitionAgentEvents } from './AgentStream';
import type { AgentEvent } from '../store/agentClient';

/** A representative stream: reasoning prose, a pair of shell commands (each
 *  streamed as in_progress→completed), an emberflow CLI op, an MCP call, and a
 *  ⚠ background diagnostic that should fold into a count. */
const FIXTURE: AgentEvent[] = [
  { type: 'started' },
  { type: 'message', text: 'Reading the **ground truth** first.' },
  { type: 'command', command: 'ls -la', commandStatus: 'in_progress' },
  { type: 'command', command: 'ls -la', commandStatus: 'completed', output: 'a\nb' },
  { type: 'command', command: 'cat package.json', commandStatus: 'in_progress' },
  { type: 'command', command: 'cat package.json', commandStatus: 'completed', output: '{}' },
  { type: 'message', text: '⚠ an MCP server failed to authenticate' },
  {
    type: 'command',
    command: 'node /x/bin/emberflow.mjs list-workflows',
    commandStatus: 'completed',
    output: 'default/hello',
  },
  { type: 'mcp', mcpServer: 'emberflow', mcpTool: 'run_operation', mcpStatus: 'completed', output: 'ok' },
  { type: 'message', text: 'All done.' },
  { type: 'done' },
];

describe('partitionAgentEvents', () => {
  it('folds the stream: prose blocks, one collapsed command group, an op step, an mcp step, noise counted', () => {
    const { blocks, noiseCount } = partitionAgentEvents(FIXTURE);
    // ⚠ diagnostic folded away, not rendered as a message block.
    expect(noiseCount).toBe(1);
    // The two shell commands collapse into ONE command group (in_progress+
    // completed pairs merged), with the emberflow op + mcp surfaced separately.
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toEqual(['message', 'commands', 'op', 'mcp', 'message']);
    const group = blocks.find((b) => b.kind === 'commands');
    expect(group?.kind === 'commands' && group.commands).toHaveLength(2);
  });

  it('drops structural started/done events', () => {
    const { blocks } = partitionAgentEvents([{ type: 'started' }, { type: 'done' }]);
    expect(blocks).toHaveLength(0);
  });
});

describe('AgentStream', () => {
  it('renders reasoning prose and the collapsed command count + hidden-diagnostics line', () => {
    const out = renderToStaticMarkup(<AgentStream events={FIXTURE} running={false} />);
    expect(out).toContain('ground truth');
    expect(out).toContain('Ran 2 commands');
    expect(out).toContain('1 background diagnostic hidden');
    // The emberflow op renders as its own OP step.
    expect(out).toContain('list-workflows');
  });

  it('failed command group: stays collapsed with a destructive header, output hidden until click', () => {
    const failedStream: AgentEvent[] = [
      { type: 'command', command: 'npm run build', commandStatus: 'in_progress' },
      {
        type: 'command',
        command: 'npm run build',
        commandStatus: 'failed',
        exitCode: 1,
        output: 'RAW-FAILURE-DUMP {"name":"pkg","dependencies":{}}',
      },
    ];
    const out = renderToStaticMarkup(<AgentStream events={failedStream} running={false} />);
    // Same collapsed affordance as a successful group…
    expect(out).toContain('Ran 1 command');
    // …with the failure signal on the header (destructive dot + tinted label).
    expect(out).toContain('bg-destructive');
    expect(out).toContain('text-destructive/90');
    // The raw output does NOT dump into the stream — it's behind the click.
    expect(out).not.toContain('RAW-FAILURE-DUMP');
    expect(out).not.toContain('npm run build');
  });

  it('shows a Thinking… indicator while running with no blocks yet', () => {
    const out = renderToStaticMarkup(<AgentStream events={[{ type: 'started' }]} running={true} />);
    expect(out).toContain('Thinking…');
  });

  it('shows a Working… indicator while running with content present', () => {
    const out = renderToStaticMarkup(<AgentStream events={FIXTURE} running={true} />);
    expect(out).toContain('Working…');
  });
});
