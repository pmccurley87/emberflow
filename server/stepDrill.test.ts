import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition, WorkflowNode } from '../src/engine';
import { createDefaultRegistry } from '../src/nodes';
import { RunRegistry, type RunEvent, type StepResult } from './runRegistry';

const base = { version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

const runOpts = { secrets: {}, vars: {}, environment: 'test', safeMode: false };

function node(id: string, type: string, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type, label: extra.label ?? id, position: { x: 0, y: 0 }, config: {}, ...extra };
}

function flowStore(flows: WorkflowDefinition[]) {
  const byId = new Map(flows.map((f) => [f.id, f]));
  return (id: string) => byId.get(id);
}

/** Default registry (no artificial node delays) + deterministic test nodes. */
function registry() {
  const r = createDefaultRegistry(0);
  r.register(
    { type: 'double', label: 'Double', inputSchema: { fields: [{ name: 'value', type: 'number' }] } },
    async (ctx) => ({ value: Number(ctx.input.value) * 2 }),
  );
  r.register({ type: 'boom', label: 'Boom' }, async () => {
    throw new Error('kaboom');
  });
  return r;
}

/** Input → Double → Result. */
const childFlow: WorkflowDefinition = {
  ...base,
  id: 'child-flow',
  name: 'Child Flow',
  nodes: [
    node('cin', 'Input', { config: { fields: [], defaults: {} } }),
    node('cdouble', 'double', { inputMap: { value: { sourceNodeId: 'cin', sourceField: 'value' } } }),
    node('cres', 'Result', { inputMap: { data: { sourceNodeId: 'cdouble', sourceField: '$' } } }),
  ],
  edges: [
    { id: 'e1', source: 'cin', target: 'cdouble' },
    { id: 'e2', source: 'cdouble', target: 'cres' },
  ],
};

/** Input → Subflow(child) → Result. */
const parentFlow: WorkflowDefinition = {
  ...base,
  id: 'parent-flow',
  name: 'Parent Flow',
  nodes: [
    node('pin', 'Input', { config: { fields: [], defaults: {} } }),
    node('sub', 'Subflow', {
      config: { workflowId: 'child-flow' },
      inputMap: { value: { sourceNodeId: 'pin', sourceField: 'value' } },
    }),
    node('pres', 'Result', { inputMap: { data: { sourceNodeId: 'sub', sourceField: '$' } } }),
  ],
  edges: [
    { id: 'e1', source: 'pin', target: 'sub' },
    { id: 'e2', source: 'sub', target: 'pres' },
  ],
};

/** Drives a stepped run to completion, returning every StepResult in order. */
async function stepToEnd(runs: RunRegistry, runId: string): Promise<StepResult[]> {
  const seq: StepResult[] = [];
  for (let i = 0; i < 50; i += 1) {
    const result = await runs.step(runId);
    expect(result).toBeDefined();
    seq.push(result!);
    if (result!.done) return seq;
  }
  throw new Error('run did not finish within 50 steps');
}

