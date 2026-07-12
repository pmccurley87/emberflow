import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let proc: ChildProcess;
const PORT = 8123;
const base = `http://127.0.0.1:${PORT}`;

async function waitHealthy(url: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('runner did not become healthy');
}

/** Spawn `server/index.ts` with the given env and wait for /healthz. */
function bootRunner(port: number, env: Record<string, string | undefined>): ChildProcess {
  return spawn('npx', ['tsx', 'server/index.ts'], {
    env: { ...process.env, EMBERFLOW_RUNNER_PORT: String(port), ...env },
    stdio: 'ignore',
  });
}

/** Like `bootRunner`, but pipes stderr so the caller can assert on warn logs. */
function bootRunnerCapturingStderr(port: number, env: Record<string, string | undefined>): {
  proc: ChildProcess;
  stderr: () => string;
} {
  const child = spawn('npx', ['tsx', 'server/index.ts'], {
    env: { ...process.env, EMBERFLOW_RUNNER_PORT: String(port), ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return { proc: child, stderr: () => stderr };
}

let projectDir: string;

beforeAll(async () => {
  // A minimal project dir seeded with an apis/ tree — the runner reads its
  // flows from apis/, not the legacy flat flows/.
  projectDir = mkdtempSync(join(tmpdir(), 'apimount-'));
  mkdirSync(join(projectDir, 'emberflow', 'apis', 'default'), { recursive: true });
  writeFileSync(
    join(projectDir, 'emberflow', 'apis', 'default', 'hello.json'),
    JSON.stringify({ id: 'hello', name: 'Hello', nodes: [], edges: [] }),
  );
  // A routed operation: GET /ping -> a Response node returning { status: 200, body: { pong: true } }.
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
          config: { status: 200, body: { pong: true } },
        },
      ],
      edges: [],
    }),
  );
  writeFileSync(join(projectDir, 'emberflow.config.mjs'), 'export default {};\n');
  // A configured environment keeps the runner booting in REAL serving mode —
  // with none, it now defaults to mock and these real-path assertions 501.
  writeFileSync(
    join(projectDir, 'emberflow.environments.json'),
    JSON.stringify({ defaultEnvironment: 'dev', environments: { dev: {} } }),
  );

  proc = bootRunner(PORT, { EMBERFLOW_PROJECT: projectDir });
  await waitHealthy(`${base}/healthz`);
}, 20_000);

