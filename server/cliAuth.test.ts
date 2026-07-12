import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli';

// Verifies `login-environment` CLI command + auth-aware `list-environments`
// output (Task 5). Boots the actual runner subprocess (server/index.ts)
// against a scratch project dir, mirroring the harness in
// environmentsRoute.test.ts, and drives it via the in-process CLI (runCli)
// against EMBERFLOW_RUNNER_URL, like the register-API bin does.

let proc: ChildProcess;
const PORT = 8135;
const base = `http://127.0.0.1:${PORT}`;
let projectDir: string;

let loginServer: Server;
const LOGIN_PORT = 8136;

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

let logs: string[] = [];
let errs: string[] = [];
const origLog = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);

function captureOutput(): void {
  logs = [];
  errs = [];
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    logs.push(String(chunk));
    return (origLog as unknown as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    errs.push(String(chunk));
    return (origErr as unknown as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
}

function restoreOutput(): void {
  process.stdout.write = origLog;
  process.stderr.write = origErr;
}

beforeAll(async () => {
  // Tiny stub login target: responds 200 with a Set-Cookie header.
  loginServer = createServer((_req, res) => {
    res.setHeader('Set-Cookie', 'session=captured-token; Path=/');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => loginServer.listen(LOGIN_PORT, resolve));

  projectDir = mkdtempSync(join(tmpdir(), 'cliauth-'));
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
      },
    }),
  );

  proc = bootRunner(PORT, { EMBERFLOW_PROJECT: projectDir });
  await waitHealthy(`${base}/healthz`);

  // The CLI (client.ts) reads EMBERFLOW_RUNNER_URL per-call, so point it at
  // this test's runner subprocess.
  process.env.EMBERFLOW_RUNNER_URL = base;
}, 20_000);

afterAll(async () => {
  proc?.kill();
  await new Promise<void>((resolve) => loginServer.close(() => resolve()));
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  delete process.env.EMBERFLOW_RUNNER_URL;
});

describe('login-environment CLI command', () => {
  it('logs in successfully: exit 0, prints {environment, authenticated: true, secretRef}', async () => {
    captureOutput();
    let code: number;
    try {
      code = await runCli(['login-environment', 'dev']);
    } finally {
      restoreOutput();
    }
    expect(code).toBe(0);
    const printed = JSON.parse(logs.join(''));
    expect(printed).toEqual({ environment: 'dev', authenticated: true, secretRef: 'sessionCookie' });
  });

  it('unknown environment: exit 1, prints the server error', async () => {
    captureOutput();
    let code: number;
    try {
      code = await runCli(['login-environment', 'no-such-env']);
    } finally {
      restoreOutput();
    }
    expect(code).toBe(1);
    const printed = JSON.parse(errs.join(''));
    expect(printed.error).toMatch(/unknown environment/i);
  });
});

describe('list-environments CLI command (auth-aware)', () => {
  it('includes per-env auth: {configured, authenticated}', async () => {
    captureOutput();
    let code: number;
    try {
      code = await runCli(['list-environments']);
    } finally {
      restoreOutput();
    }
    expect(code).toBe(0);
    const printed = JSON.parse(logs.join(''));
    const dev = printed.environments.find((e: { name: string }) => e.name === 'dev');
    const noauth = printed.environments.find((e: { name: string }) => e.name === 'noauth');
    // dev was logged in by the earlier test in this file.
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
    expect(noauth.auth).toEqual({ configured: false, authenticated: false });
  });
});

describe('set-environment-auth CLI command', () => {
  it('valid EnvAuth JSON: exit 0, prints {environment, configured: true}', async () => {
    const auth = {
      attach: { as: 'header', name: 'Authorization', secretRef: 'apiKey', prefix: 'Bearer ' },
    };
    captureOutput();
    let code: number;
    try {
      code = await runCli(['set-environment-auth', 'noauth', '--json', JSON.stringify(auth)]);
    } finally {
      restoreOutput();
    }
    expect(code).toBe(0);
    const printed = JSON.parse(logs.join(''));
    expect(printed).toEqual({ environment: 'noauth', configured: true });

    // Confirm it actually landed: list-environments now reports it configured.
    captureOutput();
    let listCode: number;
    try {
      listCode = await runCli(['list-environments']);
    } finally {
      restoreOutput();
    }
    expect(listCode).toBe(0);
    const listed = JSON.parse(logs.join(''));
    const noauthEnv = listed.environments.find((e: { name: string }) => e.name === 'noauth');
    expect(noauthEnv.auth.configured).toBe(true);
  });

  it('invalid auth shape: exit 1, prints the server error', async () => {
    captureOutput();
    let code: number;
    try {
      code = await runCli(['set-environment-auth', 'dev', '--json', '{}']);
    } finally {
      restoreOutput();
    }
    expect(code).toBe(1);
    const printed = JSON.parse(errs.join(''));
    expect(printed.error).toMatch(/auth/i);
  });

  it('missing --json flag: exit 2, usage error', async () => {
    captureOutput();
    let code: number;
    try {
      code = await runCli(['set-environment-auth', 'dev']);
    } finally {
      restoreOutput();
    }
    expect(code).toBe(2);
    const printed = JSON.parse(errs.join(''));
    expect(printed.error).toMatch(/usage/i);
  });
});
