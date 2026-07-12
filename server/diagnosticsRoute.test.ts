import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Verifies GET /workflows/:id/diagnostics (Task 2) plus normalize-on-write
// (seedParamDefaults called from PUT /workflows/:id and POST /operations
// before persisting). Boots the real runner subprocess against a scratch
// project dir, mirroring server/workflowTestRoute.test.ts's harness.

let proc: ChildProcess;
const PORT = 8146;
const base = `http://127.0.0.1:${PORT}`;
let projectDir: string;
let apisDir: string;

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

function noParamOp(id: string) {
  return {
    id,
    name: id,
    version: 1,
    http: { method: 'GET', path: `/${id}` },
    nodes: [
      {
        id: 'input',
        type: 'Input',
        label: 'Input',
        position: { x: 0, y: 0 },
        config: { fields: [] },
      },
      {
        id: 'response',
        type: 'Response',
        label: 'Response',
        position: { x: 200, y: 0 },
        config: { status: 200, body: { ok: true } },
      },
    ],
    edges: [{ id: 'e1', source: 'input', target: 'response' }],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function withParamNoDefault(id: string) {
  const op = noParamOp(id);
  op.http = { method: 'GET', path: `/${id}/:id` };
  return op;
}

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'diagnosticsroute-'));
  writeFileSync(join(projectDir, 'emberflow.config.mjs'), 'export default {};\n');
  apisDir = join(projectDir, 'emberflow', 'apis', 'default');
  mkdirSync(apisDir, { recursive: true });

  writeFileSync(join(apisDir, 'needs-default.json'), JSON.stringify(withParamNoDefault('needs-default')));

  proc = bootRunner(PORT, { EMBERFLOW_PROJECT: projectDir });
  await waitHealthy(`${base}/healthz`);
}, 20_000);

afterAll(async () => {
  proc?.kill();
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe('GET /workflows/:id/diagnostics', () => {
  it('includes missing-param-default for a path param with no default', async () => {
    const res = await fetch(`${base}/api/workflows/needs-default/diagnostics`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const codes = body.diagnostics.map((d: { code: string }) => d.code);
    expect(codes).toContain('missing-param-default');
    const diag = body.diagnostics.find((d: { code: string }) => d.code === 'missing-param-default');
    expect(diag.severity).toBe('warning');
    expect(diag.param).toBe('id');
  });

  it('404s for an unknown op id', async () => {
    const res = await fetch(`${base}/api/workflows/no-such-op/diagnostics`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});

describe('normalize-on-write: PUT /workflows/:id', () => {
  it('seeds an empty-string default for a path param missing one, and persists it to disk', async () => {
    const flow = withParamNoDefault('default/put-seed-test');
    const createRes = await fetch(`${base}/api/operations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow, path: 'default/put-seed-test' }),
    });
    expect(createRes.status).toBe(201);

    const putRes = await fetch(`${base}/api/workflows/${encodeURIComponent('default/put-seed-test')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flow),
    });
    expect(putRes.status).toBe(200);

    const onDisk = JSON.parse(readFileSync(join(apisDir, 'put-seed-test.json'), 'utf8'));
    expect(onDisk.nodes.find((n: { type: string }) => n.type === 'Input').config.defaults.params.id).toBe('');
  });

  it('preserves an existing real default value on PUT — never overwrites', async () => {
    const flow = withParamNoDefault('default/put-preserve-test');
    (flow.nodes[0] as { config: Record<string, unknown> }).config = {
      fields: [],
      defaults: { params: { id: 'real-id-value' } },
    };
    const createRes = await fetch(`${base}/api/operations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow, path: 'default/put-preserve-test' }),
    });
    expect(createRes.status).toBe(201);

    const putRes = await fetch(`${base}/api/workflows/${encodeURIComponent('default/put-preserve-test')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flow),
    });
    expect(putRes.status).toBe(200);

    const onDisk = JSON.parse(readFileSync(join(apisDir, 'put-preserve-test.json'), 'utf8'));
    expect(onDisk.nodes.find((n: { type: string }) => n.type === 'Input').config.defaults.params.id).toBe(
      'real-id-value',
    );
  });
});

describe('normalize-on-write: POST /operations', () => {
  it('seeds an empty-string default for a path param missing one, and persists it to disk', async () => {
    const flow = withParamNoDefault('default/post-seed-test');
    const res = await fetch(`${base}/api/operations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow, path: 'default/post-seed-test' }),
    });
    expect(res.status).toBe(201);

    const onDisk = JSON.parse(readFileSync(join(apisDir, 'post-seed-test.json'), 'utf8'));
    expect(onDisk.nodes.find((n: { type: string }) => n.type === 'Input').config.defaults.params.id).toBe('');
  });
});