afterAll(() => {
  proc?.kill();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('API mount', () => {
  it('serves healthz at root and under /api', async () => {
    expect((await fetch(`${base}/healthz`)).ok).toBe(true);
    expect((await fetch(`${base}/api/healthz`)).ok).toBe(true);
  });
  it('healthz reports mock:false when EMBERFLOW_MOCK is unset', async () => {
    const body = await (await fetch(`${base}/healthz`)).json();
    expect(body.mock).toBe(false);
  });
  it('serves /nodes under /api', async () => {
    const res = await fetch(`${base}/api/nodes`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body.nodes)).toBe(true);
  });

  it('rejects POST /agent with an unsupported intent.action', async () => {
    const res = await fetch(`${base}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: { action: 'delete-everything', flowId: 'hello', instruction: 'x' },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/action/i);
  });

  it('GET /api/workflows lists operations from the apis/ tree', async () => {
    const res = await fetch(`${base}/api/workflows`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flows.map((f: { id: string }) => f.id)).toContain('hello');
  });

  it('GET /api/workflows also returns an operations array with path and http', async () => {
    const res = await fetch(`${base}/api/workflows`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.operations)).toBe(true);
    const hello = body.operations.find((o: { id: string }) => o.id === 'hello');
    expect(hello.path).toBe('default/hello');
    expect(hello.http).toBeUndefined();
    const ping = body.operations.find((o: { id: string }) => o.id === 'ping');
    expect(ping.path).toBe('default/ping');
    expect(ping.http).toEqual({ method: 'GET', path: '/ping' });
  });

  it('serves a routed operation as a live HTTP endpoint at the root path', async () => {
    const res = await fetch(`${base}/ping`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ pong: true });
  });

  it('POST /api/operations saves a new flow at the given path, visible in GET /workflows', async () => {
    const flow = {
      id: 'svc/thing',
      name: 'Thing',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      nodes: [],
      edges: [],
    };
    const res = await fetch(`${base}/api/operations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow, path: 'svc/thing' }),
    });
    expect(res.status).toBe(201);
    expect(existsSync(join(projectDir, 'emberflow', 'apis', 'svc', 'thing.json'))).toBe(true);

    const listed = await (await fetch(`${base}/api/workflows`)).json();
    const op = listed.operations.find((o: { id: string }) => o.id === 'svc/thing');
    expect(op).toBeDefined();
    expect(op.path).toBe('svc/thing');
  });

  it('POST /api/operations 409s (does not overwrite) when an operation already exists at the path', async () => {
    const original = {
      id: 'svc/thing',
      name: 'Thing',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      nodes: [],
      edges: [],
    };
    // 'svc/thing' was already created by the previous test — assert the
    // collision case directly here too so this test is self-sufficient.
    await fetch(`${base}/api/operations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow: original, path: 'svc/thing' }),
    });

    const clobber = {
      id: 'svc/thing',
      name: 'Clobbered',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      nodes: [],
      edges: [],
    };
    const res = await fetch(`${base}/api/operations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow: clobber, path: 'svc/thing' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/i);

    // The original file must be untouched — no silent overwrite.
    const onDisk = JSON.parse(
      readFileSync(join(projectDir, 'emberflow', 'apis', 'svc', 'thing.json'), 'utf8'),
    );
    expect(onDisk.name).toBe('Thing');
  });

  it('POST /api/operations 400s when flow.id does not match path', async () => {
    const flow = {
      id: 'svc/mismatched',
      name: 'Mismatched',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      nodes: [],
      edges: [],
    };
    const res = await fetch(`${base}/api/operations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow, path: 'svc/other-path' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/flow\.id must equal path/i);
    expect(existsSync(join(projectDir, 'emberflow', 'apis', 'svc', 'other-path.json'))).toBe(false);
  });

  it('POST /api/operations rejects a path-traversal path', async () => {
    const flow = {
      id: 'escape',
      name: 'Escape',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      nodes: [],
      edges: [],
    };
    const res = await fetch(`${base}/api/operations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow, path: '../../etc/escape' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('migration on boot', () => {
  let legacyProjectDir: string;
  let legacyProc: ChildProcess;
  const LEGACY_PORT = 8124;
  const legacyBase = `http://127.0.0.1:${LEGACY_PORT}`;

  afterEach(() => {
    legacyProc?.kill();
    if (legacyProjectDir) rmSync(legacyProjectDir, { recursive: true, force: true });
  });

  it('migrates a legacy flows/ layout into apis/default/ and serves it', async () => {
    legacyProjectDir = mkdtempSync(join(tmpdir(), 'apimount-legacy-'));
    mkdirSync(join(legacyProjectDir, 'emberflow', 'flows'), { recursive: true });
    writeFileSync(
      join(legacyProjectDir, 'emberflow', 'flows', 'legacy.json'),
      JSON.stringify({ id: 'legacy', name: 'Legacy', nodes: [], edges: [] }),
    );
    writeFileSync(join(legacyProjectDir, 'emberflow.config.mjs'), 'export default {};\n');

    legacyProc = bootRunner(LEGACY_PORT, { EMBERFLOW_PROJECT: legacyProjectDir });
    await waitHealthy(`${legacyBase}/healthz`);

    const res = await fetch(`${legacyBase}/api/workflows`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flows.map((f: { id: string }) => f.id)).toContain('legacy');

    expect(existsSync(join(legacyProjectDir, 'emberflow', 'apis', 'default', 'legacy.json'))).toBe(true);
    expect(existsSync(join(legacyProjectDir, 'emberflow', 'flows'))).toBe(false);
  });
});

describe('auth enforcement', () => {
  let secureProjectDir: string;
  let secureProc: ChildProcess;
  const SECURE_PORT = 8126;
  const secureBase = `http://127.0.0.1:${SECURE_PORT}`;

  afterAll(() => {
    secureProc?.kill();
    if (secureProjectDir) rmSync(secureProjectDir, { recursive: true, force: true });
  });

  it('401s a protected operation without a token, 200s with the right bearer token', async () => {
    secureProjectDir = mkdtempSync(join(tmpdir(), 'apimount-secure-'));
    mkdirSync(join(secureProjectDir, 'emberflow', 'apis', 'secure'), { recursive: true });
    // _meta.json at the api-folder level: every op under apis/secure/ inherits this bearer policy.
    writeFileSync(
      join(secureProjectDir, 'emberflow', 'apis', 'secure', '_meta.json'),
      JSON.stringify({ auth: { scheme: 'bearer', secretRef: 'API_TOKEN' } }),
    );
    writeFileSync(
      join(secureProjectDir, 'emberflow', 'apis', 'secure', 'protected.json'),
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
            config: { status: 200, body: { ok: true } },
          },
        ],
        edges: [],
      }),
    );
    writeFileSync(join(secureProjectDir, 'emberflow.config.mjs'), 'export default {};\n');
    // Seed the default environment's secret the bearer policy's secretRef points at.
    writeFileSync(
      join(secureProjectDir, 'emberflow.environments.json'),
      JSON.stringify({
        defaultEnvironment: 'local',
        environments: { local: { vars: {}, secrets: { API_TOKEN: 'topsecret' } } },
      }),
    );

    secureProc = bootRunner(SECURE_PORT, { EMBERFLOW_PROJECT: secureProjectDir });
    await waitHealthy(`${secureBase}/healthz`);

    const unauthed = await fetch(`${secureBase}/protected`);
    expect(unauthed.status).toBe(401);
    expect(await unauthed.json()).toEqual({ error: 'unauthorized' });

    const authed = await fetch(`${secureBase}/protected`, {
      headers: { Authorization: 'Bearer topsecret' },
    });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ ok: true });
  }, 20_000);
});

