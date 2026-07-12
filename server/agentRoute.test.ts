import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Task 2 review finding: the `setup-environments` agent intent (route
// validation added in server/index.ts, ~L712) shipped without a test that
// boots a real runner and drives POST /agent end to end. This covers the
// accept path (no flowId/environment required) and the two reject paths
// (missing instruction; an action outside the allowlist), against a real
// runner subprocess the way server/mockServe.test.ts does.

const PORT = 8151;
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

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

let proc: ChildProcess;
let projectDir: string;
let codexStubPath: string;

async function postAgent(body: unknown): Promise<Response> {
  return fetch(`${base}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'agentroute-'));
  mkdirSync(join(projectDir, 'emberflow', 'apis', 'default'), { recursive: true });
  writeFileSync(join(projectDir, 'emberflow.config.mjs'), 'export default {};\n');
  // Minimal real operation so ask-with-flowId can resolve a relPath.
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

  // AgentRunManager.start() requires a git repo (isGitRepo check) before it
  // will snapshot + spawn — give the fixture project one, with an initial
  // commit so the snapshot has something to diff against.
  git(projectDir, ['init']);
  git(projectDir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'add', '-A']);
  git(projectDir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init']);

  // A harmless stand-in for the codex CLI: an accepted setup-environments
  // intent spawns the coding agent for real, so without this the test would
  // shell out to an actual `codex` binary. EMBERFLOW_CODEX_BIN (consumed by
  // AgentRunManager.start(), server/agents/runManager.ts) overrides the bin
  // passed to spawnCodex (server/agents/codexAdapter.ts), which spawns it
  // directly with codex's CLI args and reads its stdout as JSON lines. Exiting
  // 0 with no stdout is enough for the adapter to reach a clean 'done'/'error'
  // terminal state without any real agent behavior.
  codexStubPath = join(projectDir, 'fake-codex.sh');
  writeFileSync(codexStubPath, '#!/bin/sh\nexit 0\n');
  chmodSync(codexStubPath, 0o755);

  proc = spawn('npx', ['tsx', 'server/index.ts'], {
    env: {
      ...process.env,
      EMBERFLOW_RUNNER_PORT: String(PORT),
      EMBERFLOW_PROJECT: projectDir,
      EMBERFLOW_CODEX_BIN: codexStubPath,
    },
    stdio: 'ignore',
  });

  await waitHealthy(`${base}/healthz`);
}, 20_000);

afterAll(() => {
  proc?.kill();
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe('POST /agent — setup-environments route validation', () => {
  it('accepts a setup-environments intent WITHOUT flowId or environment', async () => {
    const res = await postAgent({ intent: { action: 'setup-environments', instruction: 'dev and prod' } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.agentRunId).toBe('string');
    expect(body.agentRunId.length).toBeGreaterThan(0);
  });

  it('400s a setup-environments intent with no instruction', async () => {
    const res = await postAgent({ intent: { action: 'setup-environments' } });
    expect(res.status).toBe(400);
  });

  it('400s an action outside the allowlist, mentioning the unsupported action', async () => {
    const res = await postAgent({ intent: { action: 'nonsense', instruction: 'x' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('nonsense');
  });
});

/** The run manager is single-flight per project (409 while a previous stub run
 *  winds down) — retry briefly so route-validation asserts don't race it. */
async function postAgentWhenFree(body: unknown): Promise<Response> {
  for (let i = 0; i < 40; i++) {
    const res = await postAgent(body);
    if (res.status !== 409) return res;
    await new Promise((r) => setTimeout(r, 250));
  }
  return postAgent(body);
}

describe('POST /agent — ask route validation', () => {
  it('accepts an ask intent WITHOUT flowId', async () => {
    const res = await postAgentWhenFree({ intent: { action: 'ask', instruction: 'where is the slack rendering?' } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.agentRunId).toBe('string');
  });

  it('accepts an ask intent WITH a flowId', async () => {
    const res = await postAgentWhenFree({ intent: { action: 'ask', flowId: 'default/hello', instruction: 'what does this op do?' } });
    expect(res.status).toBe(201);
  });

  it('400s an ask intent with a non-string flowId', async () => {
    const res = await postAgent({ intent: { action: 'ask', flowId: 42, instruction: 'x' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('flowId');
  });
});
