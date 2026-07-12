import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FlowStore } from './flowStore';
import type { WorkflowDefinition } from '../src/engine';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ef-store-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const flow = (id: string, scenarios?: WorkflowDefinition['scenarios']): WorkflowDefinition => ({
  id, name: id, version: 1, nodes: [], edges: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  ...(scenarios ? { scenarios } : {}),
});
const scenario = { id: 's1', name: 'happy', input: { a: 1 } };

describe('FlowStore scenario sidecars', () => {
  it('sidecar mode: save splits scenarios into <id>.scenarios.json', () => {
    const d = scratch();
    const store = new FlowStore(d, { scenarioSidecars: true });
    store.save(flow('f1', [scenario]));
    const onDisk = JSON.parse(readFileSync(join(d, 'f1.json'), 'utf8'));
    expect(onDisk.scenarios).toBeUndefined();
    const sidecar = JSON.parse(readFileSync(join(d, 'f1.scenarios.json'), 'utf8'));
    expect(sidecar).toEqual([scenario]);
  });

  it('sidecar mode: load and list merge the sidecar back', () => {
    const d = scratch();
    const store = new FlowStore(d, { scenarioSidecars: true });
    store.save(flow('f1', [scenario]));
    expect(store.load('f1')!.scenarios).toEqual([scenario]);
    expect(store.list()[0].scenarios).toEqual([scenario]);
  });

  it('sidecar mode: saving with no scenarios removes a stale sidecar', () => {
    const d = scratch();
    const store = new FlowStore(d, { scenarioSidecars: true });
    store.save(flow('f1', [scenario]));
    store.save(flow('f1'));
    expect(existsSync(join(d, 'f1.scenarios.json'))).toBe(false);
    expect(store.load('f1')!.scenarios).toBeUndefined();
  });

  it('sidecar mode: hand-authored sidecar is merged even if flow file has none', () => {
    const d = scratch();
    writeFileSync(join(d, 'f2.json'), JSON.stringify(flow('f2')));
    writeFileSync(join(d, 'f2.scenarios.json'), JSON.stringify([scenario]));
    const store = new FlowStore(d, { scenarioSidecars: true });
    expect(store.load('f2')!.scenarios).toEqual([scenario]);
  });

  it('default mode: scenarios stay embedded, no sidecar written', () => {
    const d = scratch();
    const store = new FlowStore(d);
    store.save(flow('f1', [scenario]));
    const onDisk = JSON.parse(readFileSync(join(d, 'f1.json'), 'utf8'));
    expect(onDisk.scenarios).toEqual([scenario]);
    expect(existsSync(join(d, 'f1.scenarios.json'))).toBe(false);
  });

  it('remove cleans sidecar and seedIfEmpty ignores orphaned sidecars', () => {
    const d = scratch();
    const store = new FlowStore(d, { scenarioSidecars: true });
    store.save(flow('f1', [scenario]));
    store.remove('f1');
    expect(existsSync(join(d, 'f1.scenarios.json'))).toBe(false);
    store.seedIfEmpty([flow('seeded')]);
    expect(existsSync(join(d, 'seeded.json'))).toBe(true);
  });

  it('list skips .scenarios.json files as flow candidates in both modes', () => {
    const d = scratch();
    const store = new FlowStore(d, { scenarioSidecars: true });
    store.save(flow('f1', [scenario]));
    expect(store.list().map((f) => f.id)).toEqual(['f1']);
  });
});
