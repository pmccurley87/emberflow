import { describe, expect, it } from 'vitest';
import { deepSubsetMatch, evaluateExpectation } from './scenarioTest';
import type { WorkflowDefinition, WorkflowRun } from '../src/engine';

describe('deepSubsetMatch', () => {
  it('passes on equal primitives', () => {
    expect(deepSubsetMatch(1, 1)).toEqual([]);
    expect(deepSubsetMatch('a', 'a')).toEqual([]);
    expect(deepSubsetMatch(true, true)).toEqual([]);
  });

  it('fails on unequal primitives', () => {
    expect(deepSubsetMatch(1, 2)).toEqual(['expected 1, got 2']);
    expect(deepSubsetMatch('a', 'b')).toEqual(['expected "a", got "b"']);
  });

  it('passes when actual is a superset of a nested object', () => {
    const failures = deepSubsetMatch(
      { user: { name: 'Ada' } },
      { user: { name: 'Ada', age: 30 }, extra: true },
    );
    expect(failures).toEqual([]);
  });

  it('reports a dotted path for a missing/mismatched nested key', () => {
    const failures = deepSubsetMatch({ user: { name: 'Ada' } }, { user: { name: 'Bob' } });
    expect(failures).toEqual(['user.name: expected "Ada", got "Bob"']);
  });

  it('reports missing actual key', () => {
    const failures = deepSubsetMatch({ user: { name: 'Ada' } }, { user: {} });
    expect(failures).toEqual(['user.name: expected "Ada", got undefined']);
  });

  it('matches arrays index-wise on the expected prefix', () => {
    expect(deepSubsetMatch([1, 2], [1, 2, 3])).toEqual([]);
    expect(deepSubsetMatch([1, 2], [1])).toEqual(['[1]: expected 2, got undefined']);
    expect(deepSubsetMatch([1, 2], [1, 9])).toEqual(['[1]: expected 2, got 9']);
  });

  it('allows extra actual keys anywhere', () => {
    expect(deepSubsetMatch({ a: 1 }, { a: 1, b: 2, c: 3 })).toEqual([]);
  });

  it('null expected matches only null', () => {
    expect(deepSubsetMatch(null, null)).toEqual([]);
    expect(deepSubsetMatch(null, undefined)).toEqual(['expected null, got undefined']);
    expect(deepSubsetMatch(null, 0)).toEqual(['expected null, got 0']);
  });
});

function makeFlow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'flow-1',
    name: 'Flow 1',
    version: 1,
    nodes: [
      { id: 'response-200', type: 'Response', label: 'OK', position: { x: 0, y: 0 }, config: {} },
      { id: 'response-401', type: 'Response', label: 'Unauthorized', position: { x: 0, y: 0 }, config: {} },
    ],
    edges: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    workflowId: 'flow-1',
    status: 'succeeded',
    startedAt: new Date().toISOString(),
    nodeStates: {},
    ...overrides,
  };
}

describe('evaluateExpectation', () => {
  it('passes when status matches', () => {
    const flow = makeFlow();
    const run = makeRun({
      nodeStates: {
        'response-200': { status: 'succeeded', output: { status: 200, body: { ok: true } } },
      },
    });
    const result = evaluateExpectation(run, flow, { status: 200 });
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it('fails when status mismatches', () => {
    const flow = makeFlow();
    const run = makeRun({
      nodeStates: {
        'response-200': { status: 'succeeded', output: { status: 200, body: {} } },
      },
    });
    const result = evaluateExpectation(run, flow, { status: 401 });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['status: expected 401, got 200']);
  });

  it('fails and lists the dotted path when body is not a subset match', () => {
    const flow = makeFlow();
    const run = makeRun({
      nodeStates: {
        'response-200': {
          status: 'succeeded',
          output: { status: 200, body: { user: { name: 'Bob' } } },
        },
      },
    });
    const result = evaluateExpectation(run, flow, { body: { user: { name: 'Ada' } } });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['body.user.name: expected "Ada", got "Bob"']);
  });

  it('checks executedNodes against nodeStates, reporting skipped nodes', () => {
    const flow = makeFlow();
    const run = makeRun({
      nodeStates: {
        'response-200': { status: 'succeeded', output: { status: 200, body: {} } },
        'response-401': { status: 'skipped' },
      },
    });
    const result = evaluateExpectation(run, flow, { executedNodes: ['response-200', 'response-401'] });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['executedNodes: response-401 did not execute (status: skipped)']);
  });

  it('passes when status, body, and executedNodes all match', () => {
    const flow = makeFlow();
    const run = makeRun({
      nodeStates: {
        'response-200': {
          status: 'succeeded',
          output: { status: 200, body: { user: { name: 'Ada' } } },
        },
      },
    });
    const result = evaluateExpectation(run, flow, {
      status: 200,
      body: { user: { name: 'Ada' } },
      executedNodes: ['response-200'],
    });
    expect(result).toEqual({ ok: true, failures: [] });
  });
});
