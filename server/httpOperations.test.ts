import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeOperationHandler, type OperationRunEnv } from './httpOperations';
import { extractResponse } from './operationResult';
import { RunRegistry } from './runRegistry';
import { createDefaultRegistry } from '../src/nodes';
import type { AuthPolicy, WorkflowDefinition } from '../src/engine';
import { createDefaultVerifierRegistry } from './auth/verifiers';

const base = { version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

let server: Server | undefined;

/** Boot the op's handler on an ephemeral port; returns the base URL. */
function boot(op: WorkflowDefinition): Promise<string> {
  const runs = new RunRegistry(() => undefined, createDefaultRegistry());
  const app = express();
  app.use(express.json());
  const method = op.http!.method.toLowerCase() as 'post' | 'get';
  app[method](op.http!.path, makeOperationHandler({ runs, op }));
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe('makeOperationHandler', () => {
  it('400s when the body fails the input schema', async () => {
    const op = {
      ...base,
      id: 'o',
      name: 'O',
      nodes: [],
      edges: [],
      http: { method: 'POST', path: '/things', inputSchema: { type: 'object', required: ['name'] } },
    } as unknown as WorkflowDefinition;

    const url = await boot(op);
    const res = await fetch(`${url}/things`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/);
  });

  it('runs the flow and returns the Response node status/body', async () => {
    // Input node echoes the run's whole input ({params, query, body, headers});
    // Response node's inputMap pulls `body` from it and pins status to 201.
    const op = {
      ...base,
      id: 'echo',
      name: 'Echo',
      http: { method: 'POST', path: '/echo' },
      nodes: [
        {
          id: 'input',
          type: 'Input',
          label: 'Input',
          position: { x: 0, y: 0 },
          config: { fields: [], defaults: {} },
        },
        {
          id: 'response',
          type: 'Response',
          label: 'Response',
          position: { x: 200, y: 0 },
          config: { status: 201 },
          inputMap: {
            body: { sourceNodeId: 'input', sourceField: 'body' },
          },
        },
      ],
      edges: [{ id: 'e1', source: 'input', target: 'response' }],
    } as unknown as WorkflowDefinition;

    const url = await boot(op);
    const res = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 42, name: 'widget' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ id: 42, name: 'widget' });
  });
});

