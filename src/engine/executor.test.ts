import { describe, expect, it } from 'vitest';
import { NodeRegistry } from './registry';
import { InMemoryTraceSink } from './trace';
import { explainUndefinedRead, getByPath, startRun } from './executor';
import { registerLoopNodes } from '../nodes/loops';
import { registerFlowControlNodes } from '../nodes/flow-control';
import type { LogLine, NodeRunState, WorkflowDefinition, WorkflowNode } from './types';

function makeRegistry(): NodeRegistry {
  const r = new NodeRegistry();
  r.register(
    { type: 'emit', label: 'Emit', configSchema: { fields: [{ name: 'value', type: 'string' }] } },
    async (ctx) => ({ value: ctx.config.value, nested: { deep: 'gold' } }),
  );
  r.register(
    { type: 'echo', label: 'Echo', inputSchema: { fields: [{ name: 'value', type: 'string', required: true }] } },
    async (ctx) => {
      ctx.log('info', `echoing ${String(ctx.input.value)}`);
      return { echoed: ctx.input.value };
    },
  );
  r.register({ type: 'boom', label: 'Boom' }, async () => {
    throw new Error('kaboom');
  });
  return r;
}

const node = (id: string, type: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id, type, label: id, position: { x: 0, y: 0 }, config: {}, ...extra,
});

const flow = (nodes: WorkflowNode[], edges: WorkflowDefinition['edges']): WorkflowDefinition => ({
  id: 'f', name: 'f', version: 1, nodes, edges,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});

const deterministic = () => {
  let i = 0;
  return { now: () => '2026-01-01T00:00:00Z', newId: () => `id-${++i}` };
};

const linearFlow = () =>
  flow(
    [
      node('a', 'emit', { config: { value: 'hi' } }),
      node('b', 'echo', { inputMap: { value: { sourceNodeId: 'a', sourceField: 'value' } } }),
    ],
    [{ id: 'e1', source: 'a', target: 'b' }],
  );

describe('getByPath', () => {
  it('resolves dot paths and $', () => {
    expect(getByPath({ a: { b: 1 } }, 'a.b')).toBe(1);
    expect(getByPath({ a: 1 }, '$')).toEqual({ a: 1 });
    expect(getByPath({ a: 1 }, 'zz.yy')).toBeUndefined();
  });
});

