import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli';

// Task 6: `--mock` serving. Boots the real runner subprocess twice — once
// with EMBERFLOW_MOCK=1 (mounted HTTP operations answer from scenario
// expectations, no nodes execute) and once without (unchanged, real
// execution) — against a scratch project with two routed operations:
// `ping` (has scenarios with/without `expect`) and `echo` (no scenarios at
// all, for the 501 case).

const MOCK_PORT = 8142;
const LIVE_PORT = 8143;
const RUNTIME_PORT = 8145;
const NO_ENV_PORT = 8148;
const WITH_ENV_PORT = 8149;
const WITH_ENV_MOCK_PORT = 8150;
const mockBase = `http://127.0.0.1:${MOCK_PORT}`;
const liveBase = `http://127.0.0.1:${LIVE_PORT}`;
const runtimeBase = `http://127.0.0.1:${RUNTIME_PORT}`;
const noEnvBase = `http://127.0.0.1:${NO_ENV_PORT}`;
const withEnvBase = `http://127.0.0.1:${WITH_ENV_PORT}`;
const withEnvMockBase = `http://127.0.0.1:${WITH_ENV_MOCK_PORT}`;

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

async function postServing(base: string, mode: unknown): Promise<Response> {
  return fetch(`${base}/serving`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
}

let mockProc: ChildProcess;
let liveProc: ChildProcess;
let runtimeProc: ChildProcess;
let noEnvProc: ChildProcess;
let withEnvProc: ChildProcess;
let withEnvMockProc: ChildProcess;
let projectDir: string;
let runtimeProjectDir: string;
let noEnvProjectDir: string;
let withEnvProjectDir: string;

/** Writes a minimal routed `ping` op (+ scenario) under `dir`, the smallest
 * fixture needed to prove which serving mode answered a mounted route. */
function writePingOp(dir: string): void {
  mkdirSync(join(dir, 'emberflow', 'apis', 'default'), { recursive: true });
  writeFileSync(join(dir, 'emberflow.config.mjs'), 'export default {};\n');
  writeFileSync(
    join(dir, 'emberflow', 'apis', 'default', 'ping.json'),
    JSON.stringify({
      id: 'ping',
      name: 'Ping',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      http: { method: 'GET', path: '/ping' },
      nodes: [
        {
          id: 'response',
          type: 'Response',
          label: 'Response',
          position: { x: 0, y: 0 },
          config: { status: 200, body: { real: true } },
        },
      ],
      edges: [],
    }),
  );
  writeFileSync(
    join(dir, 'emberflow', 'apis', 'default', 'ping.scenarios.json'),
    JSON.stringify([{ name: 'ok', input: {}, expect: { status: 200, body: { pong: true } } }]),
  );
}

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'mockserve-'));
  mkdirSync(join(projectDir, 'emberflow', 'apis', 'default'), { recursive: true });
  writeFileSync(join(projectDir, 'emberflow.config.mjs'), 'export default {};\n');
  // This suite is specifically about the EMBERFLOW_MOCK flag, not the
  // default-mock-when-unconfigured behavior (covered separately below), so
  // give the project a configured environment to keep liveBase real.
  writeFileSync(
    join(projectDir, 'emberflow.environments.json'),
    JSON.stringify({
      defaultEnvironment: 'local',
      environments: { local: { vars: { BASE_URL: 'http://example.test' }, secrets: {} } },
    }),
  );

  // `ping`: a real Response node the mock must NOT execute — its live body
  // differs from the scenario's mocked body, so a passing assertion proves
  // which path answered.
  writeFileSync(
    join(projectDir, 'emberflow', 'apis', 'default', 'ping.json'),
    JSON.stringify({
      id: 'ping',
      name: 'Ping',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      http: { method: 'GET', path: '/ping' },
      nodes: [
        {
          id: 'response',
          type: 'Response',
          label: 'Response',
          position: { x: 0, y: 0 },
          config: { status: 200, body: { real: true } },
        },
      ],
      edges: [],
    }),
  );
  writeFileSync(
    join(projectDir, 'emberflow', 'apis', 'default', 'ping.scenarios.json'),
    JSON.stringify([
      { name: 'ok', input: {}, expect: { status: 200, body: { pong: true } } },
      { name: 'teapot', input: {}, expect: { status: 418, body: { pong: 'teapot' } } },
    ]),
  );

  // `echo`: routed op with a scenario that has NO `expect` — nothing
  // mockable, so mock mode must answer 501.
  writeFileSync(
    join(projectDir, 'emberflow', 'apis', 'default', 'echo.json'),
    JSON.stringify({
      id: 'echo',
      name: 'Echo',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      http: { method: 'GET', path: '/echo' },
      nodes: [
        {
          id: 'response',
          type: 'Response',
          label: 'Response',
          position: { x: 0, y: 0 },
          config: { status: 200, body: { real: true } },
        },
      ],
      edges: [],
    }),
  );
  writeFileSync(
    join(projectDir, 'emberflow', 'apis', 'default', 'echo.scenarios.json'),
    JSON.stringify([{ name: 'no-expect', input: {} }]),
  );

  mockProc = bootRunner(MOCK_PORT, { EMBERFLOW_PROJECT: projectDir, EMBERFLOW_MOCK: '1' });
  liveProc = bootRunner(LIVE_PORT, { EMBERFLOW_PROJECT: projectDir });

  // A second scratch project for the runtime-flip suite below, boot WITHOUT
  // EMBERFLOW_MOCK (real by default) so POST /serving is what flips it. Also
  // carries a bearer-protected op so the no-auth-in-mock property stays
  // test-asserted: real 401s it, mock answers it straight from the scenario.
  runtimeProjectDir = mkdtempSync(join(tmpdir(), 'mockserve-runtime-'));
  mkdirSync(join(runtimeProjectDir, 'emberflow', 'apis', 'default'), { recursive: true });
  mkdirSync(join(runtimeProjectDir, 'emberflow', 'apis', 'secure'), { recursive: true });
  writeFileSync(join(runtimeProjectDir, 'emberflow.config.mjs'), 'export default {};\n');
  writeFileSync(
    join(runtimeProjectDir, 'emberflow.environments.json'),
    JSON.stringify({
      defaultEnvironment: 'local',
      environments: { local: { vars: {}, secrets: { API_TOKEN: 'topsecret' } } },
    }),
  );
  writeFileSync(
    join(runtimeProjectDir, 'emberflow', 'apis', 'default', 'ping.json'),
    JSON.stringify({
      id: 'ping',
      name: 'Ping',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      http: { method: 'GET', path: '/ping' },
      nodes: [
        {
          id: 'response',
          type: 'Response',
          label: 'Response',
          position: { x: 0, y: 0 },
          config: { status: 200, body: { real: true } },
        },
      ],
      edges: [],
    }),
  );
  writeFileSync(
    join(runtimeProjectDir, 'emberflow', 'apis', 'default', 'ping.scenarios.json'),
    JSON.stringify([{ name: 'ok', input: {}, expect: { status: 200, body: { pong: true } } }]),
  );
  // apis/secure/: every op under here inherits a bearer auth policy — the
  // real path must enforce it, the mock path must not.
  writeFileSync(
    join(runtimeProjectDir, 'emberflow', 'apis', 'secure', '_meta.json'),
    JSON.stringify({ auth: { scheme: 'bearer', secretRef: 'API_TOKEN' } }),
  );
  writeFileSync(
    join(runtimeProjectDir, 'emberflow', 'apis', 'secure', 'protected.json'),
    JSON.stringify({
      id: 'protected',
      name: 'Protected',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      http: { method: 'GET', path: '/protected' },
      nodes: [
        {
          id: 'response',
          type: 'Response',
          label: 'Response',
          position: { x: 0, y: 0 },
          config: { status: 200, body: { real: true } },
        },
      ],
      edges: [],
    }),
  );
  writeFileSync(
    join(runtimeProjectDir, 'emberflow', 'apis', 'secure', 'protected.scenarios.json'),
    JSON.stringify([{ name: 'ok', input: {}, expect: { status: 200, body: { mocked: true } } }]),
  );
  runtimeProc = bootRunner(RUNTIME_PORT, { EMBERFLOW_PROJECT: runtimeProjectDir });

  // Task 1 (default-mock) fixtures.
  // No environments file at all, no EMBERFLOW_MOCK: should default to mock.
  noEnvProjectDir = mkdtempSync(join(tmpdir(), 'mockserve-noenv-'));
  writePingOp(noEnvProjectDir);
  noEnvProc = bootRunner(NO_ENV_PORT, { EMBERFLOW_PROJECT: noEnvProjectDir });

  // Environments file WITH a configured environment (non-empty vars),
  // shared by both the plain-real and the EMBERFLOW_MOCK=1-forces-mock cases.
  withEnvProjectDir = mkdtempSync(join(tmpdir(), 'mockserve-withenv-'));
  writePingOp(withEnvProjectDir);
  writeFileSync(
    join(withEnvProjectDir, 'emberflow.environments.json'),
    JSON.stringify({
      defaultEnvironment: 'local',
      environments: { local: { vars: { BASE_URL: 'http://example.test' }, secrets: {} } },
    }),
  );
  withEnvProc = bootRunner(WITH_ENV_PORT, { EMBERFLOW_PROJECT: withEnvProjectDir });
  withEnvMockProc = bootRunner(WITH_ENV_MOCK_PORT, {
    EMBERFLOW_PROJECT: withEnvProjectDir,
    EMBERFLOW_MOCK: '1',
  });

  await Promise.all([
    waitHealthy(`${mockBase}/healthz`),
    waitHealthy(`${liveBase}/healthz`),
    waitHealthy(`${runtimeBase}/healthz`),
    waitHealthy(`${noEnvBase}/healthz`),
    waitHealthy(`${withEnvBase}/healthz`),
    waitHealthy(`${withEnvMockBase}/healthz`),
  ]);
}, 20_000);

