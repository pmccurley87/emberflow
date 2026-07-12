import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Verifies GET /environments reports auth status and POST /environments/:name/login
// performs the login flow, persisting the captured credential (Task 5).
// Boots the actual runner subprocess (server/index.ts) against a scratch
// project dir, mirroring the harness in apiMount.test.ts / runsAuth.test.ts.

let proc: ChildProcess;
const PORT = 8131;
const base = `http://127.0.0.1:${PORT}`;
let projectDir: string;

let loginServer: Server;
const LOGIN_PORT = 8132;
let concurrentLoginHits = 0;

// Single-node flow: an Input node that just echoes whatever input the run
// was invoked with (including `headers`) — reused from runsAuth.test.ts's
// harness pattern to prove the run-auto-attach-after-PUT-secret case.
const echoFlow = {
  id: 'echo-input',
  name: 'Echo Input',
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  nodes: [
    {
      id: 'input',
      type: 'Input',
      label: 'Input',
      position: { x: 0, y: 0 },
      config: { fields: [], defaults: {} },
    },
  ],
  edges: [],
};

/** POSTs a step-mode run, steps it once, then reads back the Input node's recorded sample output. */
async function runAndGetInputOutput(input: Record<string, unknown>): Promise<any> {
  const createRes = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flow: echoFlow, mode: 'step', input, environment: 'runattach' }),
  });
  expect(createRes.status).toBe(201);
  const { runId } = await createRes.json();

  const stepRes = await fetch(`${base}/api/runs/${runId}/step`, { method: 'POST' });
  expect(stepRes.status).toBe(200);

  const samplesRes = await fetch(`${base}/api/samples?nodeId=input`);
  expect(samplesRes.status).toBe(200);
  const { samples } = await samplesRes.json();
  const sample = samples.find((s: { runId: string }) => s.runId === runId);
  expect(sample).toBeDefined();
  return sample.output;
}

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

