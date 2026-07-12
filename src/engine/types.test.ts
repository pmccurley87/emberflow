import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition, HttpTrigger } from './types';

describe('WorkflowDefinition.http', () => {
  it('round-trips optional http metadata through JSON', () => {
    const http: HttpTrigger = { method: 'POST', path: '/claims', inputSchema: { type: 'object' } };
    const flow: WorkflowDefinition = {
      id: 'x', name: 'X', version: 1, nodes: [], edges: [], http,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    const back = JSON.parse(JSON.stringify(flow)) as WorkflowDefinition;
    expect(back.http).toEqual(http);
  });

  it('is optional — a flow without http is still valid', () => {
    const flow: WorkflowDefinition = {
      id: 'y', name: 'Y', version: 1, nodes: [], edges: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(flow.http).toBeUndefined();
  });
});
