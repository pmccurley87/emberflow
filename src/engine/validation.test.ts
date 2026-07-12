import { describe, expect, it } from 'vitest';
import { NodeRegistry } from './registry';
import { computeLoopRegions, topoSort, validateFlow } from './validation';
import type { WorkflowDefinition, WorkflowNode } from './types';

const registry = new NodeRegistry();
registry.register(
  {
    type: 'needy',
    label: 'Needy',
    inputSchema: { fields: [{ name: 'userId', type: 'string', required: true }] },
  },
  async () => ({}),
);
registry.register({ type: 'plain', label: 'Plain' }, async () => ({}));
registry.register({ type: 'writer', label: 'Writer', effects: 'mutation' }, async () => ({}));
registry.register({ type: 'Input', label: 'Input' }, async () => ({}));
registry.register({ type: 'ForEach', label: 'For Each' }, async () => ({}));
registry.register({ type: 'Collect', label: 'Collect' }, async () => ({}));
registry.register(
  { type: 'Subflow', label: 'Subflow', configSchema: { fields: [{ name: 'workflowId', type: 'string', required: true }] } },
  async () => ({}),
);

const node = (id: string, type = 'plain', extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id, type, label: id, position: { x: 0, y: 0 }, config: {}, ...extra,
});

const flow = (
  nodes: WorkflowNode[],
  edges: WorkflowDefinition['edges'],
  scenarios?: WorkflowDefinition['scenarios'],
): WorkflowDefinition => ({
  id: 'f', name: 'f', version: 1, nodes, edges,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  ...(scenarios ? { scenarios } : {}),
});

describe('validateFlow', () => {
  it('accepts a valid linear flow', () => {
    const f = flow([node('a'), node('b')], [{ id: 'e1', source: 'a', target: 'b' }]);
    expect(validateFlow(f, registry)).toEqual([]);
  });

  it('errors when a Subflow node names its own containing flow', () => {
    const f = flow([node('s', 'Subflow', { config: { workflowId: 'f' } })], []);
    const errors = validateFlow(f, registry).filter((i) => i.severity === 'error');
    expect(errors).toContainEqual({
      severity: 'error', nodeId: 's', message: 'subflow cannot call its own flow',
    });
  });

  it('accepts a Subflow node that names a different flow', () => {
    const f = flow([node('s', 'Subflow', { config: { workflowId: 'other' } })], []);
    const errors = validateFlow(f, registry).filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('flags unknown node types', () => {
    const f = flow([node('a', 'ghost')], []);
    expect(validateFlow(f, registry)).toContainEqual(
      expect.objectContaining({ severity: 'error', nodeId: 'a', message: expect.stringContaining('ghost') }),
    );
  });

  it('flags edges to missing nodes', () => {
    const f = flow([node('a')], [{ id: 'e1', source: 'a', target: 'zz' }]);
    expect(validateFlow(f, registry).some((i) => i.severity === 'error' && i.message.includes('zz'))).toBe(true);
  });

  it('flags cycles', () => {
    const f = flow(
      [node('a'), node('b')],
      [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }],
    );
    expect(validateFlow(f, registry).some((i) => i.message.includes('cycle'))).toBe(true);
  });

  it('flags inputMap pointing at a missing node', () => {
    const f = flow(
      [node('a', 'needy', { inputMap: { userId: { sourceNodeId: 'ghost', sourceField: 'x' } } })],
      [],
    );
    expect(validateFlow(f, registry).some((i) => i.severity === 'error' && i.message.includes('ghost'))).toBe(true);
  });

  it('accepts inputMap from an indirect upstream ancestor', () => {
    const f = flow(
      [node('a'), node('b'), node('c', 'needy', { inputMap: { userId: { sourceNodeId: 'a', sourceField: 'x' } } })],
      [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'c' }],
    );
    expect(validateFlow(f, registry)).toEqual([]);
  });

  it('warns when inputMap source is not upstream of the node', () => {
    const f = flow(
      [node('a'), node('b', 'needy', { inputMap: { userId: { sourceNodeId: 'a', sourceField: 'x' } } })],
      [],
    );
    expect(validateFlow(f, registry)).toContainEqual(
      expect.objectContaining({ severity: 'warning', nodeId: 'b', message: expect.stringContaining('not upstream') }),
    );
  });

  it('warns when a mapping targets a field the node does not declare', () => {
    const f = flow(
      [node('a'), node('b', 'plain', { inputMap: { ghost: { sourceNodeId: 'a', sourceField: 'x' } } })],
      [{ id: 'e1', source: 'a', target: 'b' }],
    );
    expect(validateFlow(f, registry)).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        nodeId: 'b',
        message: expect.stringContaining('not declared'),
      }),
    );
  });

  it('warns on unmapped required input', () => {
    const f = flow([node('a', 'needy')], []);
    expect(validateFlow(f, registry)).toContainEqual(
      expect.objectContaining({ severity: 'warning', nodeId: 'a', message: expect.stringContaining('userId') }),
    );
  });

  it('does not warn when required input satisfied by config', () => {
    const f = flow([node('a', 'needy', { config: { userId: 'u1' } })], []);
    expect(validateFlow(f, registry)).toEqual([]);
  });

  it('warns for each mutation-declared node with the dry-run message', () => {
    const f = flow(
      [node('w1', 'writer'), node('w2', 'writer'), node('r', 'plain')],
      [{ id: 'e1', source: 'w1', target: 'w2' }, { id: 'e2', source: 'w2', target: 'r' }],
    );
    const issues = validateFlow(f, registry);
    const mutationWarnings = issues.filter((i) => i.message.includes('performs writes'));
    expect(mutationWarnings).toHaveLength(2);
    expect(mutationWarnings).toContainEqual({
      severity: 'warning',
      nodeId: 'w1',
      message: 'Mutation node "w1" performs writes — dry-run under safe mode',
    });
  });

  it('does not warn for read nodes', () => {
    const f = flow([node('a', 'plain')], []);
    expect(validateFlow(f, registry).some((i) => i.message.includes('performs writes'))).toBe(false);
  });
});

