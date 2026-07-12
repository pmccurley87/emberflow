import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnClaude } from './claudeAdapter';
import type { AgentEvent } from './types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeClaudePath = path.join(__dirname, '__fixtures__', 'fake-claude.mjs');

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) {
    out.push(e);
  }
  return out;
}

describe('spawnClaude', () => {
  it('normalizes fake-claude stdout into [started, message, command in_progress, command completed, done]', async () => {
    const agent = spawnClaude('do the thing', os.tmpdir(), { bin: fakeClaudePath });
    const events = await collect(agent.events);
    expect(events).toEqual([
      { type: 'started' },
      { type: 'message', text: 'Working on it' },
      { type: 'command', command: 'ls', commandStatus: 'in_progress', toolUseId: 't1' },
      { type: 'command', command: 'ls', commandStatus: 'completed', output: 'file1\nfile2', toolUseId: 't1' },
      { type: 'done', usage: { output_tokens: 5 } },
    ]);
  });

  it('resolves a Bash command group to completed with output when the tool_result arrives (AgentConsole dedup fixture)', async () => {
    const agent = spawnClaude('do the thing', os.tmpdir(), { bin: fakeClaudePath });
    const events = await collect(agent.events);
    const inProgress = events.find((e) => e.type === 'command' && e.commandStatus === 'in_progress');
    const completed = events.find((e) => e.type === 'command' && e.commandStatus === 'completed');
    expect(inProgress).toEqual({ type: 'command', command: 'ls', commandStatus: 'in_progress', toolUseId: 't1' });
    // Same `command` text as the in_progress event — this is what lets
    // AgentConsole's existing dedup (in_progress + same command text →
    // replaced by completed) resolve the group to "Ran" + output.
    expect(completed).toEqual({
      type: 'command',
      command: 'ls',
      commandStatus: 'completed',
      output: 'file1\nfile2',
      toolUseId: 't1',
    });
  });

  it('yields a terminal error event when the process exits non-zero without a result event', async () => {
    process.env.FAKE_CLAUDE_FAIL = '1';
    try {
      const agent = spawnClaude('do the thing', os.tmpdir(), { bin: fakeClaudePath });
      const events = await collect(agent.events);
      expect(events[0]).toEqual({ type: 'started' });
      const last = events[events.length - 1];
      expect(last.type).toBe('error');
      expect(last.text).not.toContain('hint:');
    } finally {
      delete process.env.FAKE_CLAUDE_FAIL;
    }
  });

  it('appends an actionable hint to the terminal error when stderr looks like a model-rejection', async () => {
    process.env.FAKE_CLAUDE_MODEL_REJECT = '1';
    try {
      const agent = spawnClaude('do the thing', os.tmpdir(), { bin: fakeClaudePath });
      const events = await collect(agent.events);
      const last = events[events.length - 1];
      expect(last.type).toBe('error');
      expect(last.text).toContain(
        'hint: your claude CLI may be too old for the selected model — upgrade it or switch backend in Settings.',
      );
    } finally {
      delete process.env.FAKE_CLAUDE_MODEL_REJECT;
    }
  });

  it('yields a terminal error (and does not crash) when the binary cannot be spawned', async () => {
    const agent = spawnClaude('do the thing', os.tmpdir(), { bin: '/nonexistent/nope' });
    const events = await collect(agent.events);
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(last.type).toBe('error');
    expect(events.filter((e) => e.type === 'done')).toEqual([]);
  });

  it('cancel() sends SIGTERM and does not throw', async () => {
    const agent = spawnClaude('do the thing', os.tmpdir(), { bin: fakeClaudePath });
    expect(() => agent.cancel()).not.toThrow();
    await collect(agent.events);
  });

  it('cancel() escalates to SIGKILL if the process ignores SIGTERM', async () => {
    process.env.FAKE_CLAUDE_HANG = '1';
    try {
      const agent = spawnClaude('do the thing', os.tmpdir(), { bin: fakeClaudePath, killGraceMs: 50 });
      // Let the fixture install its SIGTERM handler before we cancel.
      await new Promise((r) => setTimeout(r, 100));
      agent.cancel();
      const events = await collect(agent.events);
      const last = events[events.length - 1];
      // SIGKILL can't be caught, so the process dies without emitting its
      // own terminal event — the adapter must synthesize an error.
      expect(last.type).toBe('error');
    } finally {
      delete process.env.FAKE_CLAUDE_HANG;
    }
  }, 10000);

  it('synthesizes a terminal done when the process exits 0 without a result event', async () => {
    process.env.FAKE_CLAUDE_NODONE = '1';
    try {
      const agent = spawnClaude('do the thing', os.tmpdir(), { bin: fakeClaudePath });
      const events = await collect(agent.events);
      expect(events).toEqual([
        { type: 'started' },
        { type: 'message', text: 'Working on it' },
        { type: 'command', command: 'ls', commandStatus: 'in_progress', toolUseId: 't1' },
        { type: 'command', command: 'ls', commandStatus: 'completed', output: 'file1\nfile2', toolUseId: 't1' },
        { type: 'done' },
      ]);
    } finally {
      delete process.env.FAKE_CLAUDE_NODONE;
    }
  });
});
