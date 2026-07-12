import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Verifies POST /runs auto-attaches the environment's credential (Task 4).
// Boots the actual runner subprocess (server/index.ts) against a scratch
// project dir, mirroring the harness in apiMount.test.ts.

let proc: ChildProcess;
const PORT = 8129;
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

// Single-node flow: an Input node that just echoes whatever input the run
// was invoked with (including `headers`) — a "trivial flow whose Input
// echoes headers" per the brief.
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
    body: JSON.stringify({ flow: echoFlow, mode: 'step', input }),
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

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'runsauth-'));
  mkdirSync(join(projectDir, 'emberflow', 'apis', 'default'), { recursive: true });
  writeFileSync(join(projectDir, 'emberflow.config.mjs'), 'export default {};\n');
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

  proc = bootRunner(PORT, { EMBERFLOW_PROJECT: projectDir });
  await waitHealthy(`${base}/healthz`);
}, 20_000);

afterAll(() => {
  proc?.kill();
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe('POST /runs auto-attaches the environment credential', () => {
  it('attaches the session cookie from the environment secret when the run omits headers', async () => {
    // The flow receives the raw secret internally (real attachment happened);
    // only the studio-facing sample output (via GET /samples) is redacted.
    // The name= prefix on the redaction token proves attachment occurred.
    const output = await runAndGetInputOutput({});
    expect(output.headers.cookie).toContain('session=«secret:sessionCookie»');
  });

  it('does not overwrite an explicit value for the same cookie name (non-destructive)', async () => {
    // The run already sets the target cookie name ("session") explicitly —
    // attachCredential must leave it exactly as the caller set it.
    const output = await runAndGetInputOutput({ headers: { cookie: 'session=mine' } });
    expect(output.headers.cookie).toBe('session=mine');
  });
});
