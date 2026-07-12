import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../src/nodes';
import type { WorkflowDefinition } from '../src/engine';
import { RunRegistry, type RunEvent } from './runRegistry';

const base = { version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

/** A registry with a node type that always throws — used to force run failures. */
function registryWithBoom() {
  const registry = createDefaultRegistry();
  registry.register({ type: 'boom', label: 'Boom' }, async () => {
    throw new Error('kaboom');
  });
  return registry;
}

const failingFlow: WorkflowDefinition = {
  ...base,
  id: 'failing-flow',
  name: 'Failing Flow',
  nodes: [{ id: 'a', type: 'boom', label: 'Boom', position: { x: 0, y: 0 }, config: {} }],
  edges: [],
};

/** Error op: an Input node so the run's input is visible via nodeStates.input.input. */
const errorOp: WorkflowDefinition = {
  ...base,
  id: 'error-op',
  name: 'Error Op',
  nodes: [
    { id: 'input', type: 'Input', label: 'Input', position: { x: 0, y: 0 }, config: { fields: [], defaults: {} } },
  ],
  edges: [],
};

const errorOpThatFails: WorkflowDefinition = {
  ...base,
  id: 'error-op-boom',
  name: 'Error Op Boom',
  nodes: [{ id: 'a', type: 'boom', label: 'Boom', position: { x: 0, y: 0 }, config: {} }],
  edges: [],
};

const runOpts = {
  secrets: {},
  vars: {},
  environment: 'test',
  safeMode: false,
};

function flowStore(flows: WorkflowDefinition[]) {
  const byId = new Map(flows.map((f) => [f.id, f]));
  return (id: string) => byId.get(id);
}

describe('error workflow', () => {
  it('fires the configured error op with failure details when a run fails', async () => {
    const runs = new RunRegistry(flowStore([failingFlow, errorOp]), registryWithBoom(), 'error-op');
    const { handle } = runs.create(failingFlow, runOpts);
    const before = new Set([...(runs as unknown as { runs: Map<string, unknown> }).runs.keys()]);
    await handle.runToEnd();

    // Poll briefly: the error op run is created synchronously inside onRunFinished.
    const allRunsMap = (runs as unknown as { runs: Map<string, { handle: { run: { workflowId: string; nodeStates: Record<string, { status: string; input?: unknown }> } } }> }).runs;
    const newIds = [...allRunsMap.keys()].filter((id) => !before.has(id));
    expect(newIds.length).toBe(1);
    const errorRunEntry = allRunsMap.get(newIds[0])!;
    expect(errorRunEntry.handle.run.workflowId).toBe('error-op');
    const inputState = errorRunEntry.handle.run.nodeStates.input;
    expect(inputState.status).toBe('succeeded');
    const capturedInput = (inputState as unknown as { output: { failedWorkflowId: string; failedRunId: string; error: string } }).output;
    expect(capturedInput.failedWorkflowId).toBe('failing-flow');
    expect(capturedInput.failedRunId).toBe(handle.run.id);
    expect(capturedInput.error).toBe('kaboom');
  });

  it("tags the error-handler run's finished event with errorHandler.firedBy; the failed run carries none", async () => {
    const runs = new RunRegistry(flowStore([failingFlow, errorOp]), registryWithBoom(), 'error-op');
    const { handle, runId: failedRunId } = runs.create(failingFlow, runOpts);
    const before = new Set([...(runs as unknown as { runs: Map<string, unknown> }).runs.keys()]);
    await handle.runToEnd();

    const allRunsMap = (runs as unknown as { runs: Map<string, unknown> }).runs;
    const newIds = [...allRunsMap.keys()].filter((id) => !before.has(id));
    expect(newIds.length).toBe(1);
    const errorRunId = newIds[0];

    const errorRunEvents: RunEvent[] = [];
    runs.subscribe(errorRunId, (e) => errorRunEvents.push(e));
    const errorFinished = errorRunEvents.find((e) => e.type === 'finished');
    expect(errorFinished?.errorHandler).toEqual({ firedBy: 'failing-flow' });

    const failedRunEvents: RunEvent[] = [];
    runs.subscribe(failedRunId, (e) => failedRunEvents.push(e));
    const failedFinished = failedRunEvents.find((e) => e.type === 'finished');
    expect(failedFinished?.errorHandler).toBeUndefined();
  });

  it('reports the halting failure, not an earlier fail-soft optional node', async () => {
    // 'soft' fails first (declaration order) but is optional — fail-soft, the
    // run continues. 'fatal' then fails and halts the run. The error op must
    // receive fatal's id/error, not soft's.
    const mixedFlow: WorkflowDefinition = {
      ...base,
      id: 'mixed-flow',
      name: 'Mixed Flow',
      nodes: [
        { id: 'soft', type: 'boom', label: 'Soft Boom', position: { x: 0, y: 0 }, config: {}, optional: true },
        { id: 'fatal', type: 'boom2', label: 'Fatal Boom', position: { x: 200, y: 0 }, config: {} },
      ],
      edges: [],
    };
    const registry = registryWithBoom();
    registry.register({ type: 'boom2', label: 'Boom2' }, async () => {
      throw new Error('fatal kaboom');
    });
    const runs = new RunRegistry(flowStore([mixedFlow, errorOp]), registry, 'error-op');
    const { handle } = runs.create(mixedFlow, runOpts);
    const before = new Set([...(runs as unknown as { runs: Map<string, unknown> }).runs.keys()]);
    await handle.runToEnd();

    const allRunsMap = (runs as unknown as { runs: Map<string, { handle: { run: { workflowId: string; nodeStates: Record<string, { status: string; output?: unknown }> } } }> }).runs;
    const newIds = [...allRunsMap.keys()].filter((id) => !before.has(id));
    expect(newIds.length).toBe(1);
    const inputState = allRunsMap.get(newIds[0])!.handle.run.nodeStates.input;
    const capturedInput = (inputState as unknown as { output: { failedNodeId: string; error: string } }).output;
    expect(capturedInput.failedNodeId).toBe('fatal');
    expect(capturedInput.error).toBe('fatal kaboom');
  });

  it('does not spawn a third run when the error op itself fails', async () => {
    const runs = new RunRegistry(flowStore([failingFlow, errorOpThatFails]), registryWithBoom(), 'error-op-boom');
    const { handle } = runs.create(failingFlow, runOpts);
    const before = new Set([...(runs as unknown as { runs: Map<string, unknown> }).runs.keys()]);
    await handle.runToEnd();

    const allRunsMap = (runs as unknown as { runs: Map<string, unknown> }).runs;
    const newIds = [...allRunsMap.keys()].filter((id) => !before.has(id));
    // Only the error-op run itself; it must not recurse into a third run.
    expect(newIds.length).toBe(1);
  });

  it('does nothing when no errorOperation is configured', async () => {
    const runs = new RunRegistry(flowStore([failingFlow]), registryWithBoom());
    const { handle } = runs.create(failingFlow, runOpts);
    const before = new Set([...(runs as unknown as { runs: Map<string, unknown> }).runs.keys()]);
    await handle.runToEnd();

    const allRunsMap = (runs as unknown as { runs: Map<string, unknown> }).runs;
    const newIds = [...allRunsMap.keys()].filter((id) => !before.has(id));
    expect(newIds.length).toBe(0);
  });

  it('a failed MOCK run fires its error op as a MOCK run — infra in the error op fails loud instead of executing real', async () => {
    // The error op carries a db-flavoured node with NO mock: if mock mode did
    // not propagate, its implementation would run (here: throw a sentinel we
    // can detect); with propagation it must fail with the infra boundary.
    const registry = registryWithBoom();
    let realCalls = 0;
    registry.register({ type: 'dbWrite', label: 'DB Write', traceKind: 'db' }, async () => {
      realCalls += 1;
      return { wrote: true };
    });
    const errorOpWithInfra: WorkflowDefinition = {
      ...base,
      id: 'error-op-infra',
      name: 'Error Op Infra',
      nodes: [{ id: 'log', type: 'dbWrite', label: 'DB Write', position: { x: 0, y: 0 }, config: {} }],
      edges: [],
    };
    const runs = new RunRegistry(flowStore([failingFlow, errorOpWithInfra]), registry, 'error-op-infra');
    const before = new Set([...(runs as unknown as { runs: Map<string, unknown> }).runs.keys()]);
    const { handle } = runs.create(failingFlow, { ...runOpts, mockRun: true, mocks: {} });
    await handle.runToEnd();

    const allRunsMap = (runs as unknown as { runs: Map<string, { handle: { run: { workflowId: string; status: string; nodeStates: Record<string, { status: string; error?: string }> }; runToEnd(): Promise<unknown> } }> }).runs;
    const newIds = [...allRunsMap.keys()].filter((id) => !before.has(id) && id !== handle.run.id);
    expect(newIds.length).toBe(1);
    const errorRun = allRunsMap.get(newIds[0])!.handle;
    await errorRun.runToEnd().catch(() => {});
    expect(realCalls).toBe(0);
    expect(errorRun.run.nodeStates.log.status).toBe('failed');
    expect(errorRun.run.nodeStates.log.error).toContain('would touch real infrastructure');
  });

  it('does nothing when the run succeeds', async () => {
    const okFlow: WorkflowDefinition = {
      ...base,
      id: 'ok-flow',
      name: 'Ok Flow',
      nodes: [
        { id: 'input', type: 'Input', label: 'Input', position: { x: 0, y: 0 }, config: { fields: [], defaults: {} } },
      ],
      edges: [],
    };
    const runs = new RunRegistry(flowStore([okFlow, errorOp]), createDefaultRegistry(), 'error-op');
    const { handle } = runs.create(okFlow, runOpts);
    const before = new Set([...(runs as unknown as { runs: Map<string, unknown> }).runs.keys()]);
    await handle.runToEnd();

    const allRunsMap = (runs as unknown as { runs: Map<string, unknown> }).runs;
    const newIds = [...allRunsMap.keys()].filter((id) => !before.has(id));
    expect(newIds.length).toBe(0);
  });
});
