import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ef-clitest-'));
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

/** A single op — `authcheck` — with a Route on `authed` into two Response
 *  branches (200 ok / 401 unauthorized), plus a sidecar with three scenarios:
 *  one that should pass, one that should deliberately fail, and one with no
 *  `expect` (skipped). */
function writeAuthcheckOp(root: string, scenarios: unknown[]): void {
  const apisDir = join(root, 'emberflow', 'apis', 'default');
  mkdirSync(apisDir, { recursive: true });
  writeFileSync(
    join(apisDir, 'authcheck.json'),
    JSON.stringify(
      {
        id: 'authcheck',
        name: 'Auth Check',
        version: 1,
        http: { method: 'POST', path: '/authcheck' },
        nodes: [
          {
            id: 'input',
            type: 'Input',
            label: 'Input',
            position: { x: 0, y: 0 },
            config: { fields: [{ name: 'authed', type: 'boolean' }] },
          },
          {
            id: 'route',
            type: 'Route',
            label: 'Route',
            position: { x: 200, y: 0 },
            config: { field: 'authed', branches: ['true', 'false'] },
            inputMap: { value: { sourceNodeId: 'input', sourceField: '$' } },
          },
          {
            id: 'respOk',
            type: 'Response',
            label: 'OK',
            position: { x: 400, y: -80 },
            config: { status: 200, body: { ok: true } },
          },
          {
            id: 'respUnauth',
            type: 'Response',
            label: 'Unauthorized',
            position: { x: 400, y: 80 },
            config: { status: 401, body: { error: 'unauthorized' } },
          },
        ],
        edges: [
          { id: 'e1', source: 'input', target: 'route' },
          { id: 'e2', source: 'route', target: 'respOk', sourceHandle: 'true' },
          { id: 'e3', source: 'route', target: 'respUnauth', sourceHandle: 'false' },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      null,
      2,
    ),
  );
  writeFileSync(join(apisDir, 'authcheck.scenarios.json'), JSON.stringify(scenarios, null, 2));
}

function writeProjectConfig(root: string): void {
  writeFileSync(join(root, 'emberflow.config.mjs'), 'export default {};\n');
}

/** Config registering a 'FakeDb' node whose real implementation always
 *  throws — proof that a passing --mock run never called it for real (an
 *  unmocked throw would fail the run, and thus the scenario's expectation). */
function writeProjectConfigWithThrowingDbNode(root: string): void {
  writeFileSync(
    join(root, 'emberflow.config.mjs'),
    `export default {
  registerNodes(registry) {
    registry.register(
      {
        type: 'FakeDb',
        label: 'Fake DB',
        traceKind: 'db',
        inputSchema: { fields: [] },
      },
      async () => {
        throw new Error('real DB touched — this must never run under --mock');
      },
    );
  },
};\n`,
  );
}

/** A single op — 'infra-op' — with one 'FakeDb' (traceKind: db) node feeding
 *  Result, op-level mocked (`db: {id:1, source:'op-mock'}`). Carries two
 *  expecting scenarios: one relies on the op-level mock as-is, the other
 *  overrides it per nodeId via its own `mocks`. */
function writeInfraOp(root: string): void {
  const apisDir = join(root, 'emberflow', 'apis', 'default');
  mkdirSync(apisDir, { recursive: true });
  writeFileSync(
    join(apisDir, 'infra-op.json'),
    JSON.stringify({
      id: 'infra-op',
      name: 'Infra Op',
      version: 1,
      nodes: [
        { id: 'db', type: 'FakeDb', label: 'DB', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'result',
          type: 'Result',
          label: 'Result',
          position: { x: 200, y: 0 },
          config: {},
          inputMap: { row: { sourceNodeId: 'db', sourceField: '$' } },
        },
      ],
      edges: [{ id: 'e1', source: 'db', target: 'result' }],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
  );
  writeFileSync(
    join(apisDir, 'infra-op.scenarios.json'),
    JSON.stringify({
      scenarios: [
        {
          id: 's-mocked',
          name: 'db-mocked',
          input: {},
          expect: { body: { row: { id: 1, source: 'op-mock' } } },
        },
        {
          id: 's-scenario-override',
          name: 'db-scenario-override',
          input: {},
          expect: { body: { row: { id: 2, source: 'scenario-mock' } } },
          mocks: { db: { id: 2, source: 'scenario-mock' } },
        },
      ],
      mocks: { db: { id: 1, source: 'op-mock' } },
    }),
  );
}

/** A second op — 'infra-op-unmocked' — same 'FakeDb' node, but NO mock
 *  anywhere (no op-level, no scenario-level). Proves the fail-loud path. */
function writeInfraOpUnmocked(root: string): void {
  const apisDir = join(root, 'emberflow', 'apis', 'default');
  mkdirSync(apisDir, { recursive: true });
  writeFileSync(
    join(apisDir, 'infra-op-unmocked.json'),
    JSON.stringify({
      id: 'infra-op-unmocked',
      name: 'Infra Op Unmocked',
      version: 1,
      nodes: [
        { id: 'db', type: 'FakeDb', label: 'DB', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'result',
          type: 'Result',
          label: 'Result',
          position: { x: 200, y: 0 },
          config: {},
          inputMap: { row: { sourceNodeId: 'db', sourceField: '$' } },
        },
      ],
      edges: [{ id: 'e1', source: 'db', target: 'result' }],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
  );
  writeFileSync(
    join(apisDir, 'infra-op-unmocked.scenarios.json'),
    JSON.stringify({
      scenarios: [
        {
          id: 's1',
          name: 'db-untouched',
          input: {},
          // `detail` deliberately wrong — forces the failure diff to quote the
          // ACTUAL error string, proving it's the executor's fail-loud message.
          expect: { status: 200, body: { error: 'run failed', detail: 'unreachable' } },
        },
      ],
    }),
  );
}

describe('emberflow test (CLI)', () => {
  let logs: string[];
  let errs: string[];

  // Capture process.stdout/stderr writes directly (no vi.spyOn — runCli is
  // in-process, so its writes land on the real streams); restored below.
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

  it('exits 1 and reports 1 failed/1 passed/1 skipped for a mixed scenario set', async () => {
    const root = scratch();
    writeProjectConfig(root);
    writeAuthcheckOp(root, [
      { id: 's-pass', name: 'authed-ok', input: { authed: true }, expect: { status: 200, body: { ok: true } } },
      // Deliberately wrong expectation: authed:true routes to 200, but this
      // scenario asserts 401 — must fail.
      { id: 's-fail', name: 'expired', input: { authed: true }, expect: { status: 401 } },
      { id: 's-skip', name: 'no-assertion', input: { authed: false } },
    ]);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['test']);

    expect(code).toBe(1);
    const out = logs.join('');
    expect(out).toContain('1 passed');
    expect(out).toContain('1 failed');
    expect(out).toContain('1 skipped');
    expect(out).toContain('✓ authcheck · authed-ok');
    expect(out).toContain('✗ authcheck · expired');
    expect(out).toContain('status: expected 401, got 200');
    // Skipped scenarios aren't printed as their own line.
    expect(out).not.toContain('no-assertion');
  });

  it('exits 0 when every expecting scenario passes', async () => {
    const root = scratch();
    writeProjectConfig(root);
    writeAuthcheckOp(root, [
      { id: 's-pass', name: 'authed-ok', input: { authed: true }, expect: { status: 200, body: { ok: true } } },
      { id: 's-pass2', name: 'unauthed-401', input: { authed: false }, expect: { status: 401 } },
      { id: 's-skip', name: 'fixture-only', input: { authed: true } },
      { id: 's-empty', name: 'empty-expect', input: { authed: true }, expect: {} },
    ]);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['test']);

    expect(code).toBe(0);
    const out = logs.join('');
    expect(out).toContain('2 passed');
    expect(out).toContain('0 failed');
    expect(out).toContain('2 skipped');
  });

  it('--json prints a machine-readable array carrying per-scenario failures', async () => {
    const root = scratch();
    writeProjectConfig(root);
    writeAuthcheckOp(root, [
      { id: 's-pass', name: 'authed-ok', input: { authed: true }, expect: { status: 200 } },
      { id: 's-fail', name: 'expired', input: { authed: true }, expect: { status: 401 } },
    ]);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['test', '--json']);

    expect(code).toBe(1);
    const parsed = JSON.parse(logs.join('')) as Array<{
      opId: string;
      scenario: string;
      status: string;
      failures?: string[];
    }>;
    expect(parsed).toHaveLength(2);
    const passed = parsed.find((r) => r.scenario === 'authed-ok')!;
    expect(passed.status).toBe('passed');
    const failed = parsed.find((r) => r.scenario === 'expired')!;
    expect(failed.status).toBe('failed');
    expect(failed.failures).toEqual(['status: expected 401, got 200']);
  });

  it('unknown opId exits 2', async () => {
    const root = scratch();
    writeProjectConfig(root);
    writeAuthcheckOp(root, [
      { id: 's-pass', name: 'authed-ok', input: { authed: true }, expect: { status: 200 } },
    ]);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['test', 'no-such-op']);
    expect(code).toBe(2);
  });

  it('unknown environment exits 2', async () => {
    const root = scratch();
    writeProjectConfig(root);
    writeAuthcheckOp(root, [
      { id: 's-pass', name: 'authed-ok', input: { authed: true }, expect: { status: 200 } },
    ]);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['test', '--environment', 'no-such-env']);
    expect(code).toBe(2);
  });

  it('an op with zero scenarios is silently ignored', async () => {
    const root = scratch();
    writeProjectConfig(root);
    const apisDir = join(root, 'emberflow', 'apis', 'default');
    mkdirSync(apisDir, { recursive: true });
    writeFileSync(
      join(apisDir, 'bare.json'),
      JSON.stringify({
        id: 'bare',
        name: 'Bare',
        version: 1,
        nodes: [{ id: 'result', type: 'Result', label: 'Result', position: { x: 0, y: 0 }, config: {} }],
        edges: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    );
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['test']);
    expect(code).toBe(0);
    expect(logs.join('')).toContain('0 passed, 0 failed, 0 skipped');
    // Nothing was asserted — a vacuous green must warn on stderr (exit stays 0).
    expect(errs.join('')).toContain('warning: no scenarios asserted (0 skipped)');
  });

  it('warns on stderr when every scenario is skipped (nothing asserted), still exit 0', async () => {
    const root = scratch();
    writeProjectConfig(root);
    writeAuthcheckOp(root, [
      { id: 's1', name: 'fixture-only', input: { authed: true } },
      { id: 's2', name: 'empty-expect', input: { authed: false }, expect: {} },
    ]);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['test']);
    expect(code).toBe(0);
    expect(logs.join('')).toContain('0 passed, 0 failed, 2 skipped');
    expect(errs.join('')).toContain('warning: no scenarios asserted (2 skipped)');
  });

  it('redacts secret values out of failure diffs (never prints the raw secret)', async () => {
    const root = scratch();
    // Project node that receives a secret via {"$secret": ...} config and
    // echoes it into the run output — the worst case for a failure diff.
    writeFileSync(
      join(root, 'emberflow.config.mjs'),
      `export default {
  registerNodes(registry) {
    registry.register(
      { type: 'EchoToken', label: 'Echo Token', inputSchema: { fields: [{ name: 'token', type: 'string' }] } },
      async (ctx) => ({ token: ctx.input.token }),
    );
  },
};\n`,
    );
    writeFileSync(
      join(root, 'emberflow.environments.json'),
      JSON.stringify({
        defaultEnvironment: 'local',
        environments: { local: { vars: {}, secrets: { API_TOKEN: 'supersecretvalue' } } },
      }),
    );
    const apisDir = join(root, 'emberflow', 'apis', 'default');
    mkdirSync(apisDir, { recursive: true });
    writeFileSync(
      join(apisDir, 'leaky.json'),
      JSON.stringify({
        id: 'leaky',
        name: 'Leaky',
        version: 1,
        nodes: [
          {
            id: 'echo',
            type: 'EchoToken',
            label: 'Echo',
            position: { x: 0, y: 0 },
            config: { token: { $secret: 'API_TOKEN' } },
          },
          {
            id: 'result',
            type: 'Result',
            label: 'Result',
            position: { x: 200, y: 0 },
            config: {},
            inputMap: { token: { sourceNodeId: 'echo', sourceField: 'token' } },
          },
        ],
        edges: [{ id: 'e1', source: 'echo', target: 'result' }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    );
    writeFileSync(
      join(apisDir, 'leaky.scenarios.json'),
      JSON.stringify([
        // Deliberate body mismatch so the failure diff quotes the ACTUAL body
        // (which contains the echoed secret) — it must arrive redacted.
        { id: 's1', name: 'mismatch', input: {}, expect: { body: { token: 'not-the-secret' } } },
      ]),
    );
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['test', '--json']);

    expect(code).toBe(1);
    const allOutput = logs.join('') + errs.join('');
    expect(allOutput).not.toContain('supersecretvalue');
    expect(allOutput).toContain('«secret:API_TOKEN»');
    const parsed = JSON.parse(logs.join('')) as Array<{ status: string; failures?: string[] }>;
    expect(parsed[0].status).toBe('failed');
    expect(parsed[0].failures!.join(' ')).toContain('«secret:API_TOKEN»');
  });

  describe('--mock', () => {
    it('passes a scenario relying on the op-level mock, without ever calling the real (throwing) node', async () => {
      const root = scratch();
      writeProjectConfigWithThrowingDbNode(root);
      writeInfraOp(root);
      process.env.EMBERFLOW_PROJECT = root;

      const code = await runCli(['test', 'infra-op', '--json', '--mock']);

      expect(code).toBe(0);
      const parsed = JSON.parse(logs.join('')) as Array<{ scenario: string; status: string; failures?: string[] }>;
      const mocked = parsed.find((r) => r.scenario === 'db-mocked')!;
      expect(mocked.status).toBe('passed');
    });

    it('scenario-level mocks override the op-level mock per nodeId', async () => {
      const root = scratch();
      writeProjectConfigWithThrowingDbNode(root);
      writeInfraOp(root);
      process.env.EMBERFLOW_PROJECT = root;

      const code = await runCli(['test', 'infra-op', '--json', '--mock']);

      expect(code).toBe(0);
      const parsed = JSON.parse(logs.join('')) as Array<{ scenario: string; status: string; failures?: string[] }>;
      const overridden = parsed.find((r) => r.scenario === 'db-scenario-override')!;
      expect(overridden.status).toBe('passed');
    });

    it('an unmocked infra node under --mock fails loudly, and the scenario reports failure', async () => {
      const root = scratch();
      writeProjectConfigWithThrowingDbNode(root);
      writeInfraOpUnmocked(root);
      process.env.EMBERFLOW_PROJECT = root;

      const code = await runCli(['test', 'infra-op-unmocked', '--json', '--mock']);

      expect(code).toBe(1);
      const parsed = JSON.parse(logs.join('')) as Array<{ scenario: string; status: string; failures?: string[] }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0].status).toBe('failed');
      // The executor's fail-loud message, surfaced through the 500 fallback
      // extractResponse builds when no Response node succeeded.
      expect(parsed[0].failures!.join(' ')).toContain('would touch real infrastructure');
    });

    it('without --mock, behavior is unchanged: the real (throwing) node executes and the run fails for real', async () => {
      const root = scratch();
      writeProjectConfigWithThrowingDbNode(root);
      writeInfraOpUnmocked(root);
      process.env.EMBERFLOW_PROJECT = root;

      const code = await runCli(['test', 'infra-op-unmocked', '--json']);

      expect(code).toBe(1);
      const parsed = JSON.parse(logs.join('')) as Array<{ scenario: string; status: string; failures?: string[] }>;
      expect(parsed.every((r) => r.status === 'failed')).toBe(true);
      expect(parsed.map((r) => r.failures!.join(' ')).join(' ')).toContain('real DB touched');
    });
  });
});

describe('emberflow list-environments (CLI)', () => {
  let logs: string[];
  let restoreOutput: () => void = () => {};

  beforeEach(() => {
    logs = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      logs.push(String(chunk));
      return origOut(chunk as never, ...(rest as []));
    }) as typeof process.stdout.write;
    restoreOutput = () => {
      process.stdout.write = origOut;
    };
  });
  afterEach(() => {
    restoreOutput();
  });

  it('falls back to an in-process offline load when the runner is unreachable', async () => {
    const root = scratch();
    writeFileSync(
      join(root, 'emberflow.environments.json'),
      JSON.stringify({
        defaultEnvironment: 'dev',
        environments: { dev: { vars: { API_URL: 'https://example.test' }, secrets: ['API_KEY'] } },
      }),
    );
    writeFileSync(join(root, 'emberflow.secrets.json'), JSON.stringify({ dev: { API_KEY: 'k' } }), {
      mode: 0o600,
    });
    process.env.EMBERFLOW_PROJECT = root;
    // Nothing listens on this port — forces RunnerUnreachableError.
    process.env.EMBERFLOW_RUNNER_URL = 'http://127.0.0.1:1';

    const code = await runCli(['list-environments']);

    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('')) as {
      source: string;
      defaultEnvironment: string;
      environments: Array<{ name: string; varKeys: string[]; secretKeys: string[] }>;
    };
    expect(parsed.source).toBe('offline');
    expect(parsed.defaultEnvironment).toBe('dev');
    expect(parsed.environments).toEqual([
      { name: 'dev', protected: false, varKeys: ['API_URL'], secretKeys: ['API_KEY'] },
    ]);
    // Never leaks the secret value, only its key name.
    expect(logs.join('')).not.toContain('"k"');

    delete process.env.EMBERFLOW_RUNNER_URL;
  });
});

