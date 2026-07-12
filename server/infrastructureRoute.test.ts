import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Boots a real runner subprocess over a temp project (the setupStatus.test.ts
// pattern) and drives GET /infrastructure + the /setup-status infrastructure
// field. The route re-reads per request, so one runner covers absent → present
// → malformed (keep-last-good) by rewriting the file between fetches.

const PORT = 8154;
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

const manifestPath = (): string => join(projectDir, 'emberflow', 'infrastructure.json');

const GOOD_MANIFEST = {
  version: 1,
  scannedAt: '2026-07-12T00:00:00Z',
  greenfield: false,
  summary: 'Express app with Postgres (Prisma).',
  items: [
    {
      id: 'postgres-main',
      kind: 'database',
      name: 'Postgres (Prisma)',
      evidence: [{ file: 'prisma/schema.prisma', note: 'datasource db provider=postgresql' }],
      suggestedSecretRefs: ['DATABASE_URL'],
      suggestedVars: [],
    },
  ],
};

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'infraroute-'));
  mkdirSync(join(projectDir, 'emberflow', 'apis', 'default'), { recursive: true });
  writeFileSync(join(projectDir, 'emberflow.config.mjs'), 'export default {};\n');

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

describe('GET /infrastructure', () => {
  it('reports not present when no manifest exists', async () => {
    const res = await fetch(`${base}/infrastructure`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ present: false });

    // /setup-status agrees.
    const status = await (await fetch(`${base}/setup-status`)).json();
    expect(status.infrastructure).toEqual({ present: false });
  });

  it('serves the manifest once written (re-read per request)', async () => {
    writeFileSync(manifestPath(), JSON.stringify(GOOD_MANIFEST));
    const body = await (await fetch(`${base}/infrastructure`)).json();
    expect(body.present).toBe(true);
    expect(body.manifest.items).toHaveLength(1);
    expect(body.manifest.items[0].name).toBe('Postgres (Prisma)');

    // /setup-status carries the shallow summary from the same loader.
    const status = await (await fetch(`${base}/setup-status`)).json();
    expect(status.infrastructure).toEqual({
      present: true,
      scannedAt: '2026-07-12T00:00:00Z',
      itemCount: 1,
    });
  });

  it('keeps the last good manifest when the file becomes malformed', async () => {
    writeFileSync(manifestPath(), '{ broken json');
    const body = await (await fetch(`${base}/infrastructure`)).json();
    // Still present, still the last good manifest.
    expect(body.present).toBe(true);
    expect(body.manifest.items[0].name).toBe('Postgres (Prisma)');
  });
});
