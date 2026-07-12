import { describe, expect, it } from 'vitest';
import { createAnomalyFlows, createDetectEntireFlow } from './anomaly-flows';
import { createDefaultRegistry } from '../nodes';
import { startRun, validateFlow } from '../engine';

const registry = createDefaultRegistry(0);

describe('anomaly flows', () => {
  it('all five validate cleanly against the default registry', () => {
    const flows = createAnomalyFlows();
    expect(flows).toHaveLength(5);
    for (const flow of flows) {
      expect(validateFlow(flow, registry), flow.name).toEqual([]);
      expect(flow.folder).toBe('Anomaly API');
    }
  });

  it('detect-entire routes to composeIncident when the series carries an anomaly', async () => {
    const flow = createDetectEntireFlow();
    // Pin the live detection so no HTTP is needed; build still runs locally.
    const isAnomaly = Array.from({ length: 24 }, (_, i) => i === 20);
    const run = await startRun({
      flow,
      registry,
      pins: {
        detect: { isAnomaly, expectedValues: [], upperMargins: [], lowerMargins: [], period: 24 },
      },
    }).runToEnd();

    expect(run.status).toBe('succeeded');
    expect((run.nodeStates.cond.output as { $branch: string }).$branch).toBe('anomalous');
    expect(run.nodeStates.composeIncident.status).toBe('succeeded');
    expect(run.nodeStates.incidentResult.status).toBe('succeeded');
    expect(run.nodeStates.cleanResult.status).toBe('skipped');
  });

  it('detect-entire falls back to the clean branch when no anomalies are found', async () => {
    const flow = createDetectEntireFlow();
    const isAnomaly = Array.from({ length: 24 }, () => false);
    const run = await startRun({
      flow,
      registry,
      pins: {
        detect: { isAnomaly, expectedValues: [], upperMargins: [], lowerMargins: [], period: 24 },
      },
    }).runToEnd();

    expect(run.status).toBe('succeeded');
    expect((run.nodeStates.cond.output as { $branch: string }).$branch).toBe('clean');
    expect(run.nodeStates.cleanResult.status).toBe('succeeded');
    expect(run.nodeStates.composeIncident.status).toBe('skipped');
    expect(run.nodeStates.incidentResult.status).toBe('skipped');
  });

  it('quota flow reproduces the warning-email decision at 850/1000 calls', async () => {
    const flow = createAnomalyFlows().find((f) => f.id === 'anomaly-quota-emails')!;
    const run = await startRun({ flow, registry }).runToEnd();
    expect(run.status).toBe('succeeded');
    const result = run.nodeStates.result.output as { data: { action: string } };
    expect(result.data.action).toBe('warning');
  });

  it('key lifecycle flow fails with KEY_LIMIT_REACHED at 5 active keys', async () => {
    const flow = createAnomalyFlows().find((f) => f.id === 'anomaly-key-lifecycle')!;
    flow.nodes.find((n) => n.id === 'enforce')!.config.activeKeyCount = 5;
    const run = await startRun({ flow, registry }).runToEnd();
    expect(run.status).toBe('failed');
    expect(run.nodeStates.enforce.error).toContain('KEY_LIMIT_REACHED');
    expect(run.nodeStates.result.status).toBe('skipped');
  });

  it('key lifecycle flow issues a hashed ef_ak_ key under the limit', async () => {
    const flow = createAnomalyFlows().find((f) => f.id === 'anomaly-key-lifecycle')!;
    const run = await startRun({ flow, registry }).runToEnd();
    expect(run.status).toBe('succeeded');
    const generated = run.nodeStates.generate.output as { rawKey: string; keyPrefix: string; hash: string };
    expect(generated.rawKey).toMatch(/^ef_ak_[0-9a-f]{48}$/);
    expect(generated.keyPrefix).toBe(generated.rawKey.slice(0, 15));
    expect(generated.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
