import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Verifies secret values never reach the studio via SSE run events or
// GET /samples, per Task 2 (egress-choke-point redaction). Boots the actual
// runner subprocess (server/index.ts) against scratch project dirs, mirroring
// the harness in runsAuth.test.ts.

const PORT = 8130;
const base = `http://127.0.0.1:${PORT}`;
const SECRET = 'supersecretvalue123';

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
// was invoked with (including `headers`).
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

/** Collects every SSE event emitted for a run until it finishes. */
async function collectSseEvents(runId: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${base}/api/runs/${runId}/events`);
  if (!res.body) throw new Error('no SSE body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: Array<Record<string, unknown>> = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) {
        const parsed = JSON.parse(dataLine.slice('data: '.length));
        events.push(parsed);
        if (parsed.type === 'finished') {
          reader.cancel();
          return events;
        }
      }
    }
  }
  return events;
}

describe('secret redaction at egress choke points', () => {
  describe('with a configured auth secret', () => {
    let projectDir: string;
    let proc: ChildProcess;

    beforeAll(async () => {
      projectDir = mkdtempSync(join(tmpdir(), 'redactegress-'));
      mkdirSync(join(projectDir, 'emberflow', 'apis', 'default'), { recursive: true });
      writeFileSync(join(projectDir, 'emberflow.config.mjs'), 'export default {};\n');
      writeFileSync(
        join(projectDir, 'emberflow.environments.json'),
        JSON.stringify({
          defaultEnvironment: 'local',
          environments: {
            local: {
              vars: {},
              secrets: { sessionCookie: SECRET },
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

    it('never leaks the raw secret value over SSE, and redacts the attached cookie', async () => {
      const createRes = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow: echoFlow, mode: 'run', input: {} }),
      });
      expect(createRes.status).toBe(201);
      const { runId } = await createRes.json();

      const events = await collectSseEvents(runId);
      expect(events.length).toBeGreaterThan(0);

      const raw = JSON.stringify(events);
      expect(raw).not.toContain(SECRET);

      const nodeStateEvents = events.filter(
        (e) => e.type === 'nodeState' && (e as { nodeId?: string }).nodeId === 'input',
      );
      const succeeded = nodeStateEvents.find(
        (e) => (e.state as { status?: string } | undefined)?.status === 'succeeded',
      );
      expect(succeeded).toBeDefined();
      const output = (succeeded!.state as { output?: { headers?: { cookie?: string } } }).output;
      expect(output?.headers?.cookie).toContain('session=«secret:sessionCookie»');
    });

    it('redacts the sample output returned via GET /samples', async () => {
      const createRes = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow: echoFlow, mode: 'step', input: {} }),
      });
      expect(createRes.status).toBe(201);
      const { runId } = await createRes.json();

      const stepRes = await fetch(`${base}/api/runs/${runId}/step`, { method: 'POST' });
      expect(stepRes.status).toBe(200);

      const samplesRes = await fetch(`${base}/api/samples?nodeId=input`);
      expect(samplesRes.status).toBe(200);
      const body = await samplesRes.json();
      const raw = JSON.stringify(body);
      expect(raw).not.toContain(SECRET);

      const sample = body.samples.find((s: { runId: string }) => s.runId === runId);
      expect(sample).toBeDefined();
      expect(sample.output.headers.cookie).toContain('session=«secret:sessionCookie»');
    });
  });

  describe('with two environments sharing a secret key (different values)', () => {
    let projectDir: string;
    let proc: ChildProcess;
    const port = 8141;
    const base3 = `http://127.0.0.1:${port}`;
    const DEV_SECRET = 'devsecretvalue-abc123';
    const PROD_SECRET = 'prodsecretvalue-xyz789';

    beforeAll(async () => {
      projectDir = mkdtempSync(join(tmpdir(), 'redactegress-multienv-'));
      mkdirSync(join(projectDir, 'emberflow', 'apis', 'default'), { recursive: true });
      writeFileSync(join(projectDir, 'emberflow.config.mjs'), 'export default {};\n');
      writeFileSync(
        join(projectDir, 'emberflow.environments.json'),
        JSON.stringify({
          defaultEnvironment: 'dev',
          environments: {
            // Both envs define the SAME key with DIFFERENT values. A merged
            // redaction map keyed by name would keep only prod's value and
            // let dev's pass through /samples raw.
            dev: {
              vars: {},
              secrets: { sessionCookie: DEV_SECRET },
              auth: { attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' } },
            },
            prod: {
              vars: {},
              secrets: { sessionCookie: PROD_SECRET },
              auth: { attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' } },
            },
          },
        }),
      );
      proc = bootRunner(port, { EMBERFLOW_PROJECT: projectDir });
      await waitHealthy(`${base3}/healthz`);
    }, 20_000);

    afterAll(() => {
      proc?.kill();
      if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    });

    it('GET /samples leaks NEITHER environment value raw, even on key collision', async () => {
      // Run against dev (the default env): dev's value lands in the sample
      // via the auto-attached cookie.
      const createRes = await fetch(`${base3}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow: echoFlow, mode: 'step', input: {} }),
      });
      expect(createRes.status).toBe(201);
      const { runId } = await createRes.json();

      const stepRes = await fetch(`${base3}/api/runs/${runId}/step`, { method: 'POST' });
      expect(stepRes.status).toBe(200);

      const samplesRes = await fetch(`${base3}/api/samples?nodeId=input`);
      expect(samplesRes.status).toBe(200);
      const body = await samplesRes.json();
      const raw = JSON.stringify(body);
      expect(raw).not.toContain(DEV_SECRET);
      expect(raw).not.toContain(PROD_SECRET);

      const sample = body.samples.find((s: { runId: string }) => s.runId === runId);
      expect(sample).toBeDefined();
      expect(sample.output.headers.cookie).toContain('session=«secret:sessionCookie»');
    });
  });

  describe('without any secrets configured', () => {
    let projectDir: string;
    let proc: ChildProcess;
    const port = 8140;
    const base2 = `http://127.0.0.1:${port}`;

    beforeAll(async () => {
      projectDir = mkdtempSync(join(tmpdir(), 'redactegress-nosecrets-'));
      mkdirSync(join(projectDir, 'emberflow', 'apis', 'default'), { recursive: true });
      writeFileSync(join(projectDir, 'emberflow.config.mjs'), 'export default {};\n');
      writeFileSync(
        join(projectDir, 'emberflow.environments.json'),
        JSON.stringify({
          defaultEnvironment: 'local',
          environments: { local: { vars: {}, secrets: {} } },
        }),
      );
      proc = bootRunner(port, { EMBERFLOW_PROJECT: projectDir });
      await waitHealthy(`${base2}/healthz`);
    }, 20_000);

    afterAll(() => {
      proc?.kill();
      if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    });

    it('run output is untouched: no redaction tokens appear anywhere', async () => {
      const createRes = await fetch(`${base2}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow: echoFlow, mode: 'step', input: { headers: { 'x-foo': 'bar' } } }),
      });
      expect(createRes.status).toBe(201);
      const { runId } = await createRes.json();

      const stepRes = await fetch(`${base2}/api/runs/${runId}/step`, { method: 'POST' });
      expect(stepRes.status).toBe(200);

      const samplesRes = await fetch(`${base2}/api/samples?nodeId=input`);
      const { samples } = await samplesRes.json();
      const sample = samples.find((s: { runId: string }) => s.runId === runId);
      expect(sample).toBeDefined();
      expect(sample.output.headers['x-foo']).toBe('bar');
      expect(JSON.stringify(sample)).not.toContain('«secret:');
    });
  });
});
