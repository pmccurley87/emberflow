import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end coverage of GET /source-file plus the nodesPayload sourceRef
// wiring, through the real runner subprocess (same harness as
// diagnosticsRoute.test.ts). Uses the regression fixture shape:
// DeriveShipmentActuals registered from nodes.mjs, whose handler imports
// deriveTrackingActual from shipment-logic.mjs.

let proc: ChildProcess;
const PORT = 8157;
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

function sourceFileUrl(path: string): string {
  return `${base}/api/source-file?${new URLSearchParams({ path })}`;
}

beforeAll(async () => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'sourcenavroute-')));
  const w = (rel: string, content: string): void => writeFileSync(join(projectDir, rel), content);
  w(
    'shipment-logic.mjs',
    [
      'function nestedHelper(shipment) {', // 1
      '  return (shipment.weight ?? 0) * 2;', // 2
      '}', // 3
      '', // 4
      'export function deriveTrackingActual(shipment) {', // 5
      '  return nestedHelper(shipment);', // 6
      '}', // 7
      '',
    ].join('\n'),
  );
  w(
    'nodes.mjs',
    [
      "import { deriveTrackingActual } from './shipment-logic.mjs';", // 1
      '', // 2
      'export function registerNodes(registry) {', // 3
      '  registry.register(', // 4
      "    { type: 'DeriveShipmentActuals', label: 'Derive Shipment Actuals' },", // 5
      '    async (ctx) => ({ actual: deriveTrackingActual(ctx.input) }),', // 6
      '  );', // 7
      '}', // 8
      '',
    ].join('\n'),
  );
  w(
    'emberflow.config.mjs',
    ["import { registerNodes } from './nodes.mjs';", 'export default { registerNodes };', ''].join(
      '\n',
    ),
  );
  w('.env', 'TOP_SECRET=shh\n');

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

describe('GET /nodes sourceRef wiring', () => {
  it('carries a repo-relative sourceRef for the project node and builtin flag for package nodes', async () => {
    const res = await fetch(`${base}/api/nodes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{ type: string; sourceRef?: { file: string; line?: number }; builtin?: boolean }>;
    };
    const project = body.nodes.find((n) => n.type === 'DeriveShipmentActuals');
    expect(project).toBeDefined();
    expect(project!.sourceRef).toEqual({ file: 'nodes.mjs', line: 4 });
    expect(project!.builtin).toBeUndefined();

    const builtin = body.nodes.find((n) => n.type === 'ValidateCredentials');
    expect(builtin).toBeDefined();
    expect(builtin!.builtin).toBe(true);
    expect(builtin!.sourceRef).toBeUndefined();
  });
});

describe('GET /source-file', () => {
  it('serves the handler module with the imported helper resolved to its project file', async () => {
    const res = await fetch(sourceFileUrl('nodes.mjs'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      content: string;
      language: string;
      symbols: {
        imports: Array<{ local: string; resolution: { kind: string; path?: string; line?: number } }>;
      };
    };
    expect(body.path).toBe('nodes.mjs');
    expect(body.language).toBe('js');
    expect(body.content).toContain('DeriveShipmentActuals');
    const imp = body.symbols.imports.find((i) => i.local === 'deriveTrackingActual');
    expect(imp!.resolution).toEqual({ kind: 'project', path: 'shipment-logic.mjs', line: 5 });
  });

  it('exposes declaration lines on the helper module', async () => {
    const res = await fetch(sourceFileUrl('shipment-logic.mjs'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      symbols: {
        declarations: Array<{ name: string; line: number; endLine: number; exported: boolean }>;
      };
    };
    const derive = body.symbols.declarations.find((d) => d.name === 'deriveTrackingActual');
    expect(derive).toMatchObject({ line: 5, endLine: 7, exported: true });
  });

  it('400s on a traversal path without echoing it', async () => {
    const res = await fetch(sourceFileUrl('../../etc/passwd'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain('passwd');
  });

  it('400s on secret basenames and node_modules paths', async () => {
    for (const p of ['.env', 'node_modules/x/index.js']) {
      const res = await fetch(sourceFileUrl(p));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).not.toContain(p);
    }
  });

  it('400s when the path param is missing', async () => {
    const res = await fetch(`${base}/api/source-file`);
    expect(res.status).toBe(400);
  });

  it('404s for a missing file inside the project', async () => {
    const res = await fetch(sourceFileUrl('missing.mjs'));
    expect(res.status).toBe(404);
  });
});