afterAll(() => {
  mockProc?.kill();
  liveProc?.kill();
  runtimeProc?.kill();
  noEnvProc?.kill();
  withEnvProc?.kill();
  withEnvMockProc?.kill();
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  if (runtimeProjectDir) rmSync(runtimeProjectDir, { recursive: true, force: true });
  if (noEnvProjectDir) rmSync(noEnvProjectDir, { recursive: true, force: true });
  if (withEnvProjectDir) rmSync(withEnvProjectDir, { recursive: true, force: true });
});

describe('--mock serving', () => {
  it('healthz reports mock:true under EMBERFLOW_MOCK, mock:false without it', async () => {
    expect(await (await fetch(`${mockBase}/healthz`)).json()).toMatchObject({ mock: true });
    expect(await (await fetch(`${liveBase}/healthz`)).json()).toMatchObject({ mock: false });
  });

  it('answers the default (first-with-expect) scenario, with the mock header', async () => {
    const res = await fetch(`${mockBase}/ping`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-emberflow-mock')).toBe('true');
    expect(await res.json()).toEqual({ pong: true });
  });

  it('selects a named scenario via x-emberflow-scenario', async () => {
    const res = await fetch(`${mockBase}/ping`, { headers: { 'x-emberflow-scenario': 'teapot' } });
    expect(res.status).toBe(418);
    expect(res.headers.get('x-emberflow-mock')).toBe('true');
    expect(await res.json()).toEqual({ pong: 'teapot' });
  });

  it('returns 501 for an op whose scenarios lack an expect', async () => {
    const res = await fetch(`${mockBase}/echo`);
    expect(res.status).toBe(501);
    expect(res.headers.get('x-emberflow-mock')).toBe('true');
  });

  it('without EMBERFLOW_MOCK, the same route executes real nodes (unchanged)', async () => {
    const res = await fetch(`${liveBase}/ping`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-emberflow-mock')).toBeNull();
    expect(await res.json()).toEqual({ real: true });
  });
});

describe('runtime serving mode (POST /serving)', () => {
  it('boots real (no EMBERFLOW_MOCK), serves real nodes and enforces auth', async () => {
    expect(await (await fetch(`${runtimeBase}/healthz`)).json()).toMatchObject({ mock: false });

    const ping = await fetch(`${runtimeBase}/ping`);
    expect(ping.status).toBe(200);
    expect(ping.headers.get('x-emberflow-mock')).toBeNull();
    expect(await ping.json()).toEqual({ real: true });

    // No-auth-in-mock is only meaningful if auth is actually enforced on the
    // real path first — this op 401s without a token.
    const unauthed = await fetch(`${runtimeBase}/protected`);
    expect(unauthed.status).toBe(401);
  });

  it('POST /serving {mode:"mock"} flips the SAME already-mounted routes to mock, live, no restart', async () => {
    const flip = await postServing(runtimeBase, 'mock');
    expect(flip.status).toBe(204);

    expect(await (await fetch(`${runtimeBase}/healthz`)).json()).toMatchObject({ mock: true });

    const ping = await fetch(`${runtimeBase}/ping`);
    expect(ping.status).toBe(200);
    expect(ping.headers.get('x-emberflow-mock')).toBe('true');
    expect(await ping.json()).toEqual({ pong: true });

    // The auth policy wired at mount time is skipped entirely in mock mode:
    // the same protected route that just 401s in real now answers straight
    // from the scenario expectation with NO token.
    const protectedRes = await fetch(`${runtimeBase}/protected`);
    expect(protectedRes.status).toBe(200);
    expect(protectedRes.headers.get('x-emberflow-mock')).toBe('true');
    expect(await protectedRes.json()).toEqual({ mocked: true });
  });

  it('POST /serving {mode:"real"} flips back — auth and real execution resume on the same routes', async () => {
    const flip = await postServing(runtimeBase, 'real');
    expect(flip.status).toBe(204);

    expect(await (await fetch(`${runtimeBase}/healthz`)).json()).toMatchObject({ mock: false });

    const ping = await fetch(`${runtimeBase}/ping`);
    expect(ping.status).toBe(200);
    expect(ping.headers.get('x-emberflow-mock')).toBeNull();
    expect(await ping.json()).toEqual({ real: true });

    const unauthed = await fetch(`${runtimeBase}/protected`);
    expect(unauthed.status).toBe(401);
  });

  it('POST /serving with a bogus mode 400s and does not change the live mode', async () => {
    const res = await postServing(runtimeBase, 'bogus');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');

    // Still real from the previous test's flip-back.
    expect(await (await fetch(`${runtimeBase}/healthz`)).json()).toMatchObject({ mock: false });
    const ping = await fetch(`${runtimeBase}/ping`);
    expect(await ping.json()).toEqual({ real: true });
  });
});

describe('default serving mode (no environments configured)', () => {
  it('no environments file, no EMBERFLOW_MOCK: healthz reports mock:true and the mounted route answers mock', async () => {
    expect(await (await fetch(`${noEnvBase}/healthz`)).json()).toMatchObject({ mock: true });

    const ping = await fetch(`${noEnvBase}/ping`);
    expect(ping.status).toBe(200);
    expect(ping.headers.get('x-emberflow-mock')).toBe('true');
    expect(await ping.json()).toEqual({ pong: true });
  });

  it('POST /serving {mode:"real"} is still honored with zero envs — permissive override', async () => {
    const flip = await postServing(noEnvBase, 'real');
    expect(flip.status).toBe(204);

    expect(await (await fetch(`${noEnvBase}/healthz`)).json()).toMatchObject({ mock: false });
    const ping = await fetch(`${noEnvBase}/ping`);
    expect(ping.status).toBe(200);
    expect(ping.headers.get('x-emberflow-mock')).toBeNull();
    expect(await ping.json()).toEqual({ real: true });

    // Flip back so this suite's fixture state doesn't leak to later tests.
    expect((await postServing(noEnvBase, 'mock')).status).toBe(204);
  });

  it('GET /environments reports configured:false so the studio shows its zero-env onboarding state', async () => {
    const body = await (await fetch(`${noEnvBase}/environments`)).json();
    expect(body.configured).toBe(false);
  });

  it('a project WITH a configured environment (>=1 env) boots real — today\'s behavior, unchanged', async () => {
    expect(await (await fetch(`${withEnvBase}/healthz`)).json()).toMatchObject({ mock: false });
    const ping = await fetch(`${withEnvBase}/ping`);
    expect(ping.status).toBe(200);
    expect(ping.headers.get('x-emberflow-mock')).toBeNull();
    expect(await ping.json()).toEqual({ real: true });
  });

  it('EMBERFLOW_MOCK=1 with environments present still forces mock — unchanged', async () => {
    expect(await (await fetch(`${withEnvMockBase}/healthz`)).json()).toMatchObject({ mock: true });
    const ping = await fetch(`${withEnvMockBase}/ping`);
    expect(ping.status).toBe(200);
    expect(ping.headers.get('x-emberflow-mock')).toBe('true');
    expect(await ping.json()).toEqual({ pong: true });
  });
});

describe('serving CLI command', () => {
  const origRunnerUrl = process.env.EMBERFLOW_RUNNER_URL;

  beforeAll(() => {
    // Drive the CLI (client.ts) against the already-booted runtime runner
    // above, the same way the register-API bin does.
    process.env.EMBERFLOW_RUNNER_URL = runtimeBase;
  });

  afterAll(() => {
    if (origRunnerUrl === undefined) delete process.env.EMBERFLOW_RUNNER_URL;
    else process.env.EMBERFLOW_RUNNER_URL = origRunnerUrl;
  });

  it('serving mock: exit 0, flips the runner to mock (healthz mock:true)', async () => {
    const code = await runCli(['serving', 'mock']);
    expect(code).toBe(0);
    expect(await (await fetch(`${runtimeBase}/healthz`)).json()).toMatchObject({ mock: true });

    // Flip back so this test doesn't leak mock mode to any test that follows.
    expect(await runCli(['serving', 'real'])).toBe(0);
    expect(await (await fetch(`${runtimeBase}/healthz`)).json()).toMatchObject({ mock: false });
  });

  it('serving bogus: exit 2, usage failure, does not change the live mode', async () => {
    const code = await runCli(['serving', 'bogus']);
    expect(code).toBe(2);
    expect(await (await fetch(`${runtimeBase}/healthz`)).json()).toMatchObject({ mock: false });
  });
});
