import { describe, expect, it } from 'vitest';
import { parseCodexLine } from './codexParse';

describe('parseCodexLine', () => {
  it('maps a command_execution start', () => {
    const e = parseCodexLine('{"type":"item.started","item":{"id":"i3","type":"command_execution","command":"ls","status":"in_progress"}}');
    expect(e).toEqual({ type: 'command', command: 'ls', commandStatus: 'in_progress' });
  });
  it('maps a completed (failed) command with exit code + output', () => {
    const e = parseCodexLine('{"type":"item.completed","item":{"id":"i3","type":"command_execution","command":"curl x","exit_code":6,"aggregated_output":"000","status":"failed"}}');
    expect(e).toEqual({ type: 'command', command: 'curl x', exitCode: 6, output: '000', commandStatus: 'failed' });
  });
  it('maps an agent_message to message', () => {
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"Updated file"}}'))
      .toEqual({ type: 'message', text: 'Updated file' });
  });

  it('maps a non-fatal error ITEM to a warning message (NOT a terminal error)', () => {
    // codex `error` items (e.g. an MCP server failing to auth) must not fail the
    // whole run — only a non-zero process exit does. See codexParse.ts.
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"error","text":"mcp auth failed"}}'))
      .toEqual({ type: 'message', text: '⚠ mcp auth failed' });
  });
  it('reads the error detail from `message` when `text` is absent — the shape current codex ships', () => {
    // Without this, a fatal-cause diagnostic (e.g. "model requires a newer
    // version of Codex") renders as a bare "⚠ error" and the user learns nothing.
    expect(
      parseCodexLine('{"type":"item.completed","item":{"type":"error","message":"model requires a newer version of Codex"}}'),
    ).toEqual({ type: 'message', text: '⚠ model requires a newer version of Codex' });
  });
  it('maps an mcp_tool_call (flat server/tool) to an mcp event with status', () => {
    expect(
      parseCodexLine('{"type":"item.started","item":{"type":"mcp_tool_call","server":"emberflow","tool":"run_operation","status":"in_progress"}}'),
    ).toEqual({ type: 'mcp', mcpServer: 'emberflow', mcpTool: 'run_operation', mcpStatus: 'in_progress' });
  });
  it('maps a completed mcp_tool_call, reading server/tool from invocation + result', () => {
    expect(
      parseCodexLine('{"type":"item.completed","item":{"type":"mcp_tool_call","invocation":{"server":"emberflow","tool":"run_operation"},"status":"completed","result":{"status":200}}}'),
    ).toEqual({ type: 'mcp', mcpServer: 'emberflow', mcpTool: 'run_operation', mcpStatus: 'completed', output: '{\n  "status": 200\n}' });
  });
  it('tolerates missing fields on an mcp_tool_call (falls back to mcp/tool)', () => {
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"mcp_tool_call"}}'))
      .toEqual({ type: 'mcp', mcpServer: 'mcp', mcpTool: 'tool', mcpStatus: undefined });
  });
  it('maps turn.completed to done with usage', () => {
    expect(parseCodexLine('{"type":"turn.completed","usage":{"output_tokens":5}}'))
      .toEqual({ type: 'done', usage: { output_tokens: 5 } });
  });
  it('maps thread.started/turn.started to started', () => {
    expect(parseCodexLine('{"type":"thread.started"}')).toEqual({ type: 'started' });
    expect(parseCodexLine('{"type":"turn.started"}')).toEqual({ type: 'started' });
  });
  it('ignores unknown and blank lines', () => {
    expect(parseCodexLine('{"type":"whatever"}')).toBeNull();
    expect(parseCodexLine('')).toBeNull();
    expect(parseCodexLine('not json')).toBeNull();
  });
});