describe('validateFlow scenarios', () => {
  const inputNode = (extra: Partial<WorkflowNode> = {}) =>
    node('input', 'Input', {
      config: {
        fields: [
          { name: 'userId', type: 'string', required: true },
          { name: 'note', type: 'string' },
        ],
        defaults: { userId: 'u1' },
      },
      ...extra,
    });

  it('accepts a valid scenario against an Input node with no warnings', () => {
    const f = flow([inputNode()], [], [
      { id: 's1', name: 'Happy path', input: { userId: 'u2', note: 'hi' } },
    ]);
    expect(validateFlow(f, registry)).toEqual([]);
  });

  it('warns when a scenario omits a required field with no default', () => {
    const withoutDefault = node('input', 'Input', {
      config: {
        fields: [{ name: 'userId', type: 'string', required: true }],
        defaults: {},
      },
    });
    const f = flow([withoutDefault], [], [{ id: 's1', name: 'Missing', input: {} }]);
    expect(validateFlow(f, registry)).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        nodeId: 'input',
        message: expect.stringMatching(/Missing.*userId/),
      }),
    );
  });

  it('does not warn when a required field is satisfied by defaults', () => {
    const f = flow([inputNode()], [], [{ id: 's1', name: 'Uses default', input: {} }]);
    expect(validateFlow(f, registry)).toEqual([]);
  });

  it('warns when a scenario provides an undeclared input field', () => {
    const f = flow([inputNode()], [], [
      { id: 's1', name: 'Extra', input: { userId: 'u2', bogus: true } },
    ]);
    expect(validateFlow(f, registry)).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        nodeId: 'input',
        message: expect.stringMatching(/Extra.*bogus/),
      }),
    );
  });

  it('warns exactly once when scenarios exist but there is no Input node', () => {
    const f = flow([node('a')], [], [{ id: 's1', name: 'Orphan', input: { x: 1 } }]);
    const warnings = validateFlow(f, registry).filter((i) => i.message.includes('no Input node'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual(
      expect.objectContaining({ severity: 'warning' }),
    );
  });
});

