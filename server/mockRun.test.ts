import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Task 2: Mock serving mode executes runs against scenario mocks, and never
// auto-attaches credentials. Boots the actual runner subprocess (server/index.ts)
// against a scratch project dir carrying: a project node with traceKind 'db'
// (so an unmocked run fails loud with the binding infrastructure message), an
// environment WITH auth configured + a stored secret (so "credential
// auto-attach was skipped" is a meaningful assertion, not a vacuous one), an
// op using the db node, and a scenarios sidecar with op-level mocks + one
// scenario overriding a nodeId. Mirrors the harness in runsAuth.test.ts /
// workflowTestRoute.test.ts.

let proc: ChildProcess;
const PORT = 8152;
const base = `http://127.0.0.1:${PORT}`;
let projectDir: string;

async function waitHealthy(url: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('runner did not become healthy');
}

function bootRunner(port: number, env: Record<string, string | undefined>): ChildProcess {
  return spawn('npx', ['tsx', 'server/index.ts'], {
    env: { ...process.env, EMBERFLOW_RUNNER_PORT: String(port), ...env },
    stdio: 'ignore',
  });
}

const dbFlow = {
  id: 'db-op',
  name: 'DB Op',
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  nodes: [
    {
      id: 'input',
      type: 'Input',
      label: 'Input',
      position: { x: 0, y: 0 },
      config: { fields: [] },
    },
    {
      id: 'dbRead',
      type: 'DbRead',
      label: 'DB Read',
      position: { x: 200, y: 0 },
      config: {},
    },
  ],
  edges: [{ id: 'e1', source: 'input', target: 'dbRead' }],
};

// Task 2 (Critical fix): the child op has its own `traceKind: 'db'` node and
// its own op-level mock — nodeIds are scoped per-flow, so the child must
// consult its OWN sidecar mocks, never the parent's.
const childMockedFlow = {
  id: 'child-mocked-op',
  name: 'Child Mocked Op',
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  nodes: [
    { id: 'input', type: 'Input', label: 'Input', position: { x: 0, y: 0 }, config: { fields: [] } },
    { id: 'childDbRead', type: 'DbRead', label: 'Child DB Read', position: { x: 200, y: 0 }, config: {} },
    {
      id: 'result',
      type: 'Result',
      label: 'Result',
      position: { x: 400, y: 0 },
      config: {},
      inputMap: { data: { sourceNodeId: 'childDbRead', sourceField: '$' } },
    },
  ],
  edges: [
    { id: 'e1', source: 'input', target: 'childDbRead' },
    { id: 'e2', source: 'childDbRead', target: 'result', targetHandle: 'data' },
  ],
};

// A second child op whose db node has NO mock configured anywhere — the
// binding infra failure must surface through the parent's Subflow node.
const childUnmockedFlow = {
  id: 'child-unmocked-op',
  name: 'Child Unmocked Op',
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  nodes: [
    { id: 'input', type: 'Input', label: 'Input', position: { x: 0, y: 0 }, config: { fields: [] } },
    { id: 'childDbRead', type: 'DbRead', label: 'Child DB Read', position: { x: 200, y: 0 }, config: {} },
  ],
  edges: [{ id: 'e1', source: 'input', target: 'childDbRead' }],
};

function subflowParentFlow(id: string, name: string, workflowId: string): Record<string, unknown> {
  return {
    id,
    name,
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    nodes: [
      { id: 'input', type: 'Input', label: 'Input', position: { x: 0, y: 0 }, config: { fields: [] } },
      {
        id: 'subflow',
        type: 'Subflow',
        label: 'Subflow',
        position: { x: 200, y: 0 },
        config: { workflowId },
      },
    ],
    edges: [{ id: 'e1', source: 'input', target: 'subflow' }],
  };
}

/** Fetches the flow (with sidecar-merged scenarios/mocks) via the API,
 *  mirroring how the studio would build the POST /runs body. */
async function loadFlow(opId: string): Promise<any> {
  const listRes = await fetch(`${base}/api/workflows`);
  const { flows } = await listRes.json();
  return flows.find((f: { id: string }) => f.id === opId);
}

