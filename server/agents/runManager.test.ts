import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRunManager } from './runManager';
import type { AgentEvent } from './types';
import type { AgentIntent } from './prompt';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeCodexWriterPath = join(__dirname, '__fixtures__', 'fake-codex-writer.mjs');
const fakeClaudeWriterPath = join(__dirname, '__fixtures__', 'fake-claude-writer.mjs');

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

async function collectUntilDone(
  manager: AgentRunManager,
  id: string,
  timeoutMs = 5000,
): Promise<AgentEvent[]> {
  return new Promise((resolve, reject) => {
    const events: AgentEvent[] = [];
    const timer = setTimeout(() => reject(new Error('timed out waiting for done')), timeoutMs);
    const unsubscribe = manager.subscribe(id, (event) => {
      events.push(event);
      if (event.type === 'done' || event.type === 'error') {
        clearTimeout(timer);
        unsubscribe?.();
        resolve(events);
      }
    });
  });
}

describe('AgentRunManager', () => {
  let projectDir: string;
  let flowsDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'agent-run-manager-'));
    git(projectDir, ['init']);
    git(projectDir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init']);

    flowsDir = join(projectDir, 'flows');
    mkdirSync(flowsDir, { recursive: true });
    writeFileSync(join(flowsDir, 'hello.json'), JSON.stringify({ id: 'hello', name: 'Hello', nodes: [] }));
    git(projectDir, ['add', '-A']);
    git(projectDir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'add flow']);

    process.env.EMBERFLOW_CODEX_BIN = fakeCodexWriterPath;
  });

  afterEach(() => {
    delete process.env.EMBERFLOW_CODEX_BIN;
    rmSync(projectDir, { recursive: true, force: true });
  });

  const intent: AgentIntent = { action: 'edit-flow', flowId: 'hello', instruction: 'do a thing' };
  const pathOf = (id: string): string | undefined => (id === 'hello' ? 'hello' : undefined);

  it('starts a run, streams events to done, diffs the real change, and reverts it', async () => {
    const manager = new AgentRunManager(projectDir, flowsDir, pathOf);

    const id = manager.start(intent);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const events = await collectUntilDone(manager, id);
    expect(events[0]).toEqual({ type: 'started' });
    expect(events[events.length - 1].type).toBe('done');

    const { diff, files } = manager.diff(id)!;
    expect(files).toContain('flows/hello.json');
    expect(diff).toContain('agent was here');
    expect(readFileSync(join(projectDir, 'flows', 'hello.json'), 'utf8')).toBe('agent was here\n');

    const { reverted } = manager.revert(id)!;
    expect(reverted).toContain('flows/hello.json');
    expect(readFileSync(join(projectDir, 'flows', 'hello.json'), 'utf8')).not.toBe('agent was here\n');
  });

  it('rejects a second concurrent start while a run is active', async () => {
    const manager = new AgentRunManager(projectDir, flowsDir, pathOf);

    // Use a slow-ish fake so the first run is still "active" when we try the second.
    // fake-codex-writer exits synchronously fast, so start a run and immediately
    // try again before draining events — the manager must still consider it busy
    // until the run reaches a terminal state.
    manager.start(intent);
    expect(() => manager.start(intent)).toThrow(/busy|active/i);
  });

  it('rejects starting against a non-git project dir', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'agent-run-manager-nongit-'));
    try {
      const manager = new AgentRunManager(nonRepo, flowsDir, pathOf);
      expect(() => manager.start(intent)).toThrow(/not a git repo/i);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('rejects starting for an unknown flow', () => {
    const manager = new AgentRunManager(projectDir, flowsDir, pathOf);
    const badIntent: AgentIntent = { action: 'edit-flow', flowId: 'nope', instruction: 'x' };
    expect(() => manager.start(badIntent)).toThrow(/unknown flow/i);
  });

  it('allows a new run once the previous one has finished', async () => {
    const manager = new AgentRunManager(projectDir, flowsDir, pathOf);
    const id1 = manager.start(intent);
    await collectUntilDone(manager, id1);
    manager.revert(id1);

    const id2 = manager.start(intent);
    expect(id2).not.toBe(id1);
    await collectUntilDone(manager, id2);
  });

  it('cancel calls through to the adapter without throwing', async () => {
    const manager = new AgentRunManager(projectDir, flowsDir, pathOf);
    const id = manager.start(intent);
    expect(() => manager.cancel(id)).not.toThrow();
    await collectUntilDone(manager, id);
  });

  it('shutdown cancels the active run (and no-ops when idle)', async () => {
    const manager = new AgentRunManager(projectDir, flowsDir, pathOf);
    expect(() => manager.shutdown()).not.toThrow(); // idle: nothing active
    const id = manager.start(intent);
    expect(() => manager.shutdown()).not.toThrow();
    // The cancelled run must still reach a terminal state — no hung adapter.
    await collectUntilDone(manager, id);
  });

  it('rejects a flowId that tries to escape flowsDir', () => {
    const manager = new AgentRunManager(projectDir, flowsDir, pathOf);
    const badIntent: AgentIntent = { action: 'edit-flow', flowId: '../../etc/passwd', instruction: 'x' };
    expect(() => manager.start(badIntent)).toThrow(/invalid flowId/i);
  });

  it('rejects a flowId with a ".." segment even when mixed with safe segments', () => {
    const manager = new AgentRunManager(projectDir, flowsDir, pathOf);
    const badIntent: AgentIntent = { action: 'edit-flow', flowId: 'a/../b', instruction: 'x' };
    expect(() => manager.start(badIntent)).toThrow(/invalid flowId/i);
  });

  it('accepts an availableNodes getter and still starts/completes a run normally', async () => {
    const availableNodes = (): Array<{ type: string; label?: string; description?: string }> => [
      { type: 'Input' },
      { type: 'Response' },
      { type: 'FetchUser', label: 'Fetch User', description: 'Looks up a user by id.' },
    ];
    const manager = new AgentRunManager(projectDir, flowsDir, pathOf, availableNodes);

    const id = manager.start(intent);
    const events = await collectUntilDone(manager, id);
    expect(events[events.length - 1].type).toBe('done');
  });

  it('allows a slash-separated path-style flowId (operation ids are on-disk paths) to pass the id-safety check', () => {
    // billing/charge is a legitimate nested operation id — pathOf resolves it,
    // so start() must get past the id-safety check and fail later for an
    // unrelated reason (no such file), not with "invalid flowId".
    const nestedPathOf = (id: string): string | undefined => (id === 'billing/charge' ? 'billing/charge' : undefined);
    const manager = new AgentRunManager(projectDir, flowsDir, nestedPathOf);
    const nestedIntent: AgentIntent = { action: 'edit-flow', flowId: 'billing/charge', instruction: 'x' };
    expect(() => manager.start(nestedIntent)).not.toThrow(/invalid flowId/i);
  });

  it('prunes old terminal runs beyond the cap while keeping the active run', async () => {
    const manager = new AgentRunManager(projectDir, flowsDir, pathOf);

    const completedIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      const id = manager.start(intent);
      await collectUntilDone(manager, id);
      completedIds.push(id);
    }

    // The manager only prunes on the *next* start(), so start one more run
    // to trigger the sweep, then inspect via `has()` since there's no direct
    // size getter.
    const activeId = manager.start(intent);
    const remaining = [...completedIds, activeId].filter((id) => manager.has(id));
    // 20 terminal runs kept + the newly-started active run.
    expect(remaining.length).toBeLessThanOrEqual(21);
    expect(manager.has(activeId)).toBe(true);
    await collectUntilDone(manager, activeId);
  }, 20000);

  it('starts a new-operation run for a valid location without the unknown-flow check', async () => {
    const manager = new AgentRunManager(projectDir, flowsDir, pathOf);
    const newOpIntent: AgentIntent = {
      action: 'new-operation',
      location: 'billing',
      instruction: 'Let a customer request a refund.',
    };

    const id = manager.start(newOpIntent);
    expect(typeof id).toBe('string');

    const events = await collectUntilDone(manager, id);
    expect(events[0]).toEqual({ type: 'started' });
    expect(events[events.length - 1].type).toBe('done');
  });

  it('rejects a new-operation with a location that tries to escape apisDir', () => {
    const manager = new AgentRunManager(projectDir, flowsDir, pathOf);
    const badIntent: AgentIntent = {
      action: 'new-operation',
      location: '../../etc',
      instruction: 'x',
    };
    expect(() => manager.start(badIntent)).toThrow(/invalid location/i);
  });

  it('starts a cover-operation run for a known flowId, resolving relPath like edit-flow', async () => {
    const manager = new AgentRunManager(projectDir, flowsDir, pathOf);
    const coverIntent: AgentIntent = {
      action: 'cover-operation',
      flowId: 'hello',
      instruction: 'Cover every branch with scenarios.',
    };

    const id = manager.start(coverIntent);
    expect(typeof id).toBe('string');

    const events = await collectUntilDone(manager, id);
    expect(events[0]).toEqual({ type: 'started' });
    expect(events[events.length - 1].type).toBe('done');
  });

  it('rejects a cover-operation run for an unknown flow', () => {
    const manager = new AgentRunManager(projectDir, flowsDir, pathOf);
    const badIntent: AgentIntent = { action: 'cover-operation', flowId: 'nope', instruction: 'x' };
    expect(() => manager.start(badIntent)).toThrow(/unknown flow/i);
  });

  it('routes to spawnClaude when agent is "claude", using EMBERFLOW_CLAUDE_BIN', async () => {
    process.env.EMBERFLOW_CLAUDE_BIN = fakeClaudeWriterPath;
    try {
      const manager = new AgentRunManager(projectDir, flowsDir, pathOf);
      const id = manager.start(intent, { agent: 'claude' });

      const events = await collectUntilDone(manager, id);
      expect(events[0]).toEqual({ type: 'started' });
      expect(events[events.length - 1].type).toBe('done');

      const { files } = manager.diff(id)!;
      expect(files).toContain('flows/hello.json');
      expect(readFileSync(join(projectDir, 'flows', 'hello.json'), 'utf8')).toBe('agent was here\n');
    } finally {
      delete process.env.EMBERFLOW_CLAUDE_BIN;
    }
  });
});