beforeAll(async () => {
  // Tiny stub login target: responds 200 with a Set-Cookie header.
  loginServer = createServer((req, res) => {
    if (req.url === '/login-concurrent') concurrentLoginHits += 1;
    res.setHeader('Set-Cookie', 'session=captured-token; Path=/');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => loginServer.listen(LOGIN_PORT, resolve));

  projectDir = mkdtempSync(join(tmpdir(), 'envroute-'));
  mkdirSync(join(projectDir, 'emberflow', 'apis', 'default'), { recursive: true });
  writeFileSync(join(projectDir, 'emberflow.config.mjs'), 'export default {};\n');
  writeFileSync(
    join(projectDir, 'emberflow.environments.json'),
    JSON.stringify({
      defaultEnvironment: 'dev',
      environments: {
        dev: {
          vars: {},
          secrets: {},
          auth: {
            attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' },
            login: {
              request: { method: 'POST', url: `http://127.0.0.1:${LOGIN_PORT}/login` },
              capture: { from: 'set-cookie', cookieName: 'session' },
            },
          },
        },
        noauth: {
          vars: {},
          secrets: {},
        },
        concurrent: {
          vars: {},
          secrets: {},
          auth: {
            attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' },
            login: {
              request: { method: 'POST', url: `http://127.0.0.1:${LOGIN_PORT}/login-concurrent` },
              capture: { from: 'set-cookie', cookieName: 'session' },
            },
          },
        },
        secrettest: {
          vars: {},
          secrets: {},
        },
        authtest: {
          vars: {},
          secrets: {},
        },
        runattach: {
          vars: {},
          secrets: {},
          auth: { attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' } },
        },
      },
    }),
  );

  proc = bootRunner(PORT, { EMBERFLOW_PROJECT: projectDir });
  await waitHealthy(`${base}/healthz`);
}, 20_000);

afterAll(async () => {
  proc?.kill();
  await new Promise<void>((resolve) => loginServer.close(() => resolve()));
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe('GET /environments auth status', () => {
  it('reports configured true, authenticated false when no secret is stored yet', async () => {
    const res = await fetch(`${base}/api/environments`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const dev = body.environments.find((e: { name: string }) => e.name === 'dev');
    expect(dev.auth).toEqual({
      configured: true,
      authenticated: false,
      secretRef: 'sessionCookie',
      config: {
        attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' },
        login: {
          request: { method: 'POST', url: `http://127.0.0.1:${LOGIN_PORT}/login` },
          capture: { from: 'set-cookie', cookieName: 'session' },
        },
      },
    });
  });

  it('omits auth.configured=false env cleanly (no auth block details leak)', async () => {
    const res = await fetch(`${base}/api/environments`);
    const body = await res.json();
    const noauth = body.environments.find((e: { name: string }) => e.name === 'noauth');
    expect(noauth.auth).toEqual({ configured: false, authenticated: false });
  });

  it('reports configured:true for a project with an environments file', async () => {
    const res = await fetch(`${base}/api/environments`);
    const body = await res.json();
    expect(body.configured).toBe(true);
  });

  it('re-reads the environments file on each GET — agent edits appear without a restart', async () => {
    const envPath = join(projectDir, 'emberflow.environments.json');
    const file = JSON.parse(readFileSync(envPath, 'utf8'));
    file.environments.staging = { vars: { BASE_URL: 'https://staging.example.com' } };
    writeFileSync(envPath, JSON.stringify(file, null, 2));

    const res = await fetch(`${base}/api/environments`);
    const body = await res.json();
    const staging = body.environments.find((e: { name: string }) => e.name === 'staging');
    expect(staging).toBeDefined();
    expect(staging.varKeys).toEqual(['BASE_URL']);
  });
});

describe('POST /environments/:name/login', () => {
  it('400s when the environment has no auth.login configured', async () => {
    const res = await fetch(`${base}/api/environments/noauth/login`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('performs the login, returns authenticated:true, and updates GET /environments in-process', async () => {
    const res = await fetch(`${base}/api/environments/dev/login`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ authenticated: true, secretRef: 'sessionCookie' });
    // no secret value ever returned
    expect(JSON.stringify(body)).not.toContain('captured-token');

    const getRes = await fetch(`${base}/api/environments`);
    const getBody = await getRes.json();
    const dev = getBody.environments.find((e: { name: string }) => e.name === 'dev');
    expect(dev.auth).toEqual({
      configured: true,
      authenticated: true,
      secretRef: 'sessionCookie',
      config: {
        attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' },
        login: {
          request: { method: 'POST', url: `http://127.0.0.1:${LOGIN_PORT}/login` },
          capture: { from: 'set-cookie', cookieName: 'session' },
        },
      },
    });
  });

  it('single-flights two concurrent POST logins to the same environment: upstream hit exactly once, both responses 200', async () => {
    expect(concurrentLoginHits).toBe(0);
    const [res1, res2] = await Promise.all([
      fetch(`${base}/api/environments/concurrent/login`, { method: 'POST' }),
      fetch(`${base}/api/environments/concurrent/login`, { method: 'POST' }),
    ]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const [body1, body2] = await Promise.all([res1.json(), res2.json()]);
    expect(body1).toEqual({ authenticated: true, secretRef: 'sessionCookie' });
    expect(body2).toEqual({ authenticated: true, secretRef: 'sessionCookie' });
    expect(concurrentLoginHits).toBe(1);
  });
});

describe('PUT /environments/:name/secrets/:key', () => {
  it('404s for an unknown environment', async () => {
    const res = await fetch(`${base}/api/environments/nope/secrets/foo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('400s when value is missing or not a string', async () => {
    const missing = await fetch(`${base}/api/environments/secrettest/secrets/apiKey`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBeTruthy();

    const nonString = await fetch(`${base}/api/environments/secrettest/secrets/apiKey`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 42 }),
    });
    expect(nonString.status).toBe(400);
    expect((await nonString.json()).error).toBeTruthy();
  });

  it('204s with an empty body, never echoing the value, and GET /environments shows the key (not the value)', async () => {
    const putRes = await fetch(`${base}/api/environments/secrettest/secrets/apiKey`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'super-secret-value' }),
    });
    expect(putRes.status).toBe(204);
    const text = await putRes.text();
    expect(text).toBe('');
    expect(text).not.toContain('super-secret-value');

    const getRes = await fetch(`${base}/api/environments`);
    const getBody = await getRes.json();
    expect(JSON.stringify(getBody)).not.toContain('super-secret-value');
    const env = getBody.environments.find((e: { name: string }) => e.name === 'secrettest');
    expect(env.secretKeys).toContain('apiKey');
  });
});

describe('DELETE /environments/:name/secrets/:key', () => {
  it('404s for an unknown environment', async () => {
    const res = await fetch(`${base}/api/environments/nope/secrets/apiKey`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('204s and removes the key from GET /environments secretKeys', async () => {
    // Depends on the PUT test above having set secrettest.apiKey.
    const delRes = await fetch(`${base}/api/environments/secrettest/secrets/apiKey`, { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    const getRes = await fetch(`${base}/api/environments`);
    const getBody = await getRes.json();
    const env = getBody.environments.find((e: { name: string }) => e.name === 'secrettest');
    expect(env.secretKeys).not.toContain('apiKey');
  });
});

describe('PUT /environments/:name/auth', () => {
  it('404s for an unknown environment', async () => {
    const res = await fetch(`${base}/api/environments/nope/auth`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' } }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('400s on an invalid auth shape', async () => {
    const res = await fetch(`${base}/api/environments/authtest/auth`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attach: { as: 'nope', name: 'session', secretRef: 'sessionCookie' } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('204s on success and GET /environments reflects auth.config', async () => {
    const putRes = await fetch(`${base}/api/environments/authtest/auth`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attach: { as: 'header', name: 'X-Api-Key', secretRef: 'apiKeySecret' } }),
    });
    expect(putRes.status).toBe(204);
    expect(await putRes.text()).toBe('');

    const getRes = await fetch(`${base}/api/environments`);
    const getBody = await getRes.json();
    const env = getBody.environments.find((e: { name: string }) => e.name === 'authtest');
    expect(env.auth.config).toEqual({
      attach: { as: 'header', name: 'X-Api-Key', secretRef: 'apiKeySecret' },
    });
  });

  it('204s clearing auth with a null body, and GET /environments omits config', async () => {
    const putRes = await fetch(`${base}/api/environments/authtest/auth`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(null),
    });
    expect(putRes.status).toBe(204);

    const getRes = await fetch(`${base}/api/environments`);
    const getBody = await getRes.json();
    const env = getBody.environments.find((e: { name: string }) => e.name === 'authtest');
    expect(env.auth).toEqual({ configured: false, authenticated: false });
  });
});

describe('a run auto-attaches a PUT-set secret (proves in-memory refresh)', () => {
  it('attaches the session cookie from a secret set via PUT, without a restart', async () => {
    const putRes = await fetch(`${base}/api/environments/runattach/secrets/sessionCookie`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'freshly-put-cookie' }),
    });
    expect(putRes.status).toBe(204);

    const output = await runAndGetInputOutput({});
    expect(output.headers.cookie).toContain('session=«secret:sessionCookie»');
  });
});
