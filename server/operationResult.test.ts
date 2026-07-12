import { expect, it } from 'vitest';
import { extractResponse } from './operationResult';
import type { WorkflowDefinition } from '../src/engine';

const base = { version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

it('returns the Response node output when present', () => {
  const flow = { ...base, id: 'f', name: 'F', edges: [],
    nodes: [{ id: 'r', type: 'Response', label: 'R', position: { x: 0, y: 0 }, config: {} }] } as unknown as WorkflowDefinition;
  const run = { nodeStates: { r: { status: 'succeeded', output: { status: 204, body: null } } } } as never;
  expect(extractResponse(run, flow)).toEqual({ status: 204, body: null });
});

it('picks the Response node that actually succeeded, not the first by array order', () => {
  // Two Response nodes: 'first' is earlier in the array but was skipped
  // (nodeStates status !== 'succeeded', output undefined); 'second' ran and
  // succeeded. The real result is the second node's output, not a fallback
  // to 200 + Result.
  const flow = {
    ...base,
    id: 'f',
    name: 'F',
    edges: [],
    nodes: [
      { id: 'first', type: 'Response', label: 'First', position: { x: 0, y: 0 }, config: {} },
      { id: 'second', type: 'Response', label: 'Second', position: { x: 0, y: 0 }, config: {} },
    ],
  } as unknown as WorkflowDefinition;
  const run = {
    nodeStates: {
      first: { status: 'skipped', output: undefined },
      second: { status: 'succeeded', output: { status: 404, body: { error: 'nf' } } },
    },
  } as never;
  expect(extractResponse(run, flow)).toEqual({ status: 404, body: { error: 'nf' } });
});

it('defaults to 200 + Result output when there is no Response node', () => {
  const flow = { ...base, id: 'f', name: 'F', edges: [],
    nodes: [{ id: 'res', type: 'Result', label: 'Res', position: { x: 0, y: 0 }, config: {} }] } as unknown as WorkflowDefinition;
  const run = { status: 'succeeded', nodeStates: { res: { status: 'succeeded', output: { hello: 'world' } } } } as never;
  expect(extractResponse(run, flow)).toEqual({ status: 200, body: { hello: 'world' } });
});

it('returns 500 with the failing node error when the run failed and there is no Response node', () => {
  const flow = { ...base, id: 'f', name: 'F', edges: [],
    nodes: [{ id: 'n', type: 'HttpRequest', label: 'N', position: { x: 0, y: 0 }, config: {} }] } as unknown as WorkflowDefinition;
  const run = { status: 'failed', nodeStates: { n: { status: 'failed', error: 'boom: connection refused' } } } as never;
  expect(extractResponse(run, flow)).toEqual({
    status: 500,
    body: { error: 'run failed', detail: 'boom: connection refused' },
  });
});

it('returns 500 with a generic body when the run failed but no node error is available', () => {
  const flow = { ...base, id: 'f', name: 'F', edges: [],
    nodes: [{ id: 'n', type: 'HttpRequest', label: 'N', position: { x: 0, y: 0 }, config: {} }] } as unknown as WorkflowDefinition;
  const run = { status: 'failed', nodeStates: { n: { status: 'failed' } } } as never;
  expect(extractResponse(run, flow)).toEqual({ status: 500, body: { error: 'run failed' } });
});

it('a succeeded Response node still wins even if the overall run status looks failed', () => {
  const flow = { ...base, id: 'f', name: 'F', edges: [],
    nodes: [{ id: 'r', type: 'Response', label: 'R', position: { x: 0, y: 0 }, config: {} }] } as unknown as WorkflowDefinition;
  const run = { status: 'failed', nodeStates: { r: { status: 'succeeded', output: { status: 201, body: { ok: true } } } } } as never;
  expect(extractResponse(run, flow)).toEqual({ status: 201, body: { ok: true } });
});