describe('executor', () => {
  it('runs a linear flow and maps outputs to inputs', async () => {
    const handle = startRun({ flow: linearFlow(), registry: makeRegistry(), ...deterministic() });
    const run = await handle.runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.b.output).toEqual({ echoed: 'hi' });
    expect(run.nodeStates.b.input).toEqual({ value: 'hi' });
  });

  it('steps one node at a time', async () => {
    const handle = startRun({ flow: linearFlow(), registry: makeRegistry(), ...deterministic() });
    expect(handle.run.nodeStates.a.status).toBe('queued');
    expect(await handle.step()).toBe(true);
    expect(handle.run.nodeStates.a.status).toBe('succeeded');
    expect(handle.run.nodeStates.b.status).toBe('queued');
    expect(await handle.step()).toBe(false);
    expect(handle.run.status).toBe('succeeded');
  });

  it('supports $ whole-output mapping and dot paths', async () => {
    const f = flow(
      [
        node('a', 'emit', { config: { value: 'hi' } }),
        node('b', 'echo', { inputMap: { value: { sourceNodeId: 'a', sourceField: 'nested.deep' } } }),
      ],
      [{ id: 'e1', source: 'a', target: 'b' }],
    );
    const run = await startRun({ flow: f, registry: makeRegistry(), ...deterministic() }).runToEnd();
    expect(run.nodeStates.b.output).toEqual({ echoed: 'gold' });
  });

  it('falls back to config for unmapped schema inputs', async () => {
    const f = flow([node('a', 'echo', { config: { value: 'from-config' } })], []);
    const run = await startRun({ flow: f, registry: makeRegistry(), ...deterministic() }).runToEnd();
    expect(run.nodeStates.a.output).toEqual({ echoed: 'from-config' });
  });

  it('fails the run and skips downstream on node error', async () => {
    const f = flow(
      [node('a', 'boom'), node('b', 'emit')],
      [{ id: 'e1', source: 'a', target: 'b' }],
    );
    const run = await startRun({ flow: f, registry: makeRegistry(), ...deterministic() }).runToEnd();
    expect(run.status).toBe('failed');
    expect(run.nodeStates.a.status).toBe('failed');
    expect(run.nodeStates.a.error).toBe('kaboom');
    expect(run.nodeStates.b.status).toBe('skipped');
  });

  it('cancel skips remaining nodes', async () => {
    const handle = startRun({ flow: linearFlow(), registry: makeRegistry(), ...deterministic() });
    await handle.step();
    handle.cancel();
    expect(handle.run.status).toBe('cancelled');
    expect(handle.run.nodeStates.b.status).toBe('skipped');
    expect(await handle.step()).toBe(false);
  });

  it('records a trace sample per executed node, including failures', async () => {
    const trace = new InMemoryTraceSink();
    const f = flow(
      [node('a', 'emit', { config: { value: 'x' } }), node('b', 'boom')],
      [{ id: 'e1', source: 'a', target: 'b' }],
    );
    await startRun({ flow: f, registry: makeRegistry(), trace, ...deterministic() }).runToEnd();
    expect(trace.all()).toHaveLength(2);
    expect(trace.samplesFor('b')[0].status).toBe('failed');
  });

  it('emits logs and state-change events', async () => {
    const logs: LogLine[] = [];
    const changes: Array<[string, NodeRunState['status']]> = [];
    await startRun({
      flow: linearFlow(),
      registry: makeRegistry(),
      events: {
        onLog: (l) => logs.push(l),
        onNodeStateChange: (id, s) => changes.push([id, s.status]),
      },
      ...deterministic(),
    }).runToEnd();
    expect(logs.some((l) => l.nodeId === 'b' && l.message === 'echoing hi')).toBe(true);
    expect(changes).toContainEqual(['b', 'running']);
    expect(changes).toContainEqual(['b', 'succeeded']);
  });

  it('does not emit events during construction', () => {
    const changes: string[] = [];
    startRun({
      flow: linearFlow(),
      registry: makeRegistry(),
      events: { onNodeStateChange: (id) => changes.push(id) },
      ...deterministic(),
    });
    expect(changes).toEqual([]);
  });

  it('refuses to start an invalid flow', () => {
    const f = flow([node('a', 'ghost')], []);
    expect(() => startRun({ flow: f, registry: makeRegistry(), ...deterministic() })).toThrow(/Invalid flow/);
  });

  it('routes: only the taken branch executes, other branches are skipped', async () => {
    const r = makeRegistry();
    r.register({ type: 'router', label: 'Router' }, async (ctx) => ({
      ...ctx.input,
      $branch: 'left',
    }));
    r.register({ type: 'probe', label: 'Probe' }, async (ctx) => ({ hit: ctx.config.tag }));
    const f = flow(
      [
        node('r', 'router'),
        node('l', 'probe', { config: { tag: 'L' } }),
        node('x', 'probe', { config: { tag: 'X' } }),
        node('afterL', 'probe', { config: { tag: 'AL' } }),
        node('afterX', 'probe', { config: { tag: 'AX' } }),
      ],
      [
        { id: 'e1', source: 'r', target: 'l', sourceHandle: 'left' },
        { id: 'e2', source: 'r', target: 'x', sourceHandle: 'right' },
        { id: 'e3', source: 'l', target: 'afterL' },
        { id: 'e4', source: 'x', target: 'afterX' },
      ],
    );
    const run = await startRun({ flow: f, registry: r, ...deterministic() }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.l.status).toBe('succeeded');
    expect(run.nodeStates.x.status).toBe('skipped');
    expect(run.nodeStates.afterL.status).toBe('succeeded');
    expect(run.nodeStates.afterX.status).toBe('skipped');
  });

  it('routes: a dead branch edge gates a node even when a data edge is live', async () => {
    // Branch edges are guards: a node sitting on an untaken branch must be
    // skipped even if a plain data edge from an always-executed ancestor is
    // live — otherwise the data edge smuggles it past the gate.
    const r = makeRegistry();
    r.register({ type: 'router', label: 'Router' }, async () => ({ $branch: 'taken' }));
    r.register({ type: 'probe', label: 'Probe' }, async () => ({ ok: true }));
    const f = flow(
      [node('src', 'probe'), node('r', 'router'), node('gated', 'probe')],
      [
        { id: 'e0', source: 'src', target: 'r' },
        { id: 'e1', source: 'r', target: 'gated', sourceHandle: 'untaken' },
        { id: 'e2', source: 'src', target: 'gated' },
      ],
    );
    const run = await startRun({ flow: f, registry: r, ...deterministic() }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.gated.status).toBe('skipped');
  });

  it('routes: node with one live and one skipped parent still executes', async () => {
    const r = makeRegistry();
    r.register({ type: 'router', label: 'Router' }, async () => ({ $branch: 'a' }));
    r.register({ type: 'probe', label: 'Probe' }, async () => ({ ok: true }));
    const f = flow(
      [node('r', 'router'), node('a', 'probe'), node('b', 'probe'), node('join', 'probe')],
      [
        { id: 'e1', source: 'r', target: 'a', sourceHandle: 'a' },
        { id: 'e2', source: 'r', target: 'b', sourceHandle: 'b' },
        { id: 'e3', source: 'a', target: 'join' },
        { id: 'e4', source: 'b', target: 'join' },
      ],
    );
    const run = await startRun({ flow: f, registry: r, ...deterministic() }).runToEnd();
    expect(run.nodeStates.b.status).toBe('skipped');
    expect(run.nodeStates.join.status).toBe('succeeded');
  });

  it('exposes the run input to node implementations, defaulting to {}', async () => {
    const registry = makeRegistry();
    registry.register(
      { type: 'reads-input', label: 'Reads Input' },
      async (ctx) => ({ got: ctx.runInput.city }),
    );
    const f = flow([node('a', 'reads-input')], []);
    const withInput = await startRun({
      flow: f, registry, input: { city: 'Belfast' }, ...deterministic(),
    }).runToEnd();
    expect(withInput.nodeStates.a.output).toEqual({ got: 'Belfast' });

    const without = await startRun({ flow: f, registry, ...deterministic() }).runToEnd();
    expect(without.nodeStates.a.output).toEqual({ got: undefined });
  });

  it('resolves {"$secret": NAME} config values before execution', async () => {
    const registry = makeRegistry();
    registry.register(
      { type: 'uses-key', label: 'Uses Key' },
      async (ctx) => ({ key: ctx.config.apiKey }),
    );
    const f = flow([node('a', 'uses-key', { config: { apiKey: { $secret: 'API_KEY' } } })], []);
    const run = await startRun({
      flow: f, registry, secrets: { API_KEY: 'shh' }, ...deterministic(),
    }).runToEnd();
    expect(run.nodeStates.a.output).toEqual({ key: 'shh' });
  });

  it('fails the node when a referenced secret is missing', async () => {
    const registry = makeRegistry();
    registry.register({ type: 'uses-key', label: 'Uses Key' }, async (ctx) => ({ key: ctx.config.apiKey }));
    const f = flow([node('a', 'uses-key', { config: { apiKey: { $secret: 'NOPE' } } })], []);
    const run = await startRun({ flow: f, registry, ...deterministic() }).runToEnd();
    expect(run.status).toBe('failed');
    expect(run.nodeStates.a.error).toContain('Missing secret: NOPE');
  });

  it('passes runner-supplied secrets to node implementations, defaulting to {}', async () => {
    const registry = makeRegistry();
    registry.register(
      { type: 'reads-secret', label: 'Reads Secret' },
      async (ctx) => ({ got: ctx.secrets.FOO }),
    );
    const f = flow([node('a', 'reads-secret')], []);

    const withSecrets = await startRun({
      flow: f, registry, secrets: { FOO: 'bar' }, ...deterministic(),
    }).runToEnd();
    expect(withSecrets.nodeStates.a.output).toEqual({ got: 'bar' });

    const withoutSecrets = await startRun({ flow: f, registry, ...deterministic() }).runToEnd();
    expect(withoutSecrets.status).toBe('succeeded');
    expect(withoutSecrets.nodeStates.a.output).toEqual({ got: undefined });
  });
});

