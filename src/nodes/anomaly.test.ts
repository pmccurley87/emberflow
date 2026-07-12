import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRegistry } from './index';
import { startRun, type WorkflowDefinition } from '../engine';

const SERIES = [
  { timestamp: '2026-01-01T00:00:00.000Z', value: 100 },
  { timestamp: '2026-01-01T01:00:00.000Z', value: 105 },
];

function detectEntireFlow(config: Record<string, unknown>): WorkflowDefinition {
  return {
    id: 'detect-entire-test',
    name: 'Detect Entire (test)',
    version: 1,
    nodes: [
      {
        id: 'detect',
        type: 'DetectEntireSeries',
        label: 'Detect Entire Series',
        position: { x: 0, y: 0 },
        config: { series: SERIES, sensitivity: 80, ...config },
      },
    ],
    edges: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function stubFetch() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          isAnomaly: [false, false],
          expectedValues: [100, 105],
          upperMargins: [110, 115],
          lowerMargins: [90, 95],
          period: 24,
        }),
        text: async () => '',
      } as Response;
    }),
  );
  return calls;
}

describe('anomaly node key resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefers ctx.secrets.ANOMALY_API_KEY over config.apiKey', async () => {
    const calls = stubFetch();
    const registry = createDefaultRegistry(0);
    const run = await startRun({
      flow: detectEntireFlow({ apiKey: 'config-key' }),
      registry,
      secrets: { ANOMALY_API_KEY: 'secret-key' },
    }).runToEnd();

    expect(run.status).toBe('succeeded');
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['x-api-key']).toBe('secret-key');
  });

  it('falls back to config.apiKey when no secret is set', async () => {
    const calls = stubFetch();
    const registry = createDefaultRegistry(0);
    const run = await startRun({
      flow: detectEntireFlow({ apiKey: 'config-key' }),
      registry,
      secrets: {},
    }).runToEnd();

    expect(run.status).toBe('succeeded');
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['x-api-key']).toBe('config-key');
  });

  it('fails the node with "No API key" when neither secret nor config is set', async () => {
    stubFetch();
    const registry = createDefaultRegistry(0);
    const run = await startRun({
      flow: detectEntireFlow({}),
      registry,
      secrets: {},
    }).runToEnd();

    expect(run.status).toBe('failed');
    expect(run.nodeStates.detect.error).toBe('No API key: set secret ANOMALY_API_KEY or config apiKey');
  });
});
