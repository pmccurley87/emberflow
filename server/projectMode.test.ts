import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProjectConfig } from './projectConfig';
import { buildRegistries, buildFlowStore, buildApiStore, requireProjectWhenExplicit } from './projectMode';
import { startRun } from '../src/engine';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ef-mode-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function writeFixture(d: string): void {
  mkdirSync(join(d, 'flows'), { recursive: true });
  writeFileSync(join(d, 'emberflow.config.mjs'), `export default {
  flowsDir: 'flows',
  registerNodes(registry) {
    registry.register(
      { type: 'Shout', label: 'Shout', inputSchema: { fields: [{ name: 'text', type: 'string', required: true }] } },
      async (ctx) => ({ loud: String(ctx.input.text).toUpperCase() + '!' }),
    );
  },
};\n`);
  writeFileSync(join(d, 'flows', 'hello.json'), JSON.stringify({
    id: 'hello', name: 'Hello', version: 1,
    nodes: [
      { id: 'in', type: 'Input', label: 'In', position: { x: 0, y: 0 }, config: { fields: [{ name: 'text', type: 'string', required: true }] } },
      { id: 'shout', type: 'Shout', label: 'Shout', position: { x: 200, y: 0 }, config: {}, inputMap: { text: { sourceNodeId: 'in', sourceField: 'text' } } },
    ],
    edges: [{ id: 'e1', source: 'in', target: 'shout' }],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }, null, 2));
  writeFileSync(join(d, 'flows', 'hello.scenarios.json'), JSON.stringify([
    { id: 's1', name: 'greet', input: { text: 'hi' } },
  ]));
}

describe('project mode wiring', () => {
  it('serves project flows with sidecar scenarios and runs consumer nodes', async () => {
    const d = scratch();
    writeFixture(d);
    const project = await loadProjectConfig(d);
    expect(project).not.toBeNull();
    const store = buildFlowStore(project);
    const flow = store.load('hello')!;
    expect(flow.scenarios?.[0].name).toBe('greet');
    const { execution } = buildRegistries(project);
    const run = await startRun({ flow, registry: execution, input: flow.scenarios![0].input }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.shout.output).toEqual({ loud: 'HI!' });
  });

  it('buildApiStore migrates a project with a custom-named flowsDir (not literally "flows")', async () => {
    const d = scratch();
    mkdirSync(join(d, 'my-flows'), { recursive: true });
    writeFileSync(
      join(d, 'my-flows', 'onboarding.json'),
      JSON.stringify({ id: 'onboarding', name: 'Onboarding', nodes: [], edges: [] }, null, 2),
    );
    writeFileSync(
      join(d, 'emberflow.config.mjs'),
      `export default { flowsDir: 'my-flows', registerNodes: () => {} };\n`,
    );
    const project = await loadProjectConfig(d);
    expect(project).not.toBeNull();

    const apiStore = buildApiStore(project);

    // migration ran: apis/default now holds the flow, my-flows/ is gone.
    expect(existsSync(join(d, 'apis', 'default', 'onboarding.json'))).toBe(true);
    expect(existsSync(join(d, 'my-flows'))).toBe(false);
    const tree = apiStore.tree();
    const ids = tree.apis.flatMap((a) => a.operations.map((op) => op.id));
    expect(ids).toContain('onboarding');
  });

  it('null project falls back to default store dir and default registry', () => {
    const store = buildFlowStore(null);
    expect(store.dir.endsWith('workflows')).toBe(true);
    const { validation, execution } = buildRegistries(null);
    expect(validation.has('Input')).toBe(true);
    expect(execution.has('Input')).toBe(true);
    expect(execution.has('Shout')).toBe(false);
  });
});

describe('requireProjectWhenExplicit', () => {
  it('throws when EMBERFLOW_PROJECT is explicit but no config was found', () => {
    expect(() => requireProjectWhenExplicit(null, '/tmp/typo-path', '/tmp/typo-path')).toThrow(
      '/tmp/typo-path',
    );
  });

  it('passes the project through when explicit and found', () => {
    const project = { root: '/tmp/proj' } as never;
    expect(requireProjectWhenExplicit(project, '/tmp/proj', '/tmp/proj')).toBe(project);
  });

  it('stays lenient when implicit (undefined) and no config was found', () => {
    expect(requireProjectWhenExplicit(null, undefined, process.cwd())).toBeNull();
  });
});
