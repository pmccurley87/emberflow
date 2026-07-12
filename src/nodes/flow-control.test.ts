import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './index';
import { startRun } from '../engine';
import type { LogLine, WorkflowDefinition, WorkflowRun } from '../engine';

const inputOnlyFlow = (): WorkflowDefinition => ({
  id: 'input-only',
  name: 'Input Only',
  version: 1,
  nodes: [
    {
      id: 'input',
      type: 'Input',
      label: 'Input',
      position: { x: 0, y: 0 },
      config: {
        fields: [
          { name: 'username', type: 'string', required: true },
          { name: 'password', type: 'string', required: true },
        ],
        defaults: { username: 'ada' },
      },
    },
  ],
  edges: [],
  createdAt: '2026-07-02T00:00:00Z',
  updatedAt: '2026-07-02T00:00:00Z',
});

describe('Input node', () => {
  it('fails listing the missing required field(s)', async () => {
    const run = await startRun({ flow: inputOnlyFlow(), registry: createDefaultRegistry(0) }).runToEnd();
    expect(run.status).toBe('failed');
    expect(run.nodeStates.input.error).toBe('Missing required input field(s): password');
  });

  it('merges the invocation payload over configured defaults', async () => {
    const run = await startRun({
      flow: inputOnlyFlow(),
      registry: createDefaultRegistry(0),
      input: { password: 'lovelace' },
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.input.output).toEqual({ username: 'ada', password: 'lovelace' });
  });
});

const environmentFlow = (): WorkflowDefinition => ({
  id: 'environment-only',
  name: 'Environment Only',
  version: 1,
  nodes: [
    { id: 'env', type: 'Environment', label: 'Environment', position: { x: 0, y: 0 }, config: {} },
  ],
  edges: [],
  createdAt: '2026-07-05T00:00:00Z',
  updatedAt: '2026-07-05T00:00:00Z',
});

describe('Environment node', () => {
  it('passes the run environment through to its output', async () => {
    const run = await startRun({
      flow: environmentFlow(),
      registry: createDefaultRegistry(0),
      environment: 'prod',
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.env.output).toEqual({ environment: 'prod', isProd: true });
  });

  it('defaults to "local" (isProd false) when the run carries no environment', async () => {
    const run = await startRun({
      flow: environmentFlow(),
      registry: createDefaultRegistry(0),
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.env.output).toEqual({ environment: 'local', isProd: false });
  });

  it('isProd is false for any non-prod environment name', async () => {
    const run = await startRun({
      flow: environmentFlow(),
      registry: createDefaultRegistry(0),
      environment: 'dev',
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.env.output).toEqual({ environment: 'dev', isProd: false });
  });
});

const conditionalFlow = (
  value: unknown,
  branches: unknown[],
  fallback?: string,
): WorkflowDefinition => ({
  id: 'conditional-only',
  name: 'Conditional Only',
  version: 1,
  nodes: [
    {
      id: 'cond',
      type: 'Conditional',
      label: 'Conditional',
      position: { x: 0, y: 0 },
      config: { value, branches, ...(fallback !== undefined ? { fallback } : {}) },
    },
  ],
  edges: [],
  createdAt: '2026-07-03T00:00:00Z',
  updatedAt: '2026-07-03T00:00:00Z',
});

async function runConditional(
  value: unknown,
  branches: unknown[],
  fallback?: string,
): Promise<{ run: WorkflowRun; logs: LogLine[] }> {
  const logs: LogLine[] = [];
  const run = await startRun({
    flow: conditionalFlow(value, branches, fallback),
    registry: createDefaultRegistry(0),
    events: { onLog: (line) => logs.push(line) },
  }).runToEnd();
  return { run, logs };
}

describe('Conditional node', () => {
  it('matches eq on strict equality', async () => {
    const { run } = await runConditional('active', [{ name: 'A', op: 'eq', value: 'active' }]);
    expect(run.nodeStates.cond.output).toEqual({ value: 'active', $branch: 'A' });
  });

  it('matches eq on numeric-looking values of different types', async () => {
    const { run } = await runConditional('3', [{ name: 'A', op: 'eq', value: 3 }]);
    expect(run.nodeStates.cond.output).toEqual({ value: '3', $branch: 'A' });
  });

  it('neq matches when values differ', async () => {
    const { run } = await runConditional('active', [{ name: 'A', op: 'neq', value: 'inactive' }]);
    expect(run.nodeStates.cond.output).toEqual({ value: 'active', $branch: 'A' });
  });

  it('neq does not match equal (numeric-looking) values', async () => {
    const { run } = await runConditional('3', [
      { name: 'A', op: 'neq', value: 3 },
      { name: 'B', op: 'eq', value: 3 },
    ]);
    expect(run.nodeStates.cond.output).toEqual({ value: '3', $branch: 'B' });
  });

  it('gt matches with Number() coercion', async () => {
    const { run } = await runConditional('5', [{ name: 'A', op: 'gt', value: 3 }]);
    expect(run.nodeStates.cond.output).toEqual({ value: '5', $branch: 'A' });
  });

  it('gte matches at the boundary', async () => {
    const { run } = await runConditional(3, [{ name: 'A', op: 'gte', value: 3 }]);
    expect(run.nodeStates.cond.output).toEqual({ value: 3, $branch: 'A' });
  });

  it('lt matches with Number() coercion', async () => {
    const { run } = await runConditional(1, [{ name: 'A', op: 'lt', value: 3 }]);
    expect(run.nodeStates.cond.output).toEqual({ value: 1, $branch: 'A' });
  });

  it('lte matches at the boundary', async () => {
    const { run } = await runConditional(3, [{ name: 'A', op: 'lte', value: 3 }]);
    expect(run.nodeStates.cond.output).toEqual({ value: 3, $branch: 'A' });
  });

  it('contains matches substrings on strings', async () => {
    const { run } = await runConditional('hello world', [{ name: 'A', op: 'contains', value: 'world' }]);
    expect(run.nodeStates.cond.output).toEqual({ value: 'hello world', $branch: 'A' });
  });

  it('contains matches membership on arrays', async () => {
    const { run } = await runConditional(['a', 'b'], [{ name: 'A', op: 'contains', value: 'b' }]);
    expect(run.nodeStates.cond.output).toEqual({ value: ['a', 'b'], $branch: 'A' });
  });

  it('contains does not match non-string, non-array input', async () => {
    const { run } = await runConditional(42, [
      { name: 'A', op: 'contains', value: 4 },
      { name: 'fallback', op: 'exists', value: undefined },
    ]);
    expect(run.nodeStates.cond.output).toEqual({ value: 42, $branch: 'fallback' });
  });

  it('exists matches defined, non-null input', async () => {
    const { run } = await runConditional(0, [{ name: 'A', op: 'exists' }]);
    expect(run.nodeStates.cond.output).toEqual({ value: 0, $branch: 'A' });
  });

  it('exists does not match null or undefined input', async () => {
    const { run } = await runConditional(null, [
      { name: 'A', op: 'exists' },
      { name: 'B', op: 'truthy' },
    ], 'clean');
    expect(run.nodeStates.cond.output).toEqual({ value: null, $branch: 'clean' });
  });

  it('truthy matches non-falsy input', async () => {
    const { run } = await runConditional('x', [{ name: 'A', op: 'truthy' }]);
    expect(run.nodeStates.cond.output).toEqual({ value: 'x', $branch: 'A' });
  });

  it('truthy does not match falsy input', async () => {
    const { run } = await runConditional(0, [{ name: 'A', op: 'truthy' }], 'clean');
    expect(run.nodeStates.cond.output).toEqual({ value: 0, $branch: 'clean' });
  });

  it('first matching rule wins, in order', async () => {
    const { run } = await runConditional(5, [
      { name: 'P1', op: 'gt', value: 3 },
      { name: 'P2', op: 'gt', value: 0 },
    ]);
    expect(run.nodeStates.cond.output).toEqual({ value: 5, $branch: 'P1' });
  });

  it('falls back to the configured fallback branch when no rule matches', async () => {
    const { run } = await runConditional(-1, [
      { name: 'P1', op: 'gt', value: 3 },
      { name: 'P2', op: 'gt', value: 0 },
    ], 'clean');
    expect(run.nodeStates.cond.output).toEqual({ value: -1, $branch: 'clean' });
  });

  it('fails when no rule matches and no fallback is configured', async () => {
    const { run } = await runConditional(-1, [{ name: 'P1', op: 'gt', value: 3 }]);
    expect(run.status).toBe('failed');
    expect(run.nodeStates.cond.error).toBe('Conditional: no rule matched and no fallback is set');
  });

  it('non-numeric input on a numeric op falls through to the fallback', async () => {
    const { run } = await runConditional('not-a-number', [
      { name: 'P1', op: 'gt', value: 3 },
    ], 'clean');
    expect(run.nodeStates.cond.output).toEqual({ value: 'not-a-number', $branch: 'clean' });
  });

  it('skips a malformed rule (missing name) with a warn log and keeps evaluating', async () => {
    const { run, logs } = await runConditional(5, [
      { op: 'gt', value: 3 },
      { name: 'P2', op: 'gt', value: 0 },
    ]);
    expect(run.nodeStates.cond.output).toEqual({ value: 5, $branch: 'P2' });
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('malformed rule'))).toBe(true);
  });

  it('skips a malformed rule (unknown op) with a warn log and keeps evaluating', async () => {
    const { run, logs } = await runConditional(5, [
      { name: 'P1', op: 'between', value: [0, 10] },
      { name: 'P2', op: 'gt', value: 0 },
    ]);
    expect(run.nodeStates.cond.output).toEqual({ value: 5, $branch: 'P2' });
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('malformed rule'))).toBe(true);
  });
});

describe('Conditional numeric-coercion guards', () => {
  it('eq 0 does not match null, empty string, or empty array', async () => {
    for (const input of [null, '', []]) {
      const { run } = await runConditional(
        input,
        [{ name: 'zero', op: 'eq', value: 0 }],
        'other',
      );
      expect(run.nodeStates.cond.output).toEqual({ value: input, $branch: 'other' });
    }
  });

  it('gt -1 does not match null', async () => {
    const { run } = await runConditional(
      null,
      [{ name: 'pos', op: 'gt', value: -1 }],
      'other',
    );
    expect(run.nodeStates.cond.output).toEqual({ value: null, $branch: 'other' });
  });
});