describe('emberflow get-node (CLI)', () => {
  let logs: string[];
  let errs: string[];
  let restoreOutput: () => void = () => {};

  beforeEach(() => {
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
    // Force the runner-unreachable offline path so these run hermetically.
    process.env.EMBERFLOW_RUNNER_URL = 'http://127.0.0.1:1';
  });
  afterEach(() => {
    restoreOutput();
    delete process.env.EMBERFLOW_RUNNER_URL;
  });

  /** A project registering a 'Lookup' infra node (traceKind db, mutation
   *  effects, typed input/output schemas) and a 'graph-op' wiring
   *  input → lookup → result with a couple of edges. */
  function writeGraphProject(root: string): void {
    writeFileSync(
      join(root, 'emberflow.config.mjs'),
      `export default {
  registerNodes(registry) {
    registry.register(
      {
        type: 'Lookup',
        label: 'Lookup User',
        traceKind: 'db',
        effects: 'mutation',
        inputSchema: { fields: [{ name: 'userId', type: 'string' }] },
        outputSchema: { fields: [{ name: 'name', type: 'string' }, { name: 'email', type: 'string' }] },
      },
      async () => ({ name: 'x', email: 'y' }),
    );
  },
};\n`,
    );
    const apisDir = join(root, 'emberflow', 'apis', 'default');
    mkdirSync(apisDir, { recursive: true });
    writeFileSync(
      join(apisDir, 'graph-op.json'),
      JSON.stringify({
        id: 'graph-op',
        name: 'Graph Op',
        version: 1,
        nodes: [
          { id: 'input', type: 'Input', label: 'Input', position: { x: 0, y: 0 }, config: {} },
          {
            id: 'lookup',
            type: 'Lookup',
            label: 'Lookup',
            position: { x: 200, y: 0 },
            config: { table: 'users' },
            inputMap: { userId: { sourceNodeId: 'input', sourceField: 'id' } },
            retry: { maxTries: 3 },
            optional: true,
          },
          { id: 'result', type: 'Result', label: 'Result', position: { x: 400, y: 0 }, config: {} },
        ],
        edges: [
          { id: 'e1', source: 'input', target: 'lookup' },
          { id: 'e2', source: 'lookup', target: 'result', sourceHandle: 'ok' },
        ],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    );
  }

  it('prints a node instance, its inbound + outbound edges, and the registered definition summary', async () => {
    const root = scratch();
    writeGraphProject(root);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['get-node', 'graph-op', 'lookup']);

    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('')) as {
      operation: string;
      node: { id: string; type: string; config: unknown; inputMap: unknown; retry?: unknown; optional?: boolean };
      inbound: Array<{ source: string; sourceHandle?: string }>;
      outbound: Array<{ target: string; sourceHandle?: string }>;
      definition: { type: string; traceKind?: string; effects?: string; inputFields: string[]; outputFields: string[] } | null;
    };
    expect(parsed.operation).toBe('graph-op');
    expect(parsed.node.id).toBe('lookup');
    expect(parsed.node.type).toBe('Lookup');
    expect(parsed.node.config).toEqual({ table: 'users' });
    expect(parsed.node.inputMap).toEqual({ userId: { sourceNodeId: 'input', sourceField: 'id' } });
    expect(parsed.node.retry).toEqual({ maxTries: 3 });
    expect(parsed.node.optional).toBe(true);
    expect(parsed.inbound).toEqual([{ source: 'input' }]);
    expect(parsed.outbound).toEqual([{ target: 'result', sourceHandle: 'ok' }]);
    expect(parsed.definition).toMatchObject({
      type: 'Lookup',
      traceKind: 'db',
      effects: 'mutation',
      inputFields: ['userId'],
      outputFields: ['name', 'email'],
    });
  });

  it('definition is null for a node whose type is not registered', async () => {
    const root = scratch();
    writeFileSync(join(root, 'emberflow.config.mjs'), 'export default {};\n');
    const apisDir = join(root, 'emberflow', 'apis', 'default');
    mkdirSync(apisDir, { recursive: true });
    writeFileSync(
      join(apisDir, 'bare.json'),
      JSON.stringify({
        id: 'bare',
        name: 'Bare',
        version: 1,
        nodes: [{ id: 'mystery', type: 'NotRegistered', label: 'Mystery', position: { x: 0, y: 0 }, config: {} }],
        edges: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    );
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['get-node', 'bare', 'mystery']);

    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('')) as { definition: unknown };
    expect(parsed.definition).toBeNull();
  });

  it('unknown operation exits 1', async () => {
    const root = scratch();
    writeGraphProject(root);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['get-node', 'no-such-op', 'lookup']);
    expect(code).toBe(1);
    expect(errs.join('')).toContain('Unknown operation');
  });

  it('unknown node in a known operation exits 1', async () => {
    const root = scratch();
    writeGraphProject(root);
    process.env.EMBERFLOW_PROJECT = root;

    const code = await runCli(['get-node', 'graph-op', 'no-such-node']);
    expect(code).toBe(1);
    expect(errs.join('')).toContain('Unknown node');
  });

  it('missing args exit 2', async () => {
    const code = await runCli(['get-node', 'graph-op']);
    expect(code).toBe(2);
  });
});