async function postRun(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getRun(runId: string): Promise<any> {
  // Drain the SSE replay buffer for the finished event (or latest state) via
  // a short-lived EventSource-less fetch: the events route is SSE, so read
  // the raw stream and parse the last "finished" frame.
  const res = await fetch(`${base}/api/runs/${runId}/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let finished: any;
  const events: any[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    const frames = text.split('\n\n');
    text = frames.pop() ?? '';
    for (const frame of frames) {
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice('data: '.length));
      events.push(event);
      if (event.type === 'finished') finished = event;
    }
    if (finished) break;
  }
  reader.cancel().catch(() => {});
  return { finished, events };
}

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'mockrun-'));
  writeFileSync(
    join(projectDir, 'emberflow.config.mjs'),
    `export default {
  registerNodes(registry) {
    registry.register(
      { type: 'DbRead', label: 'DB Read', traceKind: 'db', inputSchema: { fields: [] } },
      async () => ({ rows: [{ id: 'real-row' }] }),
    );
  },
};\n`,
  );
  writeFileSync(
    join(projectDir, 'emberflow.environments.json'),
    JSON.stringify({
      defaultEnvironment: 'local',
      environments: {
        local: {
          vars: {},
          secrets: { sessionCookie: 'supersecretcookievalue' },
          auth: { attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' } },
        },
      },
    }),
  );

  const apisDir = join(projectDir, 'emberflow', 'apis', 'default');
  mkdirSync(apisDir, { recursive: true });
  writeFileSync(join(apisDir, 'db-op.json'), JSON.stringify(dbFlow));
  writeFileSync(
    join(apisDir, 'db-op.scenarios.json'),
    JSON.stringify({
      scenarios: [
        { id: 's-override', name: 'override', input: {}, mocks: { dbRead: { rows: [{ id: 'scenario-row' }] } } },
      ],
      mocks: { dbRead: { rows: [{ id: 'op-level-row' }] } },
    }),
  );

  // Child op with its OWN op-level mock (nodeId `childDbRead`, disjoint from
  // the parent's mock map — never reused across flows).
  writeFileSync(join(apisDir, 'child-mocked-op.json'), JSON.stringify(childMockedFlow));
  writeFileSync(
    join(apisDir, 'child-mocked-op.scenarios.json'),
    JSON.stringify({ scenarios: [], mocks: { childDbRead: { rows: [{ id: 'child-mocked-row' }] } } }),
  );

  // Child op with NO mocks configured anywhere — forces the infra-no-mock path.
  writeFileSync(join(apisDir, 'child-unmocked-op.json'), JSON.stringify(childUnmockedFlow));

  writeFileSync(
    join(apisDir, 'parent-subflow-mocked-op.json'),
    JSON.stringify(subflowParentFlow('parent-subflow-mocked-op', 'Parent Subflow Mocked Op', 'child-mocked-op')),
  );
  writeFileSync(
    join(apisDir, 'parent-subflow-unmocked-op.json'),
    JSON.stringify(subflowParentFlow('parent-subflow-unmocked-op', 'Parent Subflow Unmocked Op', 'child-unmocked-op')),
  );

  proc = bootRunner(PORT, { EMBERFLOW_PROJECT: projectDir, EMBERFLOW_MOCK: '1' });
  await waitHealthy(`${base}/healthz`);
}, 20_000);

afterAll(() => {
  proc?.kill();
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe('POST /runs in Mock serving mode', () => {
  it('plain run (no scenario) uses op-level mocks and marks the mocked node', async () => {
    const flow = await loadFlow('db-op');
    expect(flow.mocks).toEqual({ dbRead: { rows: [{ id: 'op-level-row' }] } });

    const createRes = await postRun({ flow, mode: 'run', input: {} });
    expect(createRes.status).toBe(201);
    const { runId } = await createRes.json();

    const { finished } = await getRun(runId);
    expect(finished.run.status).toBe('succeeded');
    expect(finished.run.nodeStates.dbRead.mocked).toBe(true);
    expect(finished.run.nodeStates.dbRead.output).toEqual({ rows: [{ id: 'op-level-row' }] });
  });

  it('a named scenario\'s mocks win over op-level mocks for the same nodeId', async () => {
    const flow = await loadFlow('db-op');
    const createRes = await postRun({ flow, mode: 'run', input: {}, scenarioName: 'override' });
    expect(createRes.status).toBe(201);
    const { runId } = await createRes.json();

    const { finished } = await getRun(runId);
    expect(finished.run.status).toBe('succeeded');
    expect(finished.run.nodeStates.dbRead.mocked).toBe(true);
    expect(finished.run.nodeStates.dbRead.output).toEqual({ rows: [{ id: 'scenario-row' }] });
  });

  it('credential auto-attach is skipped entirely in a mock run', async () => {
    const flow = await loadFlow('db-op');
    const createRes = await postRun({ flow, mode: 'run', input: {} });
    const { runId } = await createRes.json();
    const { finished } = await getRun(runId);
    expect(finished.run.status).toBe('succeeded');
    // The Input node's recorded input must carry NO attached cookie — the
    // environment's auth.attach would otherwise inject a `session=...` cookie.
    const inputState = finished.run.nodeStates.input;
    expect(inputState.output?.headers?.cookie).toBeUndefined();
  });

  it('an unmocked infra node fails with the binding infrastructure message (not silently mocked)', async () => {
    const flow = await loadFlow('db-op');
    // Strip mocks entirely to force the infra-no-mock path.
    const flowNoMocks = { ...flow, mocks: undefined, scenarios: undefined };
    const createRes = await postRun({ flow: flowNoMocks, mode: 'run', input: {} });
    const { runId } = await createRes.json();
    const { finished } = await getRun(runId);
    expect(finished.run.status).toBe('failed');
    expect(finished.run.nodeStates.dbRead.error).toContain('would touch real infrastructure');
    expect(finished.run.nodeStates.dbRead.error).toContain('db');
  });

  it('stepped mock runs inherit mockRun/mocks set at creation: stepping through yields the canned output mid-step', async () => {
    const flow = await loadFlow('db-op');
    const createRes = await postRun({ flow, mode: 'step', input: {} });
    expect(createRes.status).toBe(201);
    const { runId } = await createRes.json();

    // Step 1: Input node.
    await fetch(`${base}/api/runs/${runId}/step`, { method: 'POST' });
    // Step 2: dbRead node — should short-circuit to the mocked output.
    await fetch(`${base}/api/runs/${runId}/step`, { method: 'POST' });

    const { finished } = await getRun(runId);
    expect(finished.run.nodeStates.dbRead.mocked).toBe(true);
    expect(finished.run.nodeStates.dbRead.output).toEqual({ rows: [{ id: 'op-level-row' }] });
  });

  it('a Subflow child run in a mock run consults the CHILD op\'s own op-level mocks, never real execution', async () => {
    const flow = await loadFlow('parent-subflow-mocked-op');
    const createRes = await postRun({ flow, mode: 'run', input: {} });
    expect(createRes.status).toBe(201);
    const { runId } = await createRes.json();

    const { finished } = await getRun(runId);
    expect(finished.run.status).toBe('succeeded');
    // The Subflow node itself is traceKind 'compute' (no boundary fires on
    // it directly) — the mock propagation must reach INSIDE the child run.
    // The child's own canned mock ('child-mocked-row') must win — never the
    // parent's mock map (which has no `childDbRead` entry at all) and never
    // the real handler's 'real-row'.
    expect(finished.run.status).toBe('succeeded');
    const output = finished.run.nodeStates.subflow?.output;
    expect(JSON.stringify(output)).toContain('child-mocked-row');
    expect(JSON.stringify(output)).not.toContain('real-row');
  });

  it('a Subflow child with an unmocked infra node fails the parent with the binding infrastructure message', async () => {
    const flow = await loadFlow('parent-subflow-unmocked-op');
    const createRes = await postRun({ flow, mode: 'run', input: {} });
    expect(createRes.status).toBe(201);
    const { runId } = await createRes.json();

    const { finished } = await getRun(runId);
    expect(finished.run.status).toBe('failed');
    expect(finished.run.nodeStates.subflow.error).toContain('would touch real infrastructure');
  });
});

describe('POST /runs in Real serving mode (regression: byte-identical)', () => {
  it('runs for real, attaches credentials, and never mocks', async () => {
    await fetch(`${base}/api/serving`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'real' }),
    });
    try {
      const flow = await loadFlow('db-op');
      const createRes = await postRun({ flow, mode: 'run', input: {} });
      const { runId } = await createRes.json();
      const { finished } = await getRun(runId);
      expect(finished.run.status).toBe('succeeded');
      expect(finished.run.nodeStates.dbRead.mocked).toBeUndefined();
      expect(finished.run.nodeStates.dbRead.output).toEqual({ rows: [{ id: 'real-row' }] });
      // Credential auto-attach happened for real.
      expect(finished.run.nodeStates.input.output?.headers?.cookie).toContain('session=');
    } finally {
      await fetch(`${base}/api/serving`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'mock' }),
      });
    }
  });
});