describe('environments and safe mode', () => {
  it('exposes ctx.vars and ctx.safeMode to node implementations, defaulting to {} and false', async () => {
    const registry = makeRegistry();
    registry.register(
      { type: 'reads-ctx', label: 'Reads Ctx' },
      async (ctx) => ({ base: ctx.vars.API_BASE, safe: ctx.safeMode }),
    );
    const f = flow([node('a', 'reads-ctx')], []);

    const withEnv = await startRun({
      flow: f, registry, vars: { API_BASE: 'http://x' }, safeMode: true, ...deterministic(),
    }).runToEnd();
    expect(withEnv.nodeStates.a.output).toEqual({ base: 'http://x', safe: true });

    const without = await startRun({ flow: f, registry, ...deterministic() }).runToEnd();
    expect(without.nodeStates.a.output).toEqual({ base: undefined, safe: false });
  });

  it('records environment and safeMode on the run at start', () => {
    const handle = startRun({
      flow: linearFlow(), registry: makeRegistry(),
      environment: 'prod', safeMode: true, ...deterministic(),
    });
    expect(handle.run.environment).toBe('prod');
    expect(handle.run.safeMode).toBe(true);
  });

  it('resolves {"$env": NAME} config values from vars', async () => {
    const registry = makeRegistry();
    registry.register(
      { type: 'uses-url', label: 'Uses Url' },
      async (ctx) => ({ url: ctx.config.apiUrl }),
    );
    const f = flow([node('a', 'uses-url', { config: { apiUrl: { $env: 'API_URL' } } })], []);
    const run = await startRun({
      flow: f, registry, vars: { API_URL: 'http://host' }, ...deterministic(),
    }).runToEnd();
    expect(run.nodeStates.a.output).toEqual({ url: 'http://host' });
  });

  it('fails the node when a referenced $env var is missing', async () => {
    const registry = makeRegistry();
    registry.register({ type: 'uses-url', label: 'Uses Url' }, async (ctx) => ({ url: ctx.config.apiUrl }));
    const f = flow([node('a', 'uses-url', { config: { apiUrl: { $env: 'NOPE' } } })], []);
    const run = await startRun({ flow: f, registry, ...deterministic() }).runToEnd();
    expect(run.status).toBe('failed');
    expect(run.nodeStates.a.error).toContain('Missing environment variable: NOPE');
  });

  it('resolves {"$env": NAME} deep inside config values, nested objects and arrays included', async () => {
    const registry = makeRegistry();
    registry.register(
      { type: 'uses-defaults', label: 'Uses Defaults' },
      async (ctx) => ({ got: ctx.config.defaults }),
    );
    const f = flow(
      [
        node('a', 'uses-defaults', {
          config: {
            defaults: {
              projectId: { $env: 'SEED' },
              nested: { deep: { token: { $env: 'TOKEN' } } },
              list: [{ id: { $env: 'SEED' } }, 'plain'],
            },
          },
        }),
      ],
      [],
    );
    const run = await startRun({
      flow: f, registry, vars: { SEED: 'seed-1', TOKEN: 'tok-2' }, ...deterministic(),
    }).runToEnd();
    expect(run.nodeStates.a.output).toEqual({
      got: {
        projectId: 'seed-1',
        nested: { deep: { token: 'tok-2' } },
        list: [{ id: 'seed-1' }, 'plain'],
      },
    });
  });

  it('fails the node when a nested $env ref in config is missing', async () => {
    const registry = makeRegistry();
    registry.register(
      { type: 'uses-defaults', label: 'Uses Defaults' },
      async (ctx) => ({ got: ctx.config.defaults }),
    );
    const f = flow(
      [node('a', 'uses-defaults', { config: { defaults: { nested: { id: { $env: 'MISSING' } } } } })],
      [],
    );
    const run = await startRun({ flow: f, registry, ...deterministic() }).runToEnd();
    expect(run.status).toBe('failed');
    expect(run.nodeStates.a.error).toContain('Missing environment variable: MISSING');
  });

  it('keeps {"$secret": NAME} top-level-only in config, even nested inside an object', async () => {
    const registry = makeRegistry();
    registry.register(
      { type: 'uses-defaults', label: 'Uses Defaults' },
      async (ctx) => ({ got: ctx.config.defaults }),
    );
    const f = flow(
      [node('a', 'uses-defaults', { config: { defaults: { nested: { apiKey: { $secret: 'API_KEY' } } } } })],
      [],
    );
    const run = await startRun({
      flow: f, registry, secrets: { API_KEY: 'shh' }, ...deterministic(),
    }).runToEnd();
    // Nested $secret is not a config-level ref: it passes through untouched
    // (secrets stay top-level only, unlike $env).
    expect(run.nodeStates.a.output).toEqual({ got: { nested: { apiKey: { $secret: 'API_KEY' } } } });
  });

  it('resolves {"$env": NAME} deep inside the run-input payload, arrays included', async () => {
    const registry = makeRegistry();
    registry.register(
      { type: 'reads-input', label: 'Reads Input' },
      async (ctx) => ({ got: ctx.runInput }),
    );
    const f = flow([node('a', 'reads-input')], []);
    const run = await startRun({
      flow: f,
      registry,
      vars: { SEED: 'seed-1', TOKEN: 'tok-2' },
      input: {
        projectId: { $env: 'SEED' },
        nested: { deep: { token: { $env: 'TOKEN' } } },
        list: [{ id: { $env: 'SEED' } }, 'plain'],
      },
      ...deterministic(),
    }).runToEnd();
    expect(run.nodeStates.a.output).toEqual({
      got: {
        projectId: 'seed-1',
        nested: { deep: { token: 'tok-2' } },
        list: [{ id: 'seed-1' }, 'plain'],
      },
    });
  });

  it('fails run start when a $env var in the run-input payload is missing', () => {
    const registry = makeRegistry();
    registry.register({ type: 'reads-input', label: 'Reads Input' }, async (ctx) => ctx.runInput);
    const f = flow([node('a', 'reads-input')], []);
    expect(() =>
      startRun({ flow: f, registry, input: { projectId: { $env: 'MISSING' } }, ...deterministic() }),
    ).toThrow('Missing environment variable: MISSING');
  });

  it('sets mutationBlocked when a mutation node completes under safe mode', async () => {
    const registry = makeRegistry();
    registry.register(
      { type: 'writer', label: 'Writer', effects: 'mutation' },
      async () => ({ committed: false }),
    );
    const f = flow([node('a', 'writer')], []);

    const safe = await startRun({ flow: f, registry, safeMode: true, ...deterministic() }).runToEnd();
    expect(safe.nodeStates.a.status).toBe('succeeded');
    expect(safe.nodeStates.a.mutationBlocked).toBe(true);

    const live = await startRun({ flow: f, registry, safeMode: false, ...deterministic() }).runToEnd();
    expect(live.nodeStates.a.mutationBlocked).toBeUndefined();
  });

  it('does not set mutationBlocked on a read node under safe mode', async () => {
    const registry = makeRegistry();
    const f = flow([node('a', 'emit', { config: { value: 'x' } })], []);
    const run = await startRun({ flow: f, registry, safeMode: true, ...deterministic() }).runToEnd();
    expect(run.nodeStates.a.mutationBlocked).toBeUndefined();
  });

  it('sets mutationBlocked on a mutation node inside a loop body under safe mode', async () => {
    const registry = makeRegistry();
    registerLoopNodes(registry);
    registry.register(
      { type: 'writer', label: 'Writer', effects: 'mutation' },
      async (ctx) => ({ n: ctx.input.n }),
    );
    const f = flow(
      [
        node('fe', 'ForEach', { config: { items: [1, 2] } }),
        node('body', 'writer', { inputMap: { n: { sourceNodeId: 'fe', sourceField: 'item' } } }),
        node('col', 'Collect', { inputMap: { value: { sourceNodeId: 'body', sourceField: 'n' } } }),
      ],
      [
        { id: 'e1', source: 'fe', target: 'body' },
        { id: 'e2', source: 'body', target: 'col' },
      ],
    );
    const run = await startRun({ flow: f, registry, safeMode: true, ...deterministic() }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.body.mutationBlocked).toBe(true);
  });
});

