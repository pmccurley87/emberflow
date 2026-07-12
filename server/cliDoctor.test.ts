import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli';

// Verifies `emberflow doctor [id] [--fix]` (Task 3): reads op + scenario
// files from disk the same way `test` does (no runner needed), reports
// diagnoseOperation's findings, and with --fix seeds param defaults in-place
// then re-diagnoses. Also exercises the bin/commands.ts dispatcher path so
// `doctor` doesn't repeat the past `login-environment`-forgotten-in-dispatcher
// bug.

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ef-clidoctor-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.EMBERFLOW_PROJECT;
});

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...savedEnv };
});

function writeProjectConfig(root: string): void {
  writeFileSync(join(root, 'emberflow.config.mjs'), 'export default {};\n');
}

/** A project config registering a 'db'-traceKind node, for the
 *  missing-node-mock test — proves doctor builds a registry and passes
 *  infraNodes through to diagnoseOperation. */
function writeProjectConfigWithDbNode(root: string): void {
  writeFileSync(
    join(root, 'emberflow.config.mjs'),
    `export default {
  registerNodes(registry) {
    registry.register(
      { type: 'DbRead', label: 'DB Read', traceKind: 'db', inputSchema: { fields: [] } },
      async () => ({ rows: [] }),
    );
  },
};\n`,
  );
}

/** An op whose only node is a registered 'db'-traceKind node, with no op-level
 *  mocks and no scenarios — should trigger missing-node-mock alongside no-expects. */