describe('broken auth config fails closed', () => {
  let brokenProjectDir: string;
  let brokenProc: ChildProcess;
  let getStderr: () => string;
  const BROKEN_PORT = 8127;
  const brokenBase = `http://127.0.0.1:${BROKEN_PORT}`;

  afterAll(() => {
    brokenProc?.kill();
    if (brokenProjectDir) rmSync(brokenProjectDir, { recursive: true, force: true });
  });

  it('denies (500) an operation under a corrupt _meta.json instead of resolving it public, while other operations and boot still succeed', async () => {
    brokenProjectDir = mkdtempSync(join(tmpdir(), 'apimount-broken-'));
    mkdirSync(join(brokenProjectDir, 'emberflow', 'apis', 'broken'), { recursive: true });
    mkdirSync(join(brokenProjectDir, 'emberflow', 'apis', 'default'), { recursive: true });

    // Corrupt _meta.json — e.g. a partial write or a typo — at the api-folder
    // level: every op under apis/broken/ would have inherited this policy had
    // it parsed.
    writeFileSync(join(brokenProjectDir, 'emberflow', 'apis', 'broken', '_meta.json'), '{ "auth": { "scheme": ');
    writeFileSync(
      join(brokenProjectDir, 'emberflow', 'apis', 'broken', 'affected.json'),
      JSON.stringify({
        id: 'affected',
        name: 'Affected',
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        http: { method: 'GET', path: '/affected' },
        nodes: [
          {
            id: 'response',
            type: 'Response',
            label: 'Response',
            position: { x: 0, y: 0 },
            config: { status: 200, body: { shouldNeverBeSeen: true } },
          },
        ],
        edges: [],
      }),
    );
    // A sibling op under an unrelated, healthy directory — must still boot and work.
    writeFileSync(
      join(brokenProjectDir, 'emberflow', 'apis', 'default', 'healthy.json'),
      JSON.stringify({
        id: 'healthy',
        name: 'Healthy',
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        http: { method: 'GET', path: '/healthy' },
        nodes: [
          {
            id: 'response',
            type: 'Response',
            label: 'Response',
            position: { x: 0, y: 0 },
            config: { status: 200, body: { ok: true } },
          },
        ],
        edges: [],
      }),
    );
    writeFileSync(join(brokenProjectDir, 'emberflow.config.mjs'), 'export default {};\n');
    // Configured environment → boots REAL (default-mock would 501 these ops).
    writeFileSync(
      join(brokenProjectDir, 'emberflow.environments.json'),
      JSON.stringify({ defaultEnvironment: 'dev', environments: { dev: {} } }),
    );

    const booted = bootRunnerCapturingStderr(BROKEN_PORT, { EMBERFLOW_PROJECT: brokenProjectDir });
    brokenProc = booted.proc;
    getStderr = booted.stderr;
    await waitHealthy(`${brokenBase}/healthz`);

    // The op under the broken _meta.json is denied — never silently public.
    const affected = await fetch(`${brokenBase}/affected`);
    expect(affected.status).toBe(500);
    expect(await affected.json()).toEqual({ error: 'auth misconfigured' });

    // The rest of the runner still boots and serves other operations fine.
    const healthy = await fetch(`${brokenBase}/healthy`);
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({ ok: true });

    expect(getStderr()).toMatch(/operation affected has broken auth config — mounted as fail-closed \(500\)/);
  }, 20_000);
});

