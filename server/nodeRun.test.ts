import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Verifies POST /node-run: the studio's "Run node" affordance runs a single
// node in-process on the runner (execution moved server-side; the studio bundles
// no node implementations). Boots the actual runner subprocess against a scratch
// project dir, mirroring runsAuth.test.ts / apiMount.test.ts.

let proc: ChildProcess;
const PORT = 8155;
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

async function nodeRun(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/node-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

// Fixture secret value — looks like a real credential to redaction logic
// (>= 6 chars) but is clearly a test fixture, never a live secret.
const FIXTURE_SECRET = 'fixture-secret-123';

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'noderun-'));
  mkdirSync(join(projectDir, 'emberflow', 'apis', 'default'), { recursive: true });
  writeFileSync(
    join(projectDir, 'emberflow.config.mjs'),
    `export default {
  registerNodes(registry) {
    // Embeds a secret in its output AND in a log line — exercises redaction
    // across both response fields.
    registry.register(
      { type: 'EchoSecret', label: 'Echo Secret', traceKind: 'pure', inputSchema: { fields: [] } },
      async (ctx) => {
        ctx.log('info', \`fetched key \${ctx.secrets.API_KEY}\`);
        return { message: \`key is \${ctx.secrets.API_KEY}\` };
      },
    );
    // Throws with the secret embedded in the error message — exercises
    // redaction on the error path.
    registry.register(
      { type: 'ThrowSecret', label: 'Throw Secret', traceKind: 'pure', inputSchema: { fields: [] } },
      async (ctx) => {
        throw new Error(\`boom \${ctx.secrets.API_KEY}\`);
      },
    );
    // Echoes ctx.safeMode so tests can observe the resolved safety mode.
    registry.register(
      { type: 'EchoSafeMode', label: 'Echo Safe Mode', traceKind: 'pure', inputSchema: { fields: [] } },
      async (ctx) => ({ safeMode: ctx.safeMode }),
    );
  },
};\n`,
  );
  writeFileSync(
    join(projectDir, 'emberflow.environments.json'),
    JSON.stringify({
      defaultEnvironment: 'local',
      environments: {
        local: { vars: {}, secrets: {} },
        leaky: { vars: {}, secrets: { API_KEY: FIXTURE_SECRET } },
        prod: { protected: true, vars: {}, secrets: {} },
      },
    }),
  );

  proc = bootRunner(PORT, { EMBERFLOW_PROJECT: projectDir });
  await waitHealthy(`${base}/healthz`);
}, 20_000);

afterAll(() => {
  proc?.kill();
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe('POST /node-run', () => {
  it('runs a single built-in node in-process and returns its output + logs', async () => {
    // CheckPlan is a pure built-in: input.user.plan -> { plan, features } + a log.
    const { status, json } = await nodeRun({
      type: 'CheckPlan',
      input: { user: { plan: 'pro' } },
    });
    expect(status).toBe(200);
    expect(json.output).toEqual({ plan: 'pro', features: ['sso', 'audit-log', 'priority-support'] });
    expect(json.error).toBeUndefined();
    expect(json.logs.some((l: { message: string }) => l.message.includes('pro'))).toBe(true);
  });

  it('404s for an unknown node type', async () => {
    const { status, json } = await nodeRun({ type: 'NoSuchNode', input: {} });
    expect(status).toBe(404);
    expect(json.error).toContain('Unknown node type');
  });

  it('400s when the body omits a node type', async () => {
    const { status } = await nodeRun({ input: {} });
    expect(status).toBe(400);
  });

  it('400s for an unknown environment', async () => {
    const { status, json } = await nodeRun({
      type: 'CheckPlan',
      input: { user: {} },
      environment: 'ghost',
    });
    expect(status).toBe(400);
    expect(json.error).toContain('Unknown environment');
  });
});

describe('POST /node-run redacts secrets at the boundary', () => {
  it('redacts a secret value embedded in the output and logs, never leaking the raw value', async () => {
    const { status, json } = await nodeRun({ type: 'EchoSecret', input: {}, environment: 'leaky' });
    expect(status).toBe(200);
    expect(json.error).toBeUndefined();

    expect(json.output.message).toContain('«secret:API_KEY»');
    expect(json.output.message).not.toContain(FIXTURE_SECRET);

    const logMessages = json.logs.map((l: { message: string }) => l.message).join('\n');
    expect(logMessages).toContain('«secret:API_KEY»');
    expect(logMessages).not.toContain(FIXTURE_SECRET);
  });

  it('redacts a secret value embedded in a thrown error message', async () => {
    const { status, json } = await nodeRun({ type: 'ThrowSecret', input: {}, environment: 'leaky' });
    expect(status).toBe(200);
    expect(json.output).toBeUndefined();
    expect(json.error).toContain('«secret:API_KEY»');
    expect(json.error).not.toContain(FIXTURE_SECRET);
  });
});

describe('POST /node-run gates unsafe runs on protected environments', () => {
  it('400s an explicit safeMode:false on a protected environment without a matching confirm', async () => {
    const { status, json } = await nodeRun({
      type: 'EchoSafeMode',
      input: {},
      environment: 'prod',
      safeMode: false,
    });
    expect(status).toBe(400);
    expect(json.error).toContain("unsafe run on protected environment 'prod' requires confirm");
  });

  it('accepts safeMode:false on a protected environment with the matching confirm, and the node observes it', async () => {
    const { status, json } = await nodeRun({
      type: 'EchoSafeMode',
      input: {},
      environment: 'prod',
      safeMode: false,
      confirm: 'prod',
    });
    expect(status).toBe(200);
    expect(json.output).toEqual({ safeMode: false });
  });

  it('defaults to safeMode:true on a protected environment when unspecified', async () => {
    const { status, json } = await nodeRun({ type: 'EchoSafeMode', input: {}, environment: 'prod' });
    expect(status).toBe(200);
    expect(json.output).toEqual({ safeMode: true });
  });
});