describe('subflow step drill-in', () => {
  it('steps into and out of a child: entered marker, child steps, exited marker, same output as non-stepped', async () => {
    const runs = new RunRegistry(flowStore([parentFlow, childFlow]), registry());
    const { runId, handle } = runs.create(parentFlow, { ...runOpts, input: { value: 3 }, stepped: true });

    const events: RunEvent[] = [];
    runs.subscribe(runId, (e) => events.push(e));

    const seq = await stepToEnd(runs, runId);

    // pin → entered(sub) → cin → cdouble → cres(exits) → pres(done)
    expect(seq).toEqual([
      { done: false },
      { done: false, entered: { workflowId: 'child-flow', nodeId: 'sub' } },
      { done: false },
      { done: false },
      { done: false, exited: true },
      { done: true },
    ]);
    expect(handle.run.status).toBe('succeeded');

    // Child node states streamed into the ROOT run's event stream, tagged
    // with the child flow's id; parent states carry the parent flow's id.
    const stateIds = events
      .filter((e) => e.type === 'nodeState')
      .map((e) => (e.type === 'nodeState' ? `${e.workflowId}:${e.nodeId}` : ''));
    expect(stateIds).toContain('child-flow:cdouble');
    expect(stateIds).toContain('parent-flow:sub');
    expect(stateIds).not.toContain('parent-flow:cdouble');

    // Output identical to a non-stepped run of the same flow.
    const plain = runs.create(parentFlow, { ...runOpts, input: { value: 3 } });
    await plain.handle.runToEnd();
    expect(plain.handle.run.status).toBe('succeeded');
    expect(handle.run.nodeStates.pres.output).toEqual(plain.handle.run.nodeStates.pres.output);
    expect(handle.run.nodeStates.pres.output).toEqual({ data: { data: { value: 6 } } });
  });

  it('reports done on the exit step when the Subflow is the parent’s last node (pending-step fold)', async () => {
    const tailFlow: WorkflowDefinition = {
      ...base,
      id: 'tail-flow',
      name: 'Tail Flow',
      nodes: [
        node('pin', 'Input', { config: { fields: [], defaults: {} } }),
        node('sub', 'Subflow', {
          config: { workflowId: 'child-flow' },
          inputMap: { value: { sourceNodeId: 'pin', sourceField: 'value' } },
        }),
      ],
      edges: [{ id: 'e1', source: 'pin', target: 'sub' }],
    };
    const runs = new RunRegistry(flowStore([tailFlow, childFlow]), registry());
    const { runId, handle } = runs.create(tailFlow, { ...runOpts, input: { value: 2 }, stepped: true });

    const seq = await stepToEnd(runs, runId);
    // The step that pops the child must fold the parent's pending step()
    // boolean in: the run is over, so done arrives WITH the exit, not late.
    expect(seq[seq.length - 1]).toEqual({ done: true, exited: true });
    expect(handle.run.status).toBe('succeeded');
    expect(handle.run.nodeStates.sub.output).toEqual({ data: { value: 4 } });
  });

  it('nests: child-in-child yields entered/entered/exited/exited ordering', async () => {
    const midFlow: WorkflowDefinition = {
      ...base,
      id: 'mid-flow',
      name: 'Mid Flow',
      nodes: [
        node('min', 'Input', { config: { fields: [], defaults: {} } }),
        node('msub', 'Subflow', {
          config: { workflowId: 'child-flow' },
          inputMap: { value: { sourceNodeId: 'min', sourceField: 'value' } },
        }),
        node('mres', 'Result', { inputMap: { data: { sourceNodeId: 'msub', sourceField: '$' } } }),
      ],
      edges: [
        { id: 'e1', source: 'min', target: 'msub' },
        { id: 'e2', source: 'msub', target: 'mres' },
      ],
    };
    const topFlow: WorkflowDefinition = {
      ...base,
      id: 'top-flow',
      name: 'Top Flow',
      nodes: [
        node('tin', 'Input', { config: { fields: [], defaults: {} } }),
        node('tsub', 'Subflow', {
          config: { workflowId: 'mid-flow' },
          inputMap: { value: { sourceNodeId: 'tin', sourceField: 'value' } },
        }),
        node('tres', 'Result', { inputMap: { data: { sourceNodeId: 'tsub', sourceField: '$' } } }),
      ],
      edges: [
        { id: 'e1', source: 'tin', target: 'tsub' },
        { id: 'e2', source: 'tsub', target: 'tres' },
      ],
    };

    const runs = new RunRegistry(flowStore([topFlow, midFlow, childFlow]), registry());
    const { runId, handle } = runs.create(topFlow, { ...runOpts, input: { value: 1 }, stepped: true });

    const seq = await stepToEnd(runs, runId);
    const markers = seq
      .filter((s) => s.entered || s.exited)
      .map((s) => (s.entered ? { entered: s.entered } : { exited: true }));
    expect(markers).toEqual([
      { entered: { workflowId: 'mid-flow', nodeId: 'tsub' } },
      { entered: { workflowId: 'child-flow', nodeId: 'msub' } },
      { exited: true },
      { exited: true },
    ]);
    expect(handle.run.status).toBe('succeeded');
    expect(handle.run.nodeStates.tres.output).toEqual({ data: { data: { data: { value: 2 } } } });
  });

  it('a child failure mid-step fails the parent Subflow node with the child’s error, identically to non-stepped', async () => {
    const boomChild: WorkflowDefinition = {
      ...base,
      id: 'child-flow',
      name: 'Child Boom',
      nodes: [
        node('cin', 'Input', { config: { fields: [], defaults: {} } }),
        node('cboom', 'boom'),
      ],
      edges: [{ id: 'e1', source: 'cin', target: 'cboom' }],
    };
    const runs = new RunRegistry(flowStore([parentFlow, boomChild]), registry());
    const { runId, handle } = runs.create(parentFlow, { ...runOpts, input: { value: 3 }, stepped: true });

    const seq = await stepToEnd(runs, runId);
    // pin → entered → cin → cboom (child fails; exit folds the parent's
    // failure in, so done arrives with the exit)
    expect(seq[1]).toEqual({ done: false, entered: { workflowId: 'child-flow', nodeId: 'sub' } });
    expect(seq[seq.length - 1]).toEqual({ done: true, exited: true });
    expect(handle.run.status).toBe('failed');
    expect(handle.run.nodeStates.sub.status).toBe('failed');
    expect(handle.run.nodeStates.pres.status).toBe('skipped');

    // Same error text as a non-stepped run of the same flows.
    const plain = runs.create(parentFlow, { ...runOpts, input: { value: 3 } });
    await plain.handle.runToEnd();
    expect(plain.handle.run.status).toBe('failed');
    expect(handle.run.nodeStates.sub.error).toBe(plain.handle.run.nodeStates.sub.error);
    expect(handle.run.nodeStates.sub.error).toBe('subflow "Child Boom" failed: kaboom');
  });

  it('a Subflow node with retry re-enters the child after a failed attempt (exited+entered), without hanging', async () => {
    // Child whose work node fails on the FIRST execution only.
    let flakyCalls = 0;
    const r = registry();
    r.register({ type: 'flaky', label: 'Flaky' }, async () => {
      flakyCalls += 1;
      if (flakyCalls === 1) throw new Error('first try fails');
      return { ok: true };
    });
    const flakyChild: WorkflowDefinition = {
      ...base,
      id: 'child-flow',
      name: 'Flaky Child',
      nodes: [
        node('cin', 'Input', { config: { fields: [], defaults: {} } }),
        node('cflaky', 'flaky'),
      ],
      edges: [{ id: 'e1', source: 'cin', target: 'cflaky' }],
    };
    const retryParent: WorkflowDefinition = {
      ...parentFlow,
      nodes: parentFlow.nodes.map((n) =>
        n.id === 'sub' ? { ...n, retry: { maxTries: 2, waitMs: 0 } } : n,
      ),
    };
    const runs = new RunRegistry(flowStore([retryParent, flakyChild]), r);
    const { runId, handle } = runs.create(retryParent, { ...runOpts, input: { value: 3 }, stepped: true });

    const seq = await stepToEnd(runs, runId);
    // pin → entered → cin → cflaky fails (child run failed; the retrying
    // Subflow node immediately re-runs the child: exited + entered in ONE
    // step) → cin → cflaky succeeds (exited) → pres → done.
    expect(seq).toEqual([
      { done: false },
      { done: false, entered: { workflowId: 'child-flow', nodeId: 'sub' } },
      { done: false },
      { done: false, exited: true, entered: { workflowId: 'child-flow', nodeId: 'sub' } },
      { done: false },
      { done: false, exited: true },
      { done: true },
    ]);
    expect(flakyCalls).toBe(2);
    expect(handle.run.status).toBe('succeeded');
    expect(handle.run.nodeStates.sub.status).toBe('succeeded');
    expect(handle.run.nodeStates.sub.attempts).toBe(2);
  });

  it('a node making two sequential ctx.runSubflow calls drills both children in turn', async () => {
    const r = registry();
    r.register({ type: 'twice', label: 'Twice' }, async (ctx) => {
      const a = await ctx.runSubflow!('child-flow', { value: 1 });
      const b = await ctx.runSubflow!('child-flow', { value: 10 });
      if (a.status === 'failed' || b.status === 'failed') throw new Error('subflow failed');
      return { a: a.output, b: b.output };
    });
    const twiceParent: WorkflowDefinition = {
      ...base,
      id: 'twice-flow',
      name: 'Twice Flow',
      nodes: [
        node('pin', 'Input', { config: { fields: [], defaults: {} } }),
        node('tw', 'twice'),
      ],
      edges: [{ id: 'e1', source: 'pin', target: 'tw' }],
    };
    const runs = new RunRegistry(flowStore([twiceParent, childFlow]), r);
    const { runId, handle } = runs.create(twiceParent, { ...runOpts, input: {}, stepped: true });

    const seq = await stepToEnd(runs, runId);
    const markers = seq
      .filter((s) => s.entered || s.exited)
      .map((s) => ({ ...(s.entered ? { entered: s.entered.nodeId } : {}), ...(s.exited ? { exited: true } : {}) }));
    // First child completes and the SAME step enters the second child.
    expect(markers).toEqual([
      { entered: 'tw' },
      { exited: true, entered: 'tw' },
      { exited: true },
    ]);
    expect(handle.run.status).toBe('succeeded');
    expect(handle.run.nodeStates.tw.output).toEqual({
      a: { data: { value: 2 } },
      b: { data: { value: 20 } },
    });
  });

  it('cancel mid-drill cancels the stacked child; later steps report done and no child nodeState follows finished', async () => {
    const runs = new RunRegistry(flowStore([parentFlow, childFlow]), registry());
    const { runId, handle } = runs.create(parentFlow, { ...runOpts, input: { value: 3 }, stepped: true });

    const events: RunEvent[] = [];
    runs.subscribe(runId, (e) => events.push(e));

    // pin → entered(sub) → cin: cancelled while drilled into the child.
    expect(await runs.step(runId)).toEqual({ done: false });
    expect(await runs.step(runId)).toEqual({
      done: false,
      entered: { workflowId: 'child-flow', nodeId: 'sub' },
    });
    expect(await runs.step(runId)).toEqual({ done: false });

    expect(runs.cancel(runId)).toBe(true);
    expect(handle.run.status).toBe('cancelled');

    // Stepping after cancel executes nothing and reports done.
    expect(await runs.step(runId)).toEqual({ done: true });
    expect(await runs.step(runId)).toEqual({ done: true });

    // Let the rejected parent execution unwind in the background, then check
    // nothing leaked past `finished`: exactly one finished event (status
    // cancelled) and zero child nodeState events after it.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const finishedIdx = events.findIndex((e) => e.type === 'finished');
    expect(finishedIdx).toBeGreaterThan(-1);
    expect(events.filter((e) => e.type === 'finished')).toHaveLength(1);
    const finished = events[finishedIdx];
    expect(finished.type === 'finished' && finished.run.status).toBe('cancelled');
    const childStatesAfter = events
      .slice(finishedIdx + 1)
      .filter((e) => e.type === 'nodeState' && e.workflowId === 'child-flow');
    expect(childStatesAfter).toEqual([]);

    // cancel of an unknown run reports false (route 404s).
    expect(runs.cancel('nope')).toBe(false);
  });

  it('concurrent step() calls serialize: both resolve, in order, as two sequential steps', async () => {
    const runs = new RunRegistry(flowStore([parentFlow, childFlow]), registry());
    const { runId } = runs.create(parentFlow, { ...runOpts, input: { value: 3 }, stepped: true });

    // Fired without awaiting between: without the per-run mutex the second
    // call overwrites onChildStarted and the first request hangs.
    const [r1, r2] = await Promise.all([runs.step(runId), runs.step(runId)]);
    expect(r1).toEqual({ done: false }); // pin
    expect(r2).toEqual({ done: false, entered: { workflowId: 'child-flow', nodeId: 'sub' } });

    const rest = await stepToEnd(runs, runId);
    expect(rest[rest.length - 1]).toEqual({ done: true });
  });

  it('non-stepped runs keep today’s behavior: no drill markers, child node states not streamed', async () => {
    const runs = new RunRegistry(flowStore([parentFlow, childFlow]), registry());
    const { runId, handle } = runs.create(parentFlow, { ...runOpts, input: { value: 5 } });

    const events: RunEvent[] = [];
    runs.subscribe(runId, (e) => events.push(e));

    const seq = await stepToEnd(runs, runId);
    expect(seq.every((s) => !s.entered && !s.exited)).toBe(true);
    expect(handle.run.status).toBe('succeeded');
    expect(
      events.some((e) => e.type === 'nodeState' && e.workflowId === 'child-flow'),
    ).toBe(false);
  });
});
