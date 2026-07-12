// server/demoProject.test.ts
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProjectConfig } from './projectConfig';
import { buildFlowStore, buildRegistries } from './projectMode';
import { startRun } from '../src/engine';

const FIXTURE = resolve(__dirname, '../examples/demo-project');

describe('demo project (committed fixture)', () => {
  it('loads, registers TriageOrder, and every scenario runs green', async () => {
    const project = await loadProjectConfig(FIXTURE);
    expect(project).not.toBeNull();
    const store = buildFlowStore(project);
    const flow = store.load('order-triage')!;
    expect(flow.scenarios).toHaveLength(3);
    const { execution } = buildRegistries(project);
    const expected: Record<string, { tier: string; rush: boolean }> = {
      'standard-order': { tier: 'standard', rush: false },
      'priority-rush': { tier: 'priority', rush: true },
      vip: { tier: 'vip', rush: false },
    };
    for (const sc of flow.scenarios!) {
      const run = await startRun({ flow, registry: execution, input: sc.input }).runToEnd();
      expect(run.status).toBe('succeeded');
      expect(run.nodeStates.triage.output).toEqual(expected[sc.name]);
    }
  });
});
