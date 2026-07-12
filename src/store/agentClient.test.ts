import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelAgent, fetchAgentDiff, fetchAvailableAgents, revertAgent, startAgent } from './agentClient';
import type { AgentIntent } from './agentClient';

afterEach(() => vi.unstubAllGlobals());

const intent: AgentIntent = { action: 'edit-flow', flowId: 'f1', instruction: 'do the thing' };

describe('startAgent', () => {
  it('posts the intent and returns the agent run id', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ agentRunId: 'run-1' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const id = await startAgent(intent, { model: 'gpt-5' });

    expect(id).toBe('run-1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent, model: 'gpt-5' }),
      }),
    );
  });

  it('throws with the server error message on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad intent' }) })),
    );
    await expect(startAgent(intent)).rejects.toThrow('bad intent');
  });
});

describe('fetchAgentDiff', () => {
  it('returns the parsed diff body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ diff: 'diff --git', files: ['a.json'] }) })),
    );
    expect(await fetchAgentDiff('run-1')).toEqual({ diff: 'diff --git', files: ['a.json'] });
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Unknown agent run: run-1' }) })),
    );
    await expect(fetchAgentDiff('run-1')).rejects.toThrow('Unknown agent run: run-1');
  });
});

describe('revertAgent', () => {
  it('POSTs to revert and returns the reverted file list', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ reverted: ['flows/hello.json'] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await revertAgent('run-1')).toEqual({ reverted: ['flows/hello.json'] });
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/run-1/revert', { method: 'POST' });
  });
});

describe('fetchAvailableAgents', () => {
  it('returns the detected agent list with versions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ agents: [{ kind: 'codex', version: '0.142.5' }] }) })),
    );
    expect(await fetchAvailableAgents()).toEqual([{ kind: 'codex', version: '0.142.5' }]);
  });

  it('returns [] on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    expect(await fetchAvailableAgents()).toEqual([]);
  });

  it('returns [] when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await fetchAvailableAgents()).toEqual([]);
  });
});

describe('cancelAgent', () => {
  it('POSTs to cancel', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ cancelled: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await cancelAgent('run-1');
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/run-1/cancel', { method: 'POST' });
  });

  it('swallows fetch failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    await expect(cancelAgent('run-1')).resolves.toBeUndefined();
  });
});
