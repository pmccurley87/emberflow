import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnCodex } from './codexAdapter';
import type { AgentEvent } from './types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeCodexPath = path.join(__dirname, '__fixtures__', 'fake-codex.mjs');

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) {
    out.push(e);
  }
  return out;
}

describe('spawnCodex', () => {
  it('normalizes fake-codex stdout into [started, command, message, done]', async () => {
    const agent = spawnCodex('do the thing', os.tmpdir(), { bin: fakeCodexPath });
    const events = await collect(agent.events);
    expect(events).toEqual([
      { type: 'started' },
      { type: 'command', command: 'ls', commandStatus: 'in_progress' },
      { type: 'message', text: 'Done listing files' },
      { type: 'done', usage: { output_tokens: 5 } },
    ]);
  });

  it('yields a terminal error event when the process exits non-zero without a done event', async () => {
    process.env.FAKE_CODEX_FAIL = '1';
    try {
      const agent = spawnCodex('do the thing', os.tmpdir(), { bin: fakeCodexPath });
      const events = await collect(agent.events);
      expect(events[0]).toEqual({ type: 'started' });
      expect(events[1]).toEqual({ type: 'command', command: 'ls', commandStatus: 'in_progress' });
      expect(events[2]).toEqual({ type: 'message', text: 'Done listing files' });
      const last = events[events.length - 1];
      expect(last.type).toBe('error');
      expect(last.text).not.toContain('hint:');
    } finally {
      delete process.env.FAKE_CODEX_FAIL;
    }
  });

  it('appends an actionable hint to the terminal error when stderr looks like a model-rejection', async () => {
    process.env.FAKE_CODEX_MODEL_REJECT = '1';
    try {
      const agent = spawnCodex('do the thing', os.tmpdir(), { bin: fakeCodexPath });
      const events = await collect(agent.events);
      const last = events[events.length - 1];
      expect(last.type).toBe('error');
      expect(last.text).toContain(
        'hint: your codex CLI may be too old for the selected model — upgrade it or switch backend in Settings.',
      );
    } finally {
      delete process.env.FAKE_CODEX_MODEL_REJECT;
    }
  });

  it('delivers every event including the trailing done when the child emits many lines then exits (no event-loss race)', async () => {
    process.env.FAKE_CODEX_MANY = '1';
    try {
      const agent = spawnCodex('do the thing', os.tmpdir(), { bin: fakeCodexPath });
      const events = await collect(agent.events);
      // started + command + message + 27 filler messages + done = 31 events
      expect(events.length).toBe(31);
      expect(events[0]).toEqual({ type: 'started' });
      expect(events[events.length - 1]).toEqual({ type: 'done', usage: { output_tokens: 5 } });
      const fillers = events.filter((e) => e.type === 'message' && e.text?.startsWith('filler '));
      expect(fillers.length).toBe(27);
    } finally {
      delete process.env.FAKE_CODEX_MANY;
    }
  });

  it('yields a terminal error (and does not crash) when the binary cannot be spawned', async () => {
    const agent = spawnCodex('do the thing', os.tmpdir(), { bin: '/nonexistent/nope' });
    const events = await collect(agent.events);
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(last.type).toBe('error');
    expect(events.filter((e) => e.type === 'done')).toEqual([]);
  });

  it('cancel() sends SIGTERM and does not throw', async () => {
    const agent = spawnCodex('do the thing', os.tmpdir(), { bin: fakeCodexPath });
    expect(() => agent.cancel()).not.toThrow();
    await collect(agent.events);
  });

  it('cancel() escalates to SIGKILL if the process ignores SIGTERM', async () => {
    process.env.FAKE_CODEX_HANG = '1';
    try {
      const agent = spawnCodex('do the thing', os.tmpdir(), { bin: fakeCodexPath, killGraceMs: 50 });
      // Let the fixture install its SIGTERM handler before we cancel.
      await new Promise((r) => setTimeout(r, 100));
      agent.cancel();
      const events = await collect(agent.events);
      const last = events[events.length - 1];
      // SIGKILL can't be caught, so the process dies without emitting its
      // own terminal event — the adapter must synthesize an error.
      expect(last.type).toBe('error');
    } finally {
      delete process.env.FAKE_CODEX_HANG;
    }
  }, 10000);

  it('synthesizes a terminal done when the process exits 0 without a turn.completed', async () => {
    process.env.FAKE_CODEX_NODONE = '1';
    try {
      const agent = spawnCodex('do the thing', os.tmpdir(), { bin: fakeCodexPath });
      const events = await collect(agent.events);
      expect(events).toEqual([
        { type: 'started' },
        { type: 'command', command: 'ls', commandStatus: 'in_progress' },
        { type: 'message', text: 'Done listing files' },
        { type: 'done' },
      ]);
    } finally {
      delete process.env.FAKE_CODEX_NODONE;
    }
  });
});
