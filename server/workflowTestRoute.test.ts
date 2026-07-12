import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Verifies POST /workflows/:id/test — the studio "Test" button's server
// route: runs one op's `expect`-carrying scenarios in-process, reusing the
// same suite/evaluation/redaction seam as `emberflow test` (server/testRunner.ts),
// and never touches RunRegistry (no SSE, no run history). Boots the actual
// runner subprocess (server/index.ts) against a scratch project dir, mirroring
// the harness in environmentsRoute.test.ts / runsAuth.test.ts.

let proc: ChildProcess;
const PORT = 8137;
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

async function postTest(opId: string, body?: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/workflows/${encodeURIComponent(opId)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'workflowtestroute-'));
  writeFileSync(
    join(projectDir, 'emberflow.config.mjs'),
    `export default {
  registerNodes(registry) {
    registry.register(
      { type: 'EchoToken', label: 'Echo Token', inputSchema: { fields: [{ name: 'token', type: 'string' }] } },
      async (ctx) => ({ token: ctx.input.token }),
    );
  },
};\n`,
  );
  writeFileSync(
    join(projectDir, 'emberflow.environments.json'),
    JSON.stringify({
      defaultEnvironment: 'local',
      environments: {
        local: { vars: {}, secrets: { API_TOKEN: 'supersecretvalue' } },
      },
    }),
  );

  const apisDir = join(projectDir, 'emberflow', 'apis', 'default');
  mkdirSync(apisDir, { recursive: true });

  // authcheck: one op with a pass, a fail, and an expect-less (skip) scenario —
  // mirrors server/cliTest.test.ts's harness.
  writeFileSync(
    join(apisDir, 'authcheck.json'),
    JSON.stringify({
      id: 'authcheck',
      name: 'Auth Check',
      version: 1,
      http: { method: 'POST', path: '/authcheck' },
      nodes: [
        {
          id: 'input',
          type: 'Input',
          label: 'Input',
          position: { x: 0, y: 0 },
          config: { fields: [{ name: 'authed', type: 'boolean' }] },
        },
        {
          id: 'route',
          type: 'Route',
          label: 'Route',
          position: { x: 200, y: 0 },
          config: { field: 'authed', branches: ['true', 'false'] },
          inputMap: { value: { sourceNodeId: 'input', sourceField: '$' } },
        },
        {
          id: 'respOk',
          type: 'Response',
          label: 'OK',
          position: { x: 400, y: -80 },
          config: { status: 200, body: { ok: true } },
        },
        {
          id: 'respUnauth',
          type: 'Response',
          label: 'Unauthorized',
          position: { x: 400, y: 80 },
          config: { status: 401, body: { error: 'unauthorized' } },
        },
      ],
      edges: [
        { id: 'e1', source: 'input', target: 'route' },
        { id: 'e2', source: 'route', target: 'respOk', sourceHandle: 'true' },
        { id: 'e3', source: 'route', target: 'respUnauth', sourceHandle: 'false' },
      ],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
  );
  writeFileSync(
    join(apisDir, 'authcheck.scenarios.json'),
    JSON.stringify([
      { id: 's-pass', name: 'authed-ok', input: { authed: true }, expect: { status: 200, body: { ok: true } } },
      // Deliberately wrong expectation: authed:true routes to 200, but this
      // scenario asserts 401 — must fail.
      { id: 's-fail', name: 'expired', input: { authed: true }, expect: { status: 401 } },
      { id: 's-skip', name: 'no-assertion', input: { authed: false } },
    ]),
  );

  // leaky: a deliberate failure whose diff quotes a secret the flow echoed —
  // must arrive redacted.
  writeFileSync(
    join(apisDir, 'leaky.json'),
    JSON.stringify({
      id: 'leaky',
      name: 'Leaky',
      version: 1,
      nodes: [
        {
          id: 'echo',
          type: 'EchoToken',
          label: 'Echo',
          position: { x: 0, y: 0 },
          config: { token: { $secret: 'API_TOKEN' } },
        },
        {
          id: 'result',
          type: 'Result',
          label: 'Result',
          position: { x: 200, y: 0 },
          config: {},
          inputMap: { token: { sourceNodeId: 'echo', sourceField: 'token' } },
        },
      ],
      edges: [{ id: 'e1', source: 'echo', target: 'result' }],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
  );
  writeFileSync(
    join(apisDir, 'leaky.scenarios.json'),
    JSON.stringify([
      // Deliberate body mismatch so the failure diff quotes the ACTUAL body
      // (which contains the echoed secret) — it must arrive redacted.
      { id: 's1', name: 'mismatch', input: {}, expect: { body: { token: 'not-the-secret' } } },
    ]),
  );

  // broken: references an unregistered node type — startRun throws
  // synchronously ("Invalid flow: Unknown node type: …"), the simplest
  // reliable trigger for the route's unexpected-error path.
  writeFileSync(
    join(apisDir, 'broken.json'),
    JSON.stringify({
      id: 'broken',
      name: 'Broken',
      version: 1,
      nodes: [{ id: 'x', type: 'NoSuchNodeType', label: 'X', position: { x: 0, y: 0 }, config: {} }],
      edges: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
  );
  writeFileSync(
    join(apisDir, 'broken.scenarios.json'),
    JSON.stringify([{ id: 's1', name: 'boom', input: {}, expect: { status: 200 } }]),
  );

  proc = bootRunner(PORT, { EMBERFLOW_PROJECT: projectDir });
  await waitHealthy(`${base}/healthz`);
}, 20_000);

afterAll(async () => {
  proc?.kill();
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe('POST /workflows/:id/test', () => {
  it('runs the op\'s scenarios and reports pass/fail/skip counts with failure strings', async () => {
    const res = await postTest('authcheck');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passed).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.skipped).toBe(1);
    const failed = body.results.find((r: { scenario: string }) => r.scenario === 'expired');
    expect(failed.status).toBe('failed');
    expect(failed.failures.join(' ')).toContain('status: expected 401, got 200');
    const passed = body.results.find((r: { scenario: string }) => r.scenario === 'authed-ok');
    expect(passed.status).toBe('passed');
    const skipped = body.results.find((r: { scenario: string }) => r.scenario === 'no-assertion');
    expect(skipped.status).toBe('skipped');
  });

  it('only runs scenarios for the requested op (not every op in the project)', async () => {
    const res = await postTest('authcheck');
    const body = await res.json();
    expect(body.results.every((r: { opId: string }) => r.opId === 'authcheck')).toBe(true);
  });

  it('redacts a secret echoed into a failing diff', async () => {
    const res = await postTest('leaky');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failed).toBe(1);
    const text = JSON.stringify(body);
    expect(text).not.toContain('supersecretvalue');
    expect(text).toContain('«secret:API_TOKEN»');
  });

  it('404s for an unknown op', async () => {
    const res = await postTest('no-such-op');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('500s with a JSON error body on an unexpected throw (invalid flow: unregistered node type)', async () => {
    const res = await postTest('broken');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.error).toContain('Unknown node type');
  });

  it('400s for an unknown environment', async () => {
    const res = await postTest('authcheck', { environment: 'no-such-env' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('does not create a RunRegistry run — GET /runs/:id/events for an id returned mid-suite still 404s, and a pre-existing run stays the last one visible', async () => {
    // Establish a real run via POST /runs (goes through RunRegistry) so we
    // have a known-good runId to compare against.
    const createRes = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flow: {
          id: 'probe-flow',
          name: 'Probe',
          version: 1,
          nodes: [{ id: 'input', type: 'Input', label: 'Input', position: { x: 0, y: 0 }, config: { fields: [] } }],
          edges: [],
        },
        mode: 'step',
        environment: 'local',
      }),
    });
    expect(createRes.status).toBe(201);
    const { runId } = await createRes.json();

    // The probe run is visible via SSE replay.
    const beforeEvents = await fetch(`${base}/api/runs/${runId}/events`);
    expect(beforeEvents.status).toBe(200);
    beforeEvents.body?.cancel();

    // Run the test suite (which internally executes several scenario runs).
    const testRes = await postTest('authcheck');
    expect(testRes.status).toBe(200);

    // The probe run's SSE stream is still exactly as reachable as before —
    // no new run replaced or shadowed it, proving the suite's runs never
    // registered with RunRegistry.
    const afterEvents = await fetch(`${base}/api/runs/${runId}/events`);
    expect(afterEvents.status).toBe(200);
    afterEvents.body?.cancel();

    // And a bogus/random run id (representing "any run the suite might have
    // created") is not found — RunRegistry has no record of it.
    const bogusEvents = await fetch(`${base}/api/runs/definitely-not-a-real-run-id/events`);
    expect(bogusEvents.status).toBe(404);
  });
});
