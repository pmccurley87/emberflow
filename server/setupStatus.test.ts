import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Boots a real runner subprocess over a temp project (the agentRoute.test.ts
// pattern) and drives GET /setup-status. Because the route re-reads
// environments per request, one runner covers both a fresh, unconfigured
// project AND a project that has just gained an environments file: we assert
// the fresh shape, then write emberflow.environments.json and re-fetch.

const PORT = 8153;
const base = `http://127.0.0.1:${PORT}`;

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

let proc: ChildProcess;
let projectDir: string;

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'setupstatus-'));
  mkdirSync(join(projectDir, 'emberflow', 'apis', 'default'), { recursive: true });
  writeFileSync(join(projectDir, 'emberflow.config.mjs'), 'export default {};\n');
  // A pristine project ships exactly the single default/hello example op.
  writeFileSync(
    join(projectDir, 'emberflow', 'apis', 'default', 'hello.json'),
    JSON.stringify({
      id: 'default/hello',
      name: 'Hello',
      version: 1,
      nodes: [
        { id: 'in', type: 'Input', label: 'Input', position: { x: 0, y: 0 }, config: {} },
        { id: 'out', type: 'Result', label: 'Result', position: { x: 300, y: 0 }, config: {}, inputMap: { value: { sourceNodeId: 'in', sourceField: '$' } } },
      ],
      edges: [{ id: 'e1', source: 'in', target: 'out' }],
      createdAt: '2026-07-12T00:00:00Z',
      updatedAt: '2026-07-12T00:00:00Z',
    }),
  );

  proc = spawn('npx', ['tsx', 'server/index.ts'], {
    env: {
      ...process.env,
      EMBERFLOW_RUNNER_PORT: String(PORT),
      EMBERFLOW_PROJECT: projectDir,
    },
    stdio: 'ignore',
  });

  await waitHealthy(`${base}/healthz`);
}, 20_000);

afterAll(() => {
  proc?.kill();
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe('GET /setup-status', () => {
  it('reports the fresh, unconfigured shape for an init-like project', async () => {
    const res = await fetch(`${base}/setup-status`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.agents)).toBe(true);
    // A fresh project has no environments file → the synthesized fallback is
    // reported as unconfigured with zero real environments.
    expect(body.environments).toMatchObject({
      configured: false,
      count: 0,
      protectedCount: 0,
      anyAuthConfigured: false,
    });
    expect(body.skills).toEqual({ claude: false, codex: false });
    expect(body.ops).toEqual({ count: 1, onlyHello: true });
    // Inferred from the .mjs config extension (project.language).
    expect(body.language).toBe('javascript');
    // Unconfigured projects default to mock serving.
    expect(body.servingMode).toBe('mock');
    expect(body.infrastructure).toEqual({ present: false });
  });

  it('reflects an environments file written after boot (re-read per request)', async () => {
    writeFileSync(
      join(projectDir, 'emberflow.environments.json'),
      JSON.stringify({
        defaultEnvironment: 'dev',
        environments: {
          dev: { vars: {}, secrets: [] },
          prod: {
            vars: {},
            secrets: ['API_KEY'],
            protected: true,
            auth: { attach: { as: 'header', name: 'Authorization', secretRef: 'API_KEY' } },
          },
        },
      }),
    );

    const res = await fetch(`${base}/setup-status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.environments).toEqual({
      configured: true,
      count: 2,
      protectedCount: 1,
      anyAuthConfigured: true,
    });
    // ops are unchanged — still just the hello example.
    expect(body.ops).toEqual({ count: 1, onlyHello: true });
  });
});