describe('run input promotes body fields to the top level', () => {
  it('a flow node reading from(\'input\', \'x\') (a domain field posted in the body) resolves it, while input.body.x still works too', async () => {
    // Input node echoes the run's whole input; Response node's inputMap
    // pulls the top-level promoted field (`x`) straight off the Input
    // node's output as the response body, proving `from('input','x')`
    // resolves a field that only exists in the posted request body.
    const op = {
      ...base,
      id: 'promote',
      name: 'Promote',
      http: { method: 'POST', path: '/promote' },
      nodes: [
        {
          id: 'input',
          type: 'Input',
          label: 'Input',
          position: { x: 0, y: 0 },
          config: { fields: [], defaults: {} },
        },
        {
          id: 'response',
          type: 'Response',
          label: 'Response',
          position: { x: 200, y: 0 },
          config: { status: 200 },
          inputMap: {
            body: { sourceNodeId: 'input', sourceField: 'x' },
          },
        },
      ],
      edges: [{ id: 'e1', source: 'input', target: 'response' }],
    } as unknown as WorkflowDefinition;

    const url = await boot(op);
    const res = await fetch(`${url}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 'domain-value' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBe('domain-value');
  });

  it('passes the merged input (top-level body fields + body/params/query/headers/user) to runs.create', async () => {
    const op = {
      ...base,
      id: 'spy-op',
      name: 'SpyOp',
      nodes: [],
      edges: [],
      http: { method: 'POST', path: '/spy' },
    } as unknown as WorkflowDefinition;

    const createSpy = vi.fn().mockReturnValue({
      handle: { runToEnd: () => Promise.resolve({ nodeStates: {} } as unknown as import('../src/engine').WorkflowRun) },
    });
    const stubRuns = { create: createSpy } as unknown as import('./runRegistry').RunRegistry;

    const app = express();
    app.use(express.json());
    app.post(op.http!.path, makeOperationHandler({ runs: stubRuns, op }));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const addr = server!.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    await fetch(`http://127.0.0.1:${port}${op.http!.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 'domain-value', body: 'shadowed-by-request-body-key' }),
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const opts = createSpy.mock.calls[0][1] as { input: Record<string, unknown> };
    // Domain field promoted to the top...
    expect(opts.input.x).toBe('domain-value');
    // ...but the request's own `body` key always wins over a same-named
    // field inside the posted body (params/query/body/headers/user last).
    expect(opts.input.body).toEqual({ x: 'domain-value', body: 'shadowed-by-request-body-key' });
  });
});

describe('auth policy enforcement', () => {
  const policy: AuthPolicy = { scheme: 'bearer', secretRef: 'T' };
  const env: OperationRunEnv = { secrets: { T: 'good' }, vars: {}, environment: 'default', safeMode: false };

  // Input node echoes the run's whole input ({params, query, body, headers,
  // user}); Response node pulls `user` from it so we can assert the resolved
  // auth `user` was carried into the run input.
  const op = {
    ...base,
    id: 'secure-echo',
    name: 'SecureEcho',
    http: { method: 'POST', path: '/secure-echo' },
    nodes: [
      {
        id: 'input',
        type: 'Input',
        label: 'Input',
        position: { x: 0, y: 0 },
        config: { fields: [], defaults: {} },
      },
      {
        id: 'response',
        type: 'Response',
        label: 'Response',
        position: { x: 200, y: 0 },
        config: { status: 200 },
        inputMap: {
          body: { sourceNodeId: 'input', sourceField: 'user' },
        },
      },
    ],
    edges: [{ id: 'e1', source: 'input', target: 'response' }],
  } as unknown as WorkflowDefinition;

  function bootSecure(): Promise<string> {
    const runs = new RunRegistry(() => undefined, createDefaultRegistry());
    const verifiers = createDefaultVerifierRegistry();
    const app = express();
    app.use(express.json());
    app.post(op.http!.path, makeOperationHandler({ runs, op, env, policy, verifiers }));
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  it('401s a request with no Authorization header (auth precedes the run/body)', async () => {
    const url = await bootSecure();
    const res = await fetch(`${url}${op.http!.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('runs and carries `user` into the run input when the bearer token matches', async () => {
    const url = await bootSecure();
    const res = await fetch(`${url}${op.http!.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ scheme: 'bearer' });
  });
});

describe('500 handling', () => {
  it('returns a generic error body (not the raw message) when a node throws a non-HttpError, and logs the real error server-side', async () => {
    const secretMessage = 'connection failed: postgres://user:hunter2@db.internal/prod';
    const op = {
      ...base,
      id: 'boom',
      name: 'Boom',
      nodes: [],
      edges: [],
      http: { method: 'POST', path: '/boom' },
    } as unknown as WorkflowDefinition;

    // Stub RunRegistry: runToEnd rejects with an Error whose message would
    // leak a secret if echoed straight to the client.
    const stubRuns = {
      create: () => ({
        runId: 'r1',
        handle: { runToEnd: () => Promise.reject(new Error(secretMessage)) },
      }),
    } as unknown as import('./runRegistry').RunRegistry;

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = express();
    app.use(express.json());
    app.post(op.http!.path, makeOperationHandler({ runs: stubRuns, op }));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const addr = server!.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}${op.http!.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'internal error' });
    expect(JSON.stringify(body)).not.toMatch(/hunter2/);

    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedArgs = consoleErrorSpy.mock.calls.flat();
    expect(loggedArgs.some((a) => a instanceof Error && a.message === secretMessage)).toBe(true);

    consoleErrorSpy.mockRestore();
  });
});

describe('parity: in-studio Run vs live HTTP endpoint', () => {
  // Same op as the "echo" case above: Input node passes the run's whole
  // input ({params, query, body, headers}) through; Response node pulls
  // `body` from it and pins status to 201.
  const op = {
    ...base,
    id: 'echo-parity',
    name: 'EchoParity',
    http: { method: 'POST', path: '/echo-parity' },
    nodes: [
      {
        id: 'input',
        type: 'Input',
        label: 'Input',
        position: { x: 0, y: 0 },
        config: { fields: [], defaults: {} },
      },
      {
        id: 'response',
        type: 'Response',
        label: 'Response',
        position: { x: 200, y: 0 },
        config: { status: 201 },
        inputMap: {
          body: { sourceNodeId: 'input', sourceField: 'body' },
        },
      },
    ],
    edges: [{ id: 'e1', source: 'input', target: 'response' }],
  } as unknown as WorkflowDefinition;

  const requestBody = { id: 7, name: 'gizmo' };

  it('the live HTTP endpoint and a direct RunRegistry.create (as the studio Run/scenario would issue) yield identical {status, body}', async () => {
    // (a) Live HTTP path: makeOperationHandler over an in-process express listen+fetch.
    const httpRuns = new RunRegistry(() => undefined, createDefaultRegistry());
    const app = express();
    app.use(express.json());
    app.post(op.http!.path, makeOperationHandler({ runs: httpRuns, op }));
    const url = await new Promise<string>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    const httpRes = await fetch(`${url}${op.http!.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const httpResult = { status: httpRes.status, body: await httpRes.json() };

    // (b) In-studio Run path: RunRegistry.create with a scenario-shaped input
    // ({ body }) — the same request shape an operation scenario carries —
    // run to completion, then extractResponse maps the Response node output.
    const studioRuns = new RunRegistry(() => undefined, createDefaultRegistry());
    const { handle } = studioRuns.create(op, {
      secrets: {},
      vars: {},
      environment: 'default',
      safeMode: false,
      input: { body: requestBody },
    });
    const run = await handle.runToEnd();
    const studioResult = extractResponse(run, op);

    expect(studioResult).toEqual(httpResult);
    expect(httpResult).toEqual({ status: 201, body: requestBody });
  });
});
