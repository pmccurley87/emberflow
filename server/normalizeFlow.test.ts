import { describe, expect, it } from 'vitest';
import { seedParamDefaults } from './normalizeFlow';
import type { WorkflowDefinition, WorkflowNode } from '../src/engine';

function inputNode(config: Record<string, unknown> = {}): WorkflowNode {
  return { id: 'input', type: 'Input', label: 'Input', position: { x: 0, y: 0 }, config };
}

function flow(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'f1',
    name: 'Flow',
    version: 1,
    nodes: [],
    edges: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...over,
  } as WorkflowDefinition;
}

describe('seedParamDefaults', () => {
  it('seeds only missing keys as "" and returns which were seeded', () => {
    const f = flow({
      http: { method: 'GET', path: '/api/channels/:id/approvals/:approvalId' },
      nodes: [inputNode({ defaults: { params: { id: 'c1' } } })],
    });
    const { flow: result, seeded } = seedParamDefaults(f);
    expect(seeded).toEqual(['approvalId']);
    const resultInput = result.nodes.find((n) => n.type === 'Input')!;
    expect((resultInput.config?.defaults as { params: Record<string, unknown> }).params).toEqual({
      id: 'c1',
      approvalId: '',
    });
  });

  it('never overwrites an existing value', () => {
    const f = flow({
      http: { method: 'GET', path: '/api/channels/:id' },
      nodes: [inputNode({ defaults: { params: { id: 'real-value' } } })],
    });
    const { flow: result, seeded } = seedParamDefaults(f);
    expect(seeded).toEqual([]);
    const resultInput = result.nodes.find((n) => n.type === 'Input')!;
    expect((resultInput.config?.defaults as { params: Record<string, unknown> }).params).toEqual({
      id: 'real-value',
    });
  });

  it('is a no-op without an Input node — returns seeded: [] and the same object', () => {
    const f = flow({ http: { method: 'GET', path: '/api/channels/:id' }, nodes: [] });
    const { flow: result, seeded } = seedParamDefaults(f);
    expect(seeded).toEqual([]);
    expect(result).toBe(f);
  });

  it('is a no-op without :params in the path — returns seeded: [] and the same object', () => {
    const f = flow({ http: { method: 'GET', path: '/api/channels' }, nodes: [inputNode()] });
    const { flow: result, seeded } = seedParamDefaults(f);
    expect(seeded).toEqual([]);
    expect(result).toBe(f);
  });

  it('is a no-op when every param already has a default — returns seeded: [] and the same object', () => {
    const f = flow({
      http: { method: 'GET', path: '/api/channels/:id' },
      nodes: [inputNode({ defaults: { params: { id: '' } } })],
    });
    const { flow: result, seeded } = seedParamDefaults(f);
    expect(seeded).toEqual([]);
    expect(result).toBe(f);
  });

  it('is a no-op when there is no http trigger at all', () => {
    const f = flow({ nodes: [inputNode()] });
    const { flow: result, seeded } = seedParamDefaults(f);
    expect(seeded).toEqual([]);
    expect(result).toBe(f);
  });
});