describe('pinning', () => {
  it('does not call the implementation for a pinned node', async () => {
    const registry = makeRegistry();
    registry.register(
      { type: 'never-run', label: 'Never Run' },
      async () => {
        throw new Error('should not run');
      },
    );
    const f = flow([node('a', 'never-run')], []);
    const run = await startRun({
      flow: f, registry, pins: { a: { ok: true } }, ...deterministic(),
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.a.output).toEqual({ ok: true });
  });

  it('feeds downstream mapping from the pinned output', async () => {
    const run = await startRun({
      flow: linearFlow(),
      registry: makeRegistry(),
      pins: { a: { value: 'pinned!' } },
      ...deterministic(),
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.b.output).toEqual({ echoed: 'pinned!' });
  });

  it('records no trace sample for a pinned node but does for downstream executed nodes', async () => {
    const trace = new InMemoryTraceSink();
    await startRun({
      flow: linearFlow(),
      registry: makeRegistry(),
      trace,
      pins: { a: { value: 'pinned!' } },
      ...deterministic(),
    }).runToEnd();
    expect(trace.samplesFor('a')).toHaveLength(0);
    expect(trace.samplesFor('b')).toHaveLength(1);
  });

  it('sets pinned: true and status succeeded, and logs "using pinned output"', async () => {
    const logs: LogLine[] = [];
    const run = await startRun({
      flow: linearFlow(),
      registry: makeRegistry(),
      pins: { a: { value: 'pinned!' } },
      events: { onLog: (l) => logs.push(l) },
      ...deterministic(),
    }).runToEnd();
    expect(run.nodeStates.a.status).toBe('succeeded');
    expect(run.nodeStates.a.pinned).toBe(true);
    expect(logs.some((l) => l.nodeId === 'a' && l.level === 'info' && l.message === 'a: using pinned output')).toBe(true);
  });
});

describe('ForEach/Collect loops', () => {
  function loopRegistry(): NodeRegistry {
    const r = makeRegistry();
    registerLoopNodes(r);
    r.register(
      { type: 'double', label: 'Double' },
      async (ctx) => ({ doubled: Number(ctx.input.n) * 2 }),
    );
    return r;
  }

  const doubleLoopFlow = (items: unknown[], extraForEachConfig: Record<string, unknown> = {}) =>
    flow(
      [
        node('fe', 'ForEach', { config: { items, ...extraForEachConfig } }),
        node('body', 'double', { inputMap: { n: { sourceNodeId: 'fe', sourceField: 'item' } } }),
        node('col', 'Collect', { inputMap: { value: { sourceNodeId: 'body', sourceField: 'doubled' } } }),
        node('after', 'echo', { inputMap: { value: { sourceNodeId: 'col', sourceField: 'count' } } }),
      ],
      [
        { id: 'e1', source: 'fe', target: 'body' },
        { id: 'e2', source: 'body', target: 'col' },
        { id: 'e3', source: 'col', target: 'after' },
      ],
    );

  it('runs a basic 3-item loop: per-iteration body outputs, Collect gathers them, downstream sees {items, count}', async () => {
    const run = await startRun({
      flow: doubleLoopFlow([1, 2, 3]), registry: loopRegistry(), ...deterministic(),
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.col.output).toEqual({ items: [2, 4, 6], count: 3 });
    expect(run.nodeStates.after.output).toEqual({ echoed: 3 });
    expect(run.nodeStates.body.iteration).toEqual({ index: 2, total: 3 });
    expect(run.nodeStates.fe.iteration).toEqual({ index: 2, total: 3 });

    // Every loop-body execution is recorded, ordered by iteration.
    expect(run.nodeStates.body.executions).toHaveLength(3);
    expect(run.nodeStates.body.executions!.map((e) => e.iteration.index)).toEqual([0, 1, 2]);
    expect(run.nodeStates.body.executions!.map((e) => e.output)).toEqual([
      { doubled: 2 }, { doubled: 4 }, { doubled: 6 },
    ]);
    for (const e of run.nodeStates.body.executions!) {
      expect(e.iteration.total).toBe(3);
      expect(e.status).toBe('succeeded');
    }

    // The ForEach node itself accumulates one record per iteration too.
    expect(run.nodeStates.fe.executions).toHaveLength(3);
    expect(run.nodeStates.fe.executions!.map((e) => e.output)).toEqual([
      { item: 1, index: 0, total: 3 },
      { item: 2, index: 1, total: 3 },
      { item: 3, index: 2, total: 3 },
    ]);

    // Nodes outside the loop region never get an executions array.
    expect(run.nodeStates.after.executions).toBeUndefined();
    expect(run.nodeStates.col.executions).toBeUndefined();
  });

  it('chunks items by batchSize, passing each chunk as `item`', async () => {
    const r = loopRegistry();
    r.register(
      { type: 'sumChunk', label: 'Sum Chunk' },
      async (ctx) => ({ sum: (ctx.input.chunk as number[]).reduce((a, b) => a + b, 0) }),
    );
    const f = flow(
      [
        node('fe', 'ForEach', { config: { items: [1, 2, 3, 4, 5], batchSize: 2 } }),
        node('body', 'sumChunk', { inputMap: { chunk: { sourceNodeId: 'fe', sourceField: 'item' } } }),
        node('col', 'Collect', { inputMap: { value: { sourceNodeId: 'body', sourceField: 'sum' } } }),
      ],
      [
        { id: 'e1', source: 'fe', target: 'body' },
        { id: 'e2', source: 'body', target: 'col' },
      ],
    );
    const run = await startRun({ flow: f, registry: r, ...deterministic() }).runToEnd();
    expect(run.status).toBe('succeeded');
    // [1,2] -> 3, [3,4] -> 7, [5] -> 5
    expect(run.nodeStates.col.output).toEqual({ items: [3, 7, 5], count: 3 });
    expect(run.nodeStates.fe.output).toEqual({ item: [5], index: 2, total: 3 });
  });

  it('truncates iterations at maxIterations and logs a warning', async () => {
    const logs: LogLine[] = [];
    const run = await startRun({
      flow: doubleLoopFlow([1, 2, 3, 4, 5], { maxIterations: 2 }),
      registry: loopRegistry(),
      events: { onLog: (l) => logs.push(l) },
      ...deterministic(),
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.col.output).toEqual({ items: [2, 4], count: 2 });
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('maxIterations 2 reached, truncating 3 iterations'))).toBe(true);
  });

  it('an empty items array skips the body and Collect outputs {items: [], count: 0}', async () => {
    const run = await startRun({
      flow: doubleLoopFlow([]), registry: loopRegistry(), ...deterministic(),
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.body.status).toBe('skipped');
    expect(run.nodeStates.body.iteration).toEqual({ index: 0, total: 0 });
    expect(run.nodeStates.col.output).toEqual({ items: [], count: 0 });
    expect(run.nodeStates.after.output).toEqual({ echoed: 0 });
  });

  it('a non-array "items" input fails the ForEach node like any other node error', async () => {
    const f = doubleLoopFlow([1, 2, 3]);
    f.nodes.find((n) => n.id === 'fe')!.config = { items: 'not-an-array' };
    const run = await startRun({ flow: f, registry: loopRegistry(), ...deterministic() }).runToEnd();
    expect(run.status).toBe('failed');
    expect(run.nodeStates.fe.status).toBe('failed');
    expect(run.nodeStates.body.status).toBe('skipped');
  });

  it('runToEnd() and manual step()-ing to completion produce equivalent results', async () => {
    const stepped = startRun({ flow: doubleLoopFlow([1, 2, 3]), registry: loopRegistry(), ...deterministic() });
    let steps = 0;
    while (await stepped.step()) steps += 1;
    const runToEndResult = await startRun({
      flow: doubleLoopFlow([1, 2, 3]), registry: loopRegistry(), ...deterministic(),
    }).runToEnd();
    expect(stepped.run).toEqual(runToEndResult);
    // Sanity: more than one step() call happened per iteration (ForEach + body), plus Collect + after.
    expect(steps).toBeGreaterThan(3);
  });

  it('steps through iteration by iteration with sane intermediate per-step states', async () => {
    const handle = startRun({ flow: doubleLoopFlow([1, 2, 3]), registry: loopRegistry(), ...deterministic() });

    expect(await handle.step()).toBe(true); // ForEach iteration 0
    expect(handle.run.nodeStates.fe.output).toEqual({ item: 1, index: 0, total: 3 });
    expect(handle.run.nodeStates.fe.iteration).toEqual({ index: 0, total: 3 });
    expect(handle.run.nodeStates.body.status).toBe('queued');

    expect(await handle.step()).toBe(true); // body iteration 0
    expect(handle.run.nodeStates.body.output).toEqual({ doubled: 2 });
    expect(handle.run.nodeStates.body.iteration).toEqual({ index: 0, total: 3 });

    expect(await handle.step()).toBe(true); // ForEach iteration 1
    expect(handle.run.nodeStates.fe.output).toEqual({ item: 2, index: 1, total: 3 });

    expect(await handle.step()).toBe(true); // body iteration 1
    expect(handle.run.nodeStates.body.output).toEqual({ doubled: 4 });

    expect(await handle.step()).toBe(true); // ForEach iteration 2
    expect(await handle.step()).toBe(true); // body iteration 2

    expect(await handle.step()).toBe(true); // Collect
    expect(handle.run.nodeStates.col.output).toEqual({ items: [2, 4, 6], count: 3 });

    // 'after' is the last node — the run finishes within this same step() call.
    expect(await handle.step()).toBe(false);
    expect(handle.run.nodeStates.after.output).toEqual({ echoed: 3 });
    expect(handle.run.status).toBe('succeeded');
  });

  it('resets branch-skip state per iteration so a Route/Conditional-style node inside the body re-decides every time', async () => {
    const r = loopRegistry();
    r.register(
      { type: 'parity', label: 'Parity' },
      async (ctx) => ({ n: ctx.input.n, $branch: Number(ctx.input.n) % 2 === 0 ? 'even' : 'odd' }),
    );
    r.register({ type: 'tag', label: 'Tag' }, async (ctx) => ({ hit: ctx.config.tag }));
    r.register(
      { type: 'merge', label: 'Merge' },
      async (ctx) => ({ value: ctx.input.evenVal ?? ctx.input.oddVal }),
    );
    const f = flow(
      [
        node('fe', 'ForEach', { config: { items: [1, 2, 3] } }),
        node('router', 'parity', { inputMap: { n: { sourceNodeId: 'fe', sourceField: 'item' } } }),
        node('evenLeaf', 'tag', { config: { tag: 'E' } }),
        node('oddLeaf', 'tag', { config: { tag: 'O' } }),
        node('merge', 'merge', {
          inputMap: {
            evenVal: { sourceNodeId: 'evenLeaf', sourceField: 'hit' },
            oddVal: { sourceNodeId: 'oddLeaf', sourceField: 'hit' },
          },
        }),
        node('col', 'Collect', { inputMap: { value: { sourceNodeId: 'merge', sourceField: 'value' } } }),
      ],
      [
        { id: 'e1', source: 'fe', target: 'router' },
        { id: 'e2', source: 'router', target: 'evenLeaf', sourceHandle: 'even' },
        { id: 'e3', source: 'router', target: 'oddLeaf', sourceHandle: 'odd' },
        { id: 'e4', source: 'evenLeaf', target: 'merge' },
        { id: 'e5', source: 'oddLeaf', target: 'merge' },
        { id: 'e6', source: 'merge', target: 'col' },
      ],
    );
    const run = await startRun({ flow: f, registry: r, ...deterministic() }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.col.output).toEqual({ items: ['O', 'E', 'O'], count: 3 });
    // Last iteration (n=3, odd): evenLeaf skipped, oddLeaf ran, merge picked it up.
    expect(run.nodeStates.evenLeaf.status).toBe('skipped');
    expect(run.nodeStates.oddLeaf.status).toBe('succeeded');
    expect(run.nodeStates.merge.output).toEqual({ value: 'O' });

    // Items are [1, 2, 3] -> odd, even, odd: evenLeaf only ran iteration 1,
    // oddLeaf ran iterations 0 and 2. Skipped iterations must not appear.
    expect(run.nodeStates.evenLeaf.executions).toHaveLength(1);
    expect(run.nodeStates.evenLeaf.executions![0].iteration.index).toBe(1);
    expect(run.nodeStates.oddLeaf.executions).toHaveLength(2);
    expect(run.nodeStates.oddLeaf.executions!.map((e) => e.iteration.index)).toEqual([0, 2]);
  });

  it('a pinned body node reuses its pin every iteration and records no trace samples', async () => {
    const trace = new InMemoryTraceSink();
    const run = await startRun({
      flow: doubleLoopFlow([1, 2, 3]),
      registry: loopRegistry(),
      trace,
      pins: { body: { doubled: 99 } },
      ...deterministic(),
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.col.output).toEqual({ items: [99, 99, 99], count: 3 });
    expect(run.nodeStates.body.pinned).toBe(true);
    expect(run.nodeStates.body.iteration).toEqual({ index: 2, total: 3 });
    expect(trace.samplesFor('body')).toHaveLength(0);

    // A record is still appended per iteration, carrying the pinned output.
    expect(run.nodeStates.body.executions).toHaveLength(3);
    expect(run.nodeStates.body.executions!.map((e) => e.iteration.index)).toEqual([0, 1, 2]);
    expect(run.nodeStates.body.executions!.every((e) => e.status === 'succeeded' && e.output && (e.output as { doubled: number }).doubled === 99)).toBe(true);
  });

  it('a failure in a later iteration fails the run and does not clobber the failed node\'s state', async () => {
    const r = loopRegistry();
    r.register({ type: 'boomOnTwo', label: 'Boom On Two' }, async (ctx) => {
      if (Number(ctx.input.n) === 2) throw new Error('bad item');
      return { n: ctx.input.n };
    });
    const f = flow(
      [
        node('fe', 'ForEach', { config: { items: [1, 2, 3] } }),
        node('body', 'boomOnTwo', { inputMap: { n: { sourceNodeId: 'fe', sourceField: 'item' } } }),
        node('col', 'Collect', { inputMap: { value: { sourceNodeId: 'body', sourceField: 'n' } } }),
        node('after', 'echo', { inputMap: { value: { sourceNodeId: 'col', sourceField: 'count' } } }),
      ],
      [
        { id: 'e1', source: 'fe', target: 'body' },
        { id: 'e2', source: 'body', target: 'col' },
        { id: 'e3', source: 'col', target: 'after' },
      ],
    );
    const run = await startRun({ flow: f, registry: r, ...deterministic() }).runToEnd();
    expect(run.status).toBe('failed');
    expect(run.nodeStates.body.status).toBe('failed');
    expect(run.nodeStates.body.error).toBe('bad item');
    expect(run.nodeStates.col.status).toBe('skipped');
    expect(run.nodeStates.after.status).toBe('skipped');

    // Iteration 0 (n=1) succeeded, iteration 1 (n=2) failed; the run stops there.
    expect(run.nodeStates.body.executions).toHaveLength(2);
    expect(run.nodeStates.body.executions![0]).toMatchObject({
      iteration: { index: 0, total: 3 }, status: 'succeeded',
    });
    expect(run.nodeStates.body.executions![1]).toMatchObject({
      iteration: { index: 1, total: 3 }, status: 'failed', error: 'bad item',
    });
  });
});

describe('ForEach with a parallel non-region path', () => {
  it('nodes topologically interleaved beside the region still execute', async () => {
    const r = new NodeRegistry();
    registerLoopNodes(r);
    r.register(
      { type: 'emit', label: 'Emit', configSchema: { fields: [{ name: 'value', type: 'string' }] } },
      async (ctx) => ({ value: ctx.config.value }),
    );
    r.register(
      { type: 'join', label: 'Join' },
      async (ctx) => ({ side: ctx.input.side, count: ctx.input.count }),
    );
    // Topo order interleaves `side` between fe and col (both are sources).
    const f = flow(
      [
        node('fe', 'ForEach', { config: { items: [1, 2] } }),
        node('side', 'emit', { config: { value: 'parallel' } }),
        node('body', 'emit', {
          config: { value: 'x' },
          inputMap: { n: { sourceNodeId: 'fe', sourceField: 'item' } },
        }),
        node('col', 'Collect', { inputMap: { value: { sourceNodeId: 'body', sourceField: 'value' } } }),
        node('final', 'join', {
          inputMap: {
            side: { sourceNodeId: 'side', sourceField: 'value' },
            count: { sourceNodeId: 'col', sourceField: 'count' },
          },
        }),
      ],
      [
        { id: 'e1', source: 'fe', target: 'body' },
        { id: 'e2', source: 'body', target: 'col' },
        { id: 'e3', source: 'col', target: 'final' },
        { id: 'e4', source: 'side', target: 'final' },
      ],
    );
    const run = await startRun({ flow: f, registry: r, ...deterministic() }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.side.status).toBe('succeeded');
    expect(run.nodeStates.final.output).toEqual({ side: 'parallel', count: 2 });
  });
});

describe('Subflow node', () => {
  // A flow that runs one Subflow node ('sub', targeting workflow 'child') and
  // passes its output through a Result. Input for the child is a single mapped
  // field so we can assert what the runner receives.
  const subflowRegistry = (): NodeRegistry => {
    const r = new NodeRegistry();
    registerFlowControlNodes(r); // includes the core Result terminal
    return r;
  };
  const subflowFlow = (workflowId = 'child'): WorkflowDefinition =>
    flow(
      [
        node('sub', 'Subflow', { config: { workflowId } }),
        node('res', 'Result', { inputMap: { data: { sourceNodeId: 'sub', sourceField: '$' } } }),
      ],
      [{ id: 'e', source: 'sub', target: 'res', targetHandle: 'data' }],
    );

  it('runs the child via the host runner and passes its output downstream', async () => {
    const calls: Array<[string, Record<string, unknown>, string]> = [];
    const run = await startRun({
      flow: subflowFlow(),
      registry: subflowRegistry(),
      ...deterministic(),
      subflowRunner: async (workflowId, input, callerNodeId) => {
        calls.push([workflowId, input, callerNodeId]);
        return { status: 'succeeded', output: { answer: 42 } };
      },
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(calls).toEqual([['child', {}, 'sub']]);
    expect(run.nodeStates.sub.output).toEqual({ answer: 42 });
    expect(run.nodeStates.res.output).toEqual({ data: { answer: 42 } });
  });

  it('wraps a non-object child output under `output`', async () => {
    const run = await startRun({
      flow: subflowFlow(),
      registry: subflowRegistry(),
      ...deterministic(),
      subflowRunner: async () => ({ status: 'succeeded', output: 7 }),
    }).runToEnd();
    expect(run.nodeStates.sub.output).toEqual({ output: 7 });
  });

  it('propagates a failed child as a node failure', async () => {
    const run = await startRun({
      flow: subflowFlow(),
      registry: subflowRegistry(),
      ...deterministic(),
      subflowRunner: async () => ({ status: 'failed', error: 'child boom' }),
    }).runToEnd();
    expect(run.status).toBe('failed');
    expect(run.nodeStates.sub.status).toBe('failed');
    expect(run.nodeStates.sub.error).toBe('child boom');
    expect(run.nodeStates.res.status).toBe('skipped');
  });

  it('fails clearly when no host runner is provided', async () => {
    const run = await startRun({
      flow: subflowFlow(),
      registry: subflowRegistry(),
      ...deterministic(),
    }).runToEnd();
    expect(run.status).toBe('failed');
    expect(run.nodeStates.sub.error).toBe('subflows need a host that can look up workflows');
  });
});

describe('optional (fail-soft) nodes', () => {
  it('an optional node failure does not abort the run; independent branches finish and the run succeeds', async () => {
    // root → { bad (optional, throws), good (independent), dependent (consumes bad) }
    const f = flow(
      [
        node('root', 'emit', { config: { value: 'go' } }),
        node('bad', 'boom', { optional: true }),
        node('good', 'emit', { config: { value: 'ok' } }),
        node('dependent', 'echo', { inputMap: { value: { sourceNodeId: 'bad', sourceField: 'value' } } }),
      ],
      [
        { id: 'e1', source: 'root', target: 'bad' },
        { id: 'e2', source: 'root', target: 'good' },
        { id: 'e3', source: 'bad', target: 'dependent' },
      ],
    );
    const run = await startRun({ flow: f, registry: makeRegistry(), ...deterministic() }).runToEnd();

    expect(run.status).toBe('succeeded'); // fail-soft: the optional failure did not abort
    expect(run.nodeStates.bad.status).toBe('failed'); // still recorded as failed (visible)
    expect(run.nodeStates.bad.error).toBe('kaboom');
    expect(run.nodeStates.good.status).toBe('succeeded'); // independent branch ran
    expect(run.nodeStates.dependent.status).toBe('skipped'); // dead edge from the output-less failed node
  });

  it('a NON-optional node failure still aborts the run (default unchanged)', async () => {
    const f = flow(
      [
        node('root', 'emit', { config: { value: 'go' } }),
        node('bad', 'boom'), // not optional
        node('after', 'emit', { config: { value: 'never' } }),
      ],
      [
        { id: 'e1', source: 'root', target: 'bad' },
        { id: 'e2', source: 'bad', target: 'after' },
      ],
    );
    const run = await startRun({ flow: f, registry: makeRegistry(), ...deterministic() }).runToEnd();

    expect(run.status).toBe('failed');
    expect(run.nodeStates.bad.status).toBe('failed');
    expect(run.nodeStates.after.status).toBe('skipped');
  });
});

describe('per-node retry', () => {
  const flakyRegistry = (failCount: number): { registry: NodeRegistry; calls: () => number } => {
    const r = new NodeRegistry();
    let calls = 0;
    r.register({ type: 'flaky', label: 'Flaky' }, async () => {
      calls += 1;
      if (calls <= failCount) throw new Error(`fail-${calls}`);
      return { ok: true };
    });
    return { registry: r, calls: () => calls };
  };

  const alwaysFailRegistry = (): { registry: NodeRegistry; calls: () => number } => {
    const r = new NodeRegistry();
    let calls = 0;
    r.register({ type: 'always-fails', label: 'Always Fails' }, async () => {
      calls += 1;
      throw new Error(`fail-${calls}`);
    });
    return { registry: r, calls: () => calls };
  };

  it('retries a failing implementation and succeeds on the final attempt, logging a warning per retry', async () => {
    const { registry, calls } = flakyRegistry(2);
    const logs: LogLine[] = [];
    const f = flow([node('a', 'flaky', { retry: { maxTries: 3 } })], []);
    const run = await startRun({
      flow: f,
      registry,
      events: { onLog: (l) => logs.push(l) },
      ...deterministic(),
    }).runToEnd();

    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.a.status).toBe('succeeded');
    expect(run.nodeStates.a.output).toEqual({ ok: true });
    expect(calls()).toBe(3);
    const warnLogs = logs.filter((l) => l.level === 'warn' && l.nodeId === 'a');
    expect(warnLogs).toHaveLength(2);
    expect(warnLogs[0].message).toBe('retry 1/3 after error: fail-1');
    expect(warnLogs[1].message).toBe('retry 2/3 after error: fail-2');
  });

  it('exhausts retries and fails the run when the implementation always throws', async () => {
    const { registry, calls } = alwaysFailRegistry();
    const f = flow([node('a', 'always-fails', { retry: { maxTries: 2 } })], []);
    const run = await startRun({ flow: f, registry, ...deterministic() }).runToEnd();

    expect(run.status).toBe('failed');
    expect(run.nodeStates.a.status).toBe('failed');
    expect(run.nodeStates.a.error).toBe('fail-2');
    expect(calls()).toBe(2);
    expect(run.nodeStates.a.attempts).toBe(2);
  });

  it('stamps attempts on the final state when a retried node succeeds after retrying', async () => {
    const { registry } = flakyRegistry(2);
    const f = flow([node('a', 'flaky', { retry: { maxTries: 3 } })], []);
    const run = await startRun({ flow: f, registry, ...deterministic() }).runToEnd();

    expect(run.nodeStates.a.status).toBe('succeeded');
    expect(run.nodeStates.a.attempts).toBe(3);
  });

  it('does not stamp attempts when a node without retry fails on its only attempt', async () => {
    const { registry } = alwaysFailRegistry();
    const f = flow([node('a', 'always-fails')], []);
    const run = await startRun({ flow: f, registry, ...deterministic() }).runToEnd();

    expect(run.nodeStates.a.status).toBe('failed');
    expect(run.nodeStates.a.attempts).toBeUndefined();
  });

  it('composes with optional: retries exhaust, then fail-softs and the run continues', async () => {
    const { registry, calls } = alwaysFailRegistry();
    // give 'b' its own independent working impl so we can observe the run continuing
    registry.register({ type: 'ok-node', label: 'Ok' }, async () => ({ ok: true }));
    const f = flow(
      [
        node('a', 'always-fails', { retry: { maxTries: 2 }, optional: true }),
        node('b', 'ok-node'),
      ],
      [],
    );
    const run = await startRun({ flow: f, registry, ...deterministic() }).runToEnd();

    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.a.status).toBe('failed');
    expect(run.nodeStates.a.error).toBe('fail-2');
    expect(run.nodeStates.b.status).toBe('succeeded');
    expect(calls()).toBe(2);
  });

  it('a node without retry calls the implementation exactly once (unchanged behavior)', async () => {
    const { registry, calls } = alwaysFailRegistry();
    const f = flow([node('a', 'always-fails')], []);
    const run = await startRun({ flow: f, registry, ...deterministic() }).runToEnd();

    expect(run.status).toBe('failed');
    expect(run.nodeStates.a.error).toBe('fail-1');
    expect(calls()).toBe(1);
  });
});

describe('mock runs', () => {
  const dbRegistry = (): { registry: NodeRegistry; calls: () => number } => {
    const r = new NodeRegistry();
    let calls = 0;
    r.register(
      { type: 'db-read', label: 'DB Read', traceKind: 'db' },
      async () => {
        calls += 1;
        return { rows: [] };
      },
    );
    return { registry: r, calls: () => calls };
  };

  it('a mocked node returns the canned output verbatim without calling the implementation', async () => {
    const { registry, calls } = dbRegistry();
    const f = flow([node('a', 'db-read')], []);
    const run = await startRun({
      flow: f,
      registry,
      mockRun: true,
      mocks: { a: { rows: [{ id: 1 }] } },
      ...deterministic(),
    }).runToEnd();

    expect(calls()).toBe(0);
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.a.output).toEqual({ rows: [{ id: 1 }] });
    expect(run.nodeStates.a.mocked).toBe(true);
  });

  it('a mocked node output flows downstream via inputMap', async () => {
    const { registry } = dbRegistry();
    registry.register(
      { type: 'echo', label: 'Echo', inputSchema: { fields: [{ name: 'value', type: 'string', required: true }] } },
      async (ctx) => ({ echoed: ctx.input.value }),
    );
    const f = flow(
      [
        node('a', 'db-read'),
        node('b', 'echo', { inputMap: { value: { sourceNodeId: 'a', sourceField: 'rows' } } }),
      ],
      [{ id: 'e1', source: 'a', target: 'b' }],
    );
    const run = await startRun({
      flow: f,
      registry,
      mockRun: true,
      mocks: { a: { rows: ['x'] } },
      ...deterministic(),
    }).runToEnd();

    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.b.output).toEqual({ echoed: ['x'] });
  });

  it('an unmocked traceKind db node in a mock run fails loud with the binding message and fails the run', async () => {
    const { registry, calls } = dbRegistry();
    const f = flow([node('a', 'db-read', { label: 'Load Users' })], []);
    const run = await startRun({
      flow: f,
      registry,
      mockRun: true,
      ...deterministic(),
    }).runToEnd();

    expect(calls()).toBe(0);
    expect(run.status).toBe('failed');
    expect(run.nodeStates.a.status).toBe('failed');
    expect(run.nodeStates.a.error).toContain('would touch real infrastructure');
    expect(run.nodeStates.a.error).toContain('Load Users');
    expect(run.nodeStates.a.error).toContain('db');
  });

  it('a traceKind compute node (or absent traceKind) executes its real implementation in a mock run', async () => {
    const run = await startRun({
      flow: linearFlow(),
      registry: makeRegistry(),
      mockRun: true,
      ...deterministic(),
    }).runToEnd();

    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.b.output).toEqual({ echoed: 'hi' });
    expect(run.nodeStates.b.mocked).toBeUndefined();
  });

  it('retry config on a mocked node is ignored: no retries, no attempts stamped', async () => {
    const { registry, calls } = dbRegistry();
    const f = flow([node('a', 'db-read', { retry: { maxTries: 3 } })], []);
    const run = await startRun({
      flow: f,
      registry,
      mockRun: true,
      mocks: { a: { rows: [] } },
      ...deterministic(),
    }).runToEnd();

    expect(calls()).toBe(0);
    expect(run.nodeStates.a.status).toBe('succeeded');
    expect(run.nodeStates.a.attempts).toBeUndefined();
  });

  it('mockRun: false ignores a mocks map entirely — the implementation is called for real', async () => {
    const { registry, calls } = dbRegistry();
    const f = flow([node('a', 'db-read')], []);
    const run = await startRun({
      flow: f,
      registry,
      mockRun: false,
      mocks: { a: { rows: ['should-be-ignored'] } },
      ...deterministic(),
    }).runToEnd();

    expect(calls()).toBe(1);
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.a.output).toEqual({ rows: [] });
    expect(run.nodeStates.a.mocked).toBeUndefined();
  });

  it('an optional mocked-infra node with no mock fails soft: run continues, node marked failed', async () => {
    const { registry } = dbRegistry();
    registry.register({ type: 'ok-node', label: 'Ok' }, async () => ({ ok: true }));
    const f = flow(
      [
        node('a', 'db-read', { optional: true }),
        node('b', 'ok-node'),
      ],
      [],
    );
    const run = await startRun({ flow: f, registry, mockRun: true, ...deterministic() }).runToEnd();

    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.a.status).toBe('failed');
    expect(run.nodeStates.a.error).toContain('would touch real infrastructure');
    expect(run.nodeStates.b.status).toBe('succeeded');
  });

  it('a mocked node whose config carries a $secret ref succeeds with the canned output even with no secrets configured', async () => {
    const { registry, calls } = dbRegistry();
    const f = flow([node('a', 'db-read', { config: { apiKey: { $secret: 'API_KEY' } } })], []);
    const run = await startRun({
      flow: f,
      registry,
      mockRun: true,
      mocks: { a: { rows: [] } },
      // Deliberately NO secrets — a fresh no-secrets project.
      ...deterministic(),
    }).runToEnd();

    expect(calls()).toBe(0);
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.a.mocked).toBe(true);
    expect(run.nodeStates.a.output).toEqual({ rows: [] });
  });

  it('the same $secret-carrying node, unmocked, fails with the infrastructure message — not "Missing secret" — with no secrets configured', async () => {
    const { registry, calls } = dbRegistry();
    const f = flow([node('a', 'db-read', { label: 'Load Users', config: { apiKey: { $secret: 'API_KEY' } } })], []);
    const run = await startRun({
      flow: f,
      registry,
      mockRun: true,
      // No mocks entry for "a" and no secrets configured.
      ...deterministic(),
    }).runToEnd();

    expect(calls()).toBe(0);
    expect(run.status).toBe('failed');
    expect(run.nodeStates.a.error).toContain('would touch real infrastructure');
    expect(run.nodeStates.a.error).not.toContain('Missing secret');
  });
});

