import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli';

// Verifies the `create` CLI command seeds Input node defaults for :params in
// the http path, so a plain "Run" (no scenario) doesn't crash the first node
// reading ctx.input.params.<name>. Boots the actual runner subprocess against
// a scratch project dir, same harness pattern as cliAuth.test.ts.

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
  projectDir = mkdtempSync(join(tmpdir(), 'clicreate-'));
  mkdirSync(join(projectDir, 'emberflow', 'apis', 'default'), { recursive: true });
  writeFileSync(join(projectDir, 'emberflow.config.mjs'), 'export default {};\n');
  writeFileSync(
    join(projectDir, 'emberflow.environments.json'),
    JSON.stringify({ defaultEnvironment: 'dev', environments: { dev: { vars: {}, secrets: {} } } }),
  );

  proc = bootRunner(PORT, { EMBERFLOW_PROJECT: projectDir });
  await waitHealthy(`${base}/healthz`);
  process.env.EMBERFLOW_RUNNER_URL = base;
}, 20_000);

afterAll(() => {
  proc?.kill();
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  delete process.env.EMBERFLOW_RUNNER_URL;
});

describe('create CLI command', () => {
  it('seeds Input config.defaults.params for each :param in the http path', async () => {
    captureOutput();
    let code: number;
    try {
      code = await runCli([
        'create',
        'channels/get',
        '--method',
        'GET',
        '--path',
        '/api/channels/:id/approvals/:approvalId',
      ]);
    } finally {
      restoreOutput();
    }
    expect(code).toBe(0);

    captureOutput();
    try {
      code = await runCli(['get-workflow', 'channels/get']);
    } finally {
      restoreOutput();
    }
    expect(code).toBe(0);
    const flow = JSON.parse(logs.join(''));
    const inputNode = flow.nodes.find((n: { type: string }) => n.type === 'Input');
    expect(inputNode.config.defaults.params).toEqual({ id: '', approvalId: '' });
  });

  it('leaves Input config bare when the path has no params', async () => {
    captureOutput();
    let code: number;
    try {
      code = await runCli(['create', 'channels/list', '--method', 'GET', '--path', '/api/channels']);
    } finally {
      restoreOutput();
    }
    expect(code).toBe(0);

    captureOutput();
    try {
      code = await runCli(['get-workflow', 'channels/list']);
    } finally {
      restoreOutput();
    }
    expect(code).toBe(0);
    const flow = JSON.parse(logs.join(''));
    const inputNode = flow.nodes.find((n: { type: string }) => n.type === 'Input');
    expect(inputNode.config.defaults).toBeUndefined();
  });
});