describe('reserved route guard', () => {
  let reservedProjectDir: string;
  let reservedProc: ChildProcess;
  let getStderr: () => string;
  const RESERVED_PORT = 8125;
  const reservedBase = `http://127.0.0.1:${RESERVED_PORT}`;

  afterAll(() => {
    reservedProc?.kill();
    if (reservedProjectDir) rmSync(reservedProjectDir, { recursive: true, force: true });
  });

  it('boots without crashing, skips an operation whose http.path collides with a reserved internal route, warns, and leaves the internal route intact', async () => {
    reservedProjectDir = mkdtempSync(join(tmpdir(), 'apimount-reserved-'));
    mkdirSync(join(reservedProjectDir, 'emberflow', 'apis', 'default'), { recursive: true });
    // Operation whose http.path collides with the internal GET /workflows route.
    writeFileSync(
      join(reservedProjectDir, 'emberflow', 'apis', 'default', 'colliding.json'),
      JSON.stringify({
        id: 'colliding',
        name: 'Colliding',
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        http: { method: 'GET', path: '/workflows' },
        nodes: [
          {
            id: 'response',
            type: 'Response',
            label: 'Response',
            position: { x: 0, y: 0 },
            config: { status: 200, body: { hijacked: true } },
          },
        ],
        edges: [],
      }),
    );
    writeFileSync(join(reservedProjectDir, 'emberflow.config.mjs'), 'export default {};\n');
    // Configured environment → boots REAL (default-mock would 501 these ops).
    writeFileSync(
      join(reservedProjectDir, 'emberflow.environments.json'),
      JSON.stringify({ defaultEnvironment: 'dev', environments: { dev: {} } }),
    );

    const booted = bootRunnerCapturingStderr(RESERVED_PORT, { EMBERFLOW_PROJECT: reservedProjectDir });
    reservedProc = booted.proc;
    getStderr = booted.stderr;
    await waitHealthy(`${reservedBase}/healthz`);

    // Internal /workflows route still works — not shadowed by the colliding operation.
    const res = await fetch(`${reservedBase}/api/workflows`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flows.map((f: { id: string }) => f.id)).toContain('colliding');
    expect(body).not.toEqual({ hijacked: true });

    expect(getStderr()).toMatch(/collides with a reserved internal route/);
  }, 20_000);
});

describe('root-path guard (no studio shadowing)', () => {
  let rootProjectDir: string;
  let rootProc: ChildProcess;
  let getStderr: () => string;
  const ROOT_PORT = 8126;
  const rootBase = `http://127.0.0.1:${ROOT_PORT}`;

  afterAll(() => {
    rootProc?.kill();
    if (rootProjectDir) rmSync(rootProjectDir, { recursive: true, force: true });
  });

  it('skips an operation whose http.path is "/" (would shadow the studio root), warns, and still mounts a sibling valid operation', async () => {
    rootProjectDir = mkdtempSync(join(tmpdir(), 'apimount-root-'));
    mkdirSync(join(rootProjectDir, 'emberflow', 'apis', 'default'), { recursive: true });
    // Operation whose http.path is bare root — would shadow the studio SPA
    // catch-all (mounted after operations) if not skipped.
    writeFileSync(
      join(rootProjectDir, 'emberflow', 'apis', 'default', 'root.json'),
      JSON.stringify({
        id: 'root',
        name: 'Root',
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        http: { method: 'GET', path: '/' },
        nodes: [
          {
            id: 'response',
            type: 'Response',
            label: 'Response',
            position: { x: 0, y: 0 },
            config: { status: 200, body: { hijacked: true } },
          },
        ],
        edges: [],
      }),
    );
    // A sibling valid operation — should still mount normally.
    writeFileSync(
      join(rootProjectDir, 'emberflow', 'apis', 'default', 'things.json'),
      JSON.stringify({
        id: 'things',
        name: 'Things',
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        http: { method: 'GET', path: '/things' },
        nodes: [
          {
            id: 'response',
            type: 'Response',
            label: 'Response',
            position: { x: 0, y: 0 },
            config: { status: 200, body: { ok: true } },
          },
        ],
        edges: [],
      }),
    );
    writeFileSync(join(rootProjectDir, 'emberflow.config.mjs'), 'export default {};\n');
    // Configured environment → boots REAL (default-mock would 501 these ops).
    writeFileSync(
      join(rootProjectDir, 'emberflow.environments.json'),
      JSON.stringify({ defaultEnvironment: 'dev', environments: { dev: {} } }),
    );

    const booted = bootRunnerCapturingStderr(ROOT_PORT, { EMBERFLOW_PROJECT: rootProjectDir });
    rootProc = booted.proc;
    getStderr = booted.stderr;
    await waitHealthy(`${rootBase}/healthz`);

    // GET / is not hijacked by the op — without EMBERFLOW_SERVE_STUDIO the
    // root path 404s (no static/SPA fallback registered) rather than
    // returning the op's body.
    const res = await fetch(`${rootBase}/`);
    expect(res.status).not.toBe(200);
    const bodyText = await res.text();
    expect(bodyText).not.toMatch(/hijacked/);

    // The sibling valid operation still mounts and works.
    const thingsRes = await fetch(`${rootBase}/things`);
    expect(thingsRes.status).toBe(200);
    expect(await thingsRes.json()).toEqual({ ok: true });

    expect(getStderr()).toMatch(/has an invalid\/root path "\/" — skipping \(would shadow the studio\)/);
  }, 20_000);
});