describe('explainUndefinedRead', () => {
  it('enriches "Cannot read properties of undefined" messages with sorted input keys', () => {
    const msg = explainUndefinedRead("Cannot read properties of undefined (reading 'id')", { a: 1, b: 1 });
    expect(msg).toBe(
      "Cannot read properties of undefined (reading 'id') — this node received [a, b]. Check the node's inputMap and the run input.",
    );
  });

  it('enriches "Cannot read properties of null" messages', () => {
    const msg = explainUndefinedRead("Cannot read properties of null (reading 'foo')", { x: 1 });
    expect(msg).toBe(
      "Cannot read properties of null (reading 'foo') — this node received [x]. Check the node's inputMap and the run input.",
    );
  });

  it('enriches the Safari/older-engine "is not an object" shape', () => {
    const msg = explainUndefinedRead("undefined is not an object (evaluating 'a.id')", {});
    expect(msg).toBe(
      "undefined is not an object (evaluating 'a.id') — this node received (none). Check the node's inputMap and the run input.",
    );
  });

  it('names mapped fields that resolved to undefined — the usual culprit', () => {
    const msg = explainUndefinedRead(
      "Cannot read properties of undefined (reading 'id')",
      { userId: 'u1', params: undefined, query: undefined },
    );
    expect(msg).toContain('this node received [userId].');
    expect(msg).toContain('These mapped fields resolved to undefined: params, query.');
  });

  it('renders (none) for an empty key list', () => {
    const msg = explainUndefinedRead("Cannot read properties of undefined (reading 'id')", {});
    expect(msg).toContain('received (none)');
  });

  it('leaves unrelated messages byte-identical', () => {
    expect(explainUndefinedRead('boom', { a: 1 })).toBe('boom');
    expect(explainUndefinedRead('some other TypeError', { a: 1 })).toBe('some other TypeError');
  });
});