describe('topoSort', () => {
  it('orders dependencies first', () => {
    const f = flow(
      [node('c'), node('a'), node('b')],
      [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'c' }],
    );
    expect(topoSort(f)).toEqual(['a', 'b', 'c']);
  });

  it('throws on cycles', () => {
    const f = flow(
      [node('a'), node('b')],
      [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }],
    );
    expect(() => topoSort(f)).toThrow('Flow contains a cycle');
  });
});

describe('ForEach/Collect loop regions', () => {
  const region = () =>
    flow(
      [node('fe', 'ForEach'), node('body', 'plain'), node('col', 'Collect')],
      [
        { id: 'e1', source: 'fe', target: 'body' },
        { id: 'e2', source: 'body', target: 'col' },
      ],
    );

  it('accepts a valid ForEach → body → Collect region with no errors', () => {
    expect(validateFlow(region(), registry)).toEqual([]);
  });

  it('computeLoopRegions returns the correct bodyIds for a valid region', () => {
    expect(computeLoopRegions(region())).toEqual([
      { forEachId: 'fe', collectId: 'col', bodyIds: ['body'] },
    ]);
  });

  it('flags a ForEach with no Collect among its descendants', () => {
    const f = flow([node('fe', 'ForEach'), node('body', 'plain')], [{ id: 'e1', source: 'fe', target: 'body' }]);
    expect(validateFlow(f, registry)).toContainEqual(
      expect.objectContaining({ severity: 'error', nodeId: 'fe', message: expect.stringContaining('no Collect') }),
    );
    expect(computeLoopRegions(f)).toEqual([]);
  });

  it('flags a ForEach with two Collect descendants', () => {
    const f = flow(
      [node('fe', 'ForEach'), node('c1', 'Collect'), node('c2', 'Collect')],
      [{ id: 'e1', source: 'fe', target: 'c1' }, { id: 'e2', source: 'fe', target: 'c2' }],
    );
    expect(validateFlow(f, registry)).toContainEqual(
      expect.objectContaining({ severity: 'error', nodeId: 'fe', message: expect.stringContaining('multiple Collect') }),
    );
    expect(computeLoopRegions(f)).toEqual([]);
  });

  it('flags a Collect with no ForEach among its ancestors', () => {
    const f = flow([node('body', 'plain'), node('col', 'Collect')], [{ id: 'e1', source: 'body', target: 'col' }]);
    expect(validateFlow(f, registry)).toContainEqual(
      expect.objectContaining({ severity: 'error', nodeId: 'col', message: expect.stringContaining('no ForEach') }),
    );
  });

  it('flags a leaking edge out of the loop region', () => {
    const f = flow(
      [node('fe', 'ForEach'), node('body', 'plain'), node('col', 'Collect'), node('outside', 'plain')],
      [
        { id: 'e1', source: 'fe', target: 'body' },
        { id: 'e2', source: 'body', target: 'col' },
        { id: 'e3', source: 'body', target: 'outside' },
      ],
    );
    expect(validateFlow(f, registry)).toContainEqual(
      expect.objectContaining({ severity: 'error', nodeId: 'body', message: expect.stringContaining('e3') }),
    );
    expect(computeLoopRegions(f)).toEqual([]);
  });

  it('flags nested ForEach regions', () => {
    const f = flow(
      [
        node('fe1', 'ForEach'),
        node('fe2', 'ForEach'),
        node('col2', 'Collect'),
        node('col1', 'Collect'),
      ],
      [
        { id: 'e1', source: 'fe1', target: 'fe2' },
        { id: 'e2', source: 'fe2', target: 'col2' },
        { id: 'e3', source: 'col2', target: 'col1' },
      ],
    );
    const issues = validateFlow(f, registry);
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('Nested ForEach'))).toBe(true);
    expect(computeLoopRegions(f)).toEqual([]);
  });
});