function writeUnmockedInfraOp(root: string): void {
  const apisDir = join(root, 'emberflow', 'apis', 'default');
  mkdirSync(apisDir, { recursive: true });
  writeFileSync(
    join(apisDir, 'infra.json'),
    JSON.stringify(
      {
        id: 'infra',
        name: 'Infra',
        version: 1,
        nodes: [{ id: 'db1', type: 'DbRead', label: 'Fetch Rows', position: { x: 0, y: 0 }, config: {} }],
        edges: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      null,
      2,
    ) + '\n',
  );
}

/** An op with a path param `:id`, no default under the Input node, and no
 *  scenarios — should trigger all three v1 diagnostic codes. */
function writeBrokenOp(root: string): void {
  const apisDir = join(root, 'emberflow', 'apis', 'default');
  mkdirSync(apisDir, { recursive: true });
  writeFileSync(
    join(apisDir, 'broken.json'),
    JSON.stringify(
      {
        id: 'broken',
        name: 'Broken',
        version: 1,
        http: { method: 'GET', path: '/broken/:id' },
        nodes: [
          { id: 'input', type: 'Input', label: 'Input', position: { x: 0, y: 0 }, config: {} },
          { id: 'result', type: 'Result', label: 'Result', position: { x: 200, y: 0 }, config: {} },
        ],
        edges: [{ id: 'e1', source: 'input', target: 'result' }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      null,
      2,
    ) + '\n',
  );
}

/** A clean op: no path params, one scenario carrying `expect`. */
function writeCleanOp(root: string): void {
  const apisDir = join(root, 'emberflow', 'apis', 'default');
  mkdirSync(apisDir, { recursive: true });
  writeFileSync(
    join(apisDir, 'clean.json'),
    JSON.stringify(
      {
        id: 'clean',
        name: 'Clean',
        version: 1,
        http: { method: 'GET', path: '/clean' },
        nodes: [
          { id: 'input', type: 'Input', label: 'Input', position: { x: 0, y: 0 }, config: {} },
          { id: 'result', type: 'Result', label: 'Result', position: { x: 200, y: 0 }, config: {} },
        ],
        edges: [{ id: 'e1', source: 'input', target: 'result' }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(apisDir, 'clean.scenarios.json'),
    JSON.stringify(
      [{ id: 's1', name: 'ok', input: {}, expect: { status: 200 } }],
      null,
      2,
    ) + '\n',
  );
}

describe('emberflow doctor (CLI)', () => {
  let logs: string[];
  let errs: string[];

  function captureOutput(): void {
    logs = [];
    errs = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      logs.push(String(chunk));
      return origOut(chunk as never, ...(rest as []));
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      errs.push(String(chunk));
      return origErr(chunk as never, ...(rest as []));
    }) as typeof process.stderr.write;
    restoreOutput = () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    };
  }
  let restoreOutput: () => void = () => {};

  beforeEach(() => {
    captureOutput();
  });
  afterEach(() => {
    restoreOutput();
  });

  it('reports missing-param-default + param-no-real-scenario + no-expects for a broken op, exit 0 (no errors)', async () => {
    const root = scratch();
    writeProjectConfig(root);
    writeBrokenOp(root);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['doctor', 'broken']);

    expect(code).toBe(0);
    const out = logs.join('');
    expect(out).toContain('missing-param-default');
    expect(out).toContain('param-no-real-scenario');
    expect(out).toContain('no-expects');
    expect(out).not.toMatch(/\berror\b/);
    expect(out).toMatch(/\d+ errors, \d+ warnings, \d+ info across \d+ operations/);
  });

  it('reports a clean op with none of the v1 diagnostic codes and exit 0', async () => {
    const root = scratch();
    writeProjectConfig(root);
    writeCleanOp(root);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['doctor', 'clean']);

    expect(code).toBe(0);
    const out = logs.join('');
    expect(out).not.toContain('missing-param-default');
    expect(out).not.toContain('param-no-real-scenario');
    expect(out).not.toContain('no-expects');
    expect(out).toContain('0 errors, 0 warnings, 0 info across 1 operations');
  });

  it('doctor (no id) reports across every operation in the project', async () => {
    const root = scratch();
    writeProjectConfig(root);
    writeBrokenOp(root);
    writeCleanOp(root);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['doctor']);

    expect(code).toBe(0);
    const out = logs.join('');
    expect(out).toContain('broken');
    expect(out).toContain('clean');
    expect(out).toMatch(/across 2 operations/);
  });

  it('--fix rewrites the broken op file with seeded param defaults and the re-report drops missing-param-default', async () => {
    const root = scratch();
    writeProjectConfig(root);
    writeBrokenOp(root);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['doctor', 'broken', '--fix']);

    expect(code).toBe(0);
    const out = logs.join('');
    expect(out).toContain('fixed broken: seeded params — id');

    const onDisk = JSON.parse(
      readFileSync(join(root, 'emberflow', 'apis', 'default', 'broken.json'), 'utf8'),
    ) as { nodes: Array<{ id: string; config?: { defaults?: { params?: Record<string, unknown> } } }> };
    const inputNode = onDisk.nodes.find((n) => n.id === 'input')!;
    expect(inputNode.config?.defaults?.params).toEqual({ id: '' });

    // Ordering per op: header line (`<op.id>`) first, then the `fixed <id>: …`
    // line, then the post-fix diagnostic lines.
    const lines = out.split('\n');
    const headerIdx = lines.indexOf('broken');
    const fixedIdx = lines.findIndex((l) => l.startsWith('fixed broken: seeded params — id'));
    const firstDiagnosticIdx = lines.findIndex((l) => /param-no-real-scenario|no-expects/.test(l));
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(fixedIdx).toBeGreaterThan(headerIdx);
    expect(firstDiagnosticIdx).toBeGreaterThan(fixedIdx);

    // Re-diagnosis after the fix: missing-param-default is gone, but the
    // info-level diagnostics (no real scenario, no expects) remain since
    // --fix only seeds defaults, it doesn't add scenarios.
    const afterFixReport = out.split('fixed broken')[1] ?? out;
    expect(afterFixReport).not.toContain('missing-param-default');
    expect(afterFixReport).toContain('param-no-real-scenario');
    expect(afterFixReport).toContain('no-expects');

    // File format preserved: 2-space indent, trailing newline.
    const raw = readFileSync(join(root, 'emberflow', 'apis', 'default', 'broken.json'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  "id": "broken"');
  });

  it('--fix is a no-op (no "fixed" line) for an op that needs no seeding', async () => {
    const root = scratch();
    writeProjectConfig(root);
    writeCleanOp(root);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['doctor', 'clean', '--fix']);

    expect(code).toBe(0);
    expect(logs.join('')).not.toContain('fixed clean');
  });

  it('unknown operation id exits 2', async () => {
    const root = scratch();
    writeProjectConfig(root);
    writeCleanOp(root);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['doctor', 'no-such-op']);
    expect(code).toBe(2);
  });

  it('unknown flag exits 2 with usage', async () => {
    const root = scratch();
    writeProjectConfig(root);
    writeCleanOp(root);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['doctor', '--bogus']);
    expect(code).toBe(2);
    expect(errs.join('')).toMatch(/usage/i);
  });

  it('EMBERFLOW_PROJECT pointing at a config-less dir exits 2 (not 1)', async () => {
    const root = scratch();
    // No emberflow.config.* written — project loading fails.
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['doctor']);

    expect(code).toBe(2);
    expect(errs.join('')).toMatch(/emberflow\.config/);
  });

  it('reports missing-node-mock for an infra node (registry-registered traceKind db) with no mocks', async () => {
    const root = scratch();
    writeProjectConfigWithDbNode(root);
    writeUnmockedInfraOp(root);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['doctor', 'infra']);

    expect(code).toBe(0);
    const out = logs.join('');
    expect(out).toContain('missing-node-mock');
    expect(out).toContain('"Fetch Rows" touches infrastructure (db) but has no mock');
  });

  it('dispatches through bin/commands.ts (the past login-environment-forgot-the-dispatcher bug must not repeat)', async () => {
    const { runCommand } = await import('../bin/commands');
    const root = scratch();
    writeProjectConfig(root);
    writeCleanOp(root);

    const code = await runCommand({ command: 'doctor', project: root, rest: ['clean'] });

    expect(code).toBe(0);
    expect(logs.join('')).toContain('clean');
  });
});