describe('undefined-property-read error enrichment via executeNode', () => {
  const paramsRegistry = (): NodeRegistry => {
    const r = new NodeRegistry();
    r.register(
      { type: 'emit', label: 'Emit', configSchema: { fields: [{ name: 'value', type: 'string' }] } },
      async (ctx) => ({ value: ctx.config.value }),
    );
    r.register({ type: 'reads-params-id', label: 'Reads params.id' }, async (ctx) => {
      // Mirrors a real HTTP op reading a path param that was never mapped.
      return { id: (ctx.input.params as { id: string }).id };
    });
    return r;
  };

  it('enriches the error with resolved input keys when a mapped input is missing the read property', async () => {
    const f = flow(
      [
        node('a', 'emit', { config: { value: 'u-1' } }),
        node('b', 'reads-params-id', { inputMap: { userId: { sourceNodeId: 'a', sourceField: 'value' } } }),
      ],
      [{ id: 'e1', source: 'a', target: 'b' }],
    );
    const run = await startRun({ flow: f, registry: paramsRegistry(), ...deterministic() }).runToEnd();
    expect(run.status).toBe('failed');
    expect(run.nodeStates.b.status).toBe('failed');
    expect(run.nodeStates.b.error).toContain("Cannot read properties of undefined (reading 'id')");
    expect(run.nodeStates.b.error).toContain('received [userId]');
  });

  it('renders (none) when the node received no mapped input at all', async () => {
    const f = flow([node('a', 'reads-params-id')], []);
    const run = await startRun({ flow: f, registry: paramsRegistry(), ...deterministic() }).runToEnd();
    expect(run.status).toBe('failed');
    expect(run.nodeStates.a.error).toContain("Cannot read properties of undefined (reading 'id')");
    expect(run.nodeStates.a.error).toContain('received (none)');
  });

  it('leaves a plain Error message exactly unchanged', async () => {
    const f = flow([node('a', 'boom')], []);
    const run = await startRun({ flow: f, registry: makeRegistry(), ...deterministic() }).runToEnd();
    expect(run.nodeStates.a.error).toBe('kaboom');
  });

  it('leaves an unrelated TypeError message exactly unchanged', async () => {
    const r = new NodeRegistry();
    r.register({ type: 'weird-type-error', label: 'Weird' }, async () => {
      throw new TypeError('value is not a function');
    });
    const f = flow([node('a', 'weird-type-error')], []);
    const run = await startRun({ flow: f, registry: r, ...deterministic() }).runToEnd();
    expect(run.nodeStates.a.error).toBe('value is not a function');
  });
});
