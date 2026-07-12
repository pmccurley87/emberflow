import { describe, expect, it } from 'vitest';
import { findScenario, scenarioNames } from './scenarios';
import type { WorkflowDefinition, WorkflowNode } from './types';

const node = (id: string, type = 'plain'): WorkflowNode => ({
  id, type, label: id, position: { x: 0, y: 0 }, config: {},
});

const flow = (scenarios?: WorkflowDefinition['scenarios']): WorkflowDefinition => ({
  id: 'f', name: 'f', version: 1, nodes: [node('a')], edges: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  ...(scenarios ? { scenarios } : {}),
});

describe('findScenario', () => {
  const scenarios = [
    { id: 's1', name: 'Happy path', input: { userId: 'u1' } },
    { id: 's2', name: 'Empty note', input: { userId: 'u2', note: '' } },
  ];

  it('finds a scenario by exact name', () => {
    const f = flow(scenarios);
    expect(findScenario(f, 'Happy path')).toEqual(scenarios[0]);
  });

  it('finds a scenario by id', () => {
    const f = flow(scenarios);
    expect(findScenario(f, 's2')).toEqual(scenarios[1]);
  });

  it('returns undefined when no scenario matches', () => {
    const f = flow(scenarios);
    expect(findScenario(f, 'nope')).toBeUndefined();
  });

  it('returns undefined when the flow has no scenarios array', () => {
    const f = flow();
    expect(findScenario(f, 'Happy path')).toBeUndefined();
  });
});

describe('scenarioNames', () => {
  it('lists names in order', () => {
    const f = flow([
      { id: 's1', name: 'Happy path', input: {} },
      { id: 's2', name: 'Empty note', input: {} },
    ]);
    expect(scenarioNames(f)).toEqual(['Happy path', 'Empty note']);
  });

  it('returns an empty array when the flow has no scenarios', () => {
    const f = flow();
    expect(scenarioNames(f)).toEqual([]);
  });
});
