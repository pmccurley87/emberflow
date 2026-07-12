import { mkdirSync, writeFileSync, rmSync, renameSync, readFileSync as rf, existsSync as ex } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiStore } from './apiStore';

let root: string;
beforeEach(() => {
  root = join(tmpdir(), `apistore-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'claims', 'claims'), { recursive: true });
  mkdirSync(join(root, 'billing'), { recursive: true });
  writeFileSync(
    join(root, 'claims', 'claims', 'create.json'),
    JSON.stringify({
      id: 'create-claim',
      name: 'Create claim',
      version: 1,
      nodes: [],
      edges: [],
      http: { method: 'POST', path: '/claims' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
  );
  writeFileSync(
    join(root, 'claims', 'claims', 'create.scenarios.json'),
    JSON.stringify([{ name: 'happy', input: { body: {} } }]),
  );
  writeFileSync(
    join(root, 'billing', 'charge.json'),
    JSON.stringify({
      id: 'charge',
      name: 'Charge',
      version: 1,
      nodes: [],
      edges: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('ApiStore read', () => {
  it('lists all operations across the tree with ids and http', () => {
    const store = new ApiStore(root);
    const ids = store.list().map((o) => o.id).sort();
    expect(ids).toEqual(['charge', 'create-claim']);
    const create = store.list().find((o) => o.id === 'create-claim')!;
    expect(create.http).toEqual({ method: 'POST', path: '/claims' });
  });

  it('loads a single operation by id and merges its scenarios sidecar', () => {
    const store = new ApiStore(root);
    const op = store.load('create-claim')!;
    expect(op.name).toBe('Create claim');
    expect(op.scenarios).toEqual([{ name: 'happy', input: { body: {} } }]);
  });

  it('maps an id to its on-disk relative path', () => {
    const store = new ApiStore(root);
    expect(store.pathOf('create-claim')).toBe('claims/claims/create');
    expect(store.pathOf('charge')).toBe('billing/charge');
    expect(store.pathOf('nope')).toBeUndefined();
  });

  it('listSummaries returns each op with its path and http', () => {
    const summaries = new ApiStore(root).listSummaries();
    const create = summaries.find((s) => s.id === 'create-claim')!;
    expect(create.path).toBe('claims/claims/create');
    expect(create.http).toEqual({ method: 'POST', path: '/claims' });
    expect(create.name).toBe('Create claim');
    const charge = summaries.find((s) => s.id === 'charge')!;
    expect(charge.path).toBe('billing/charge');
    expect(charge.http).toBeUndefined();
  });

  it('groups operations into an api/folder tree', () => {
    const tree = new ApiStore(root).tree();
    const claims = tree.apis.find((a) => a.name === 'claims')!;
    expect(claims.folders.map((f) => f.name)).toEqual(['claims']);
    expect(claims.folders[0].operations.map((o) => o.id)).toEqual(['create-claim']);
    const billing = tree.apis.find((a) => a.name === 'billing')!;
    expect(billing.operations.map((o) => o.id)).toEqual(['charge']);
  });
});

describe('ApiStore write', () => {
  it('saves a new operation into an api/folder with its scenario sidecar', () => {
    const store = new ApiStore(root);
    store.save(
      {
        id: 'del-claim',
        name: 'Delete claim',
        version: 1,
        nodes: [],
        edges: [],
        http: { method: 'DELETE', path: '/claims/:id' },
        scenarios: [{ id: 's', name: 's', input: {} }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      'claims/claims/delete',
    );
    const main = JSON.parse(rf(join(root, 'claims', 'claims', 'delete.json'), 'utf8'));
    expect(main.id).toBe('del-claim');
    expect(main.scenarios).toBeUndefined(); // scenarios live in the sidecar
    expect(ex(join(root, 'claims', 'claims', 'delete.scenarios.json'))).toBe(true);
    expect(store.load('del-claim')!.scenarios).toEqual([{ id: 's', name: 's', input: {} }]);
  });

  it('removes an operation and its sidecar by id', () => {
    const store = new ApiStore(root);
    expect(store.remove('create-claim')).toBe(true);
    expect(store.load('create-claim')).toBeUndefined();
    expect(ex(join(root, 'claims', 'claims', 'create.json'))).toBe(false);
    expect(ex(join(root, 'claims', 'claims', 'create.scenarios.json'))).toBe(false);
    expect(store.remove('nope')).toBe(false);
  });

  it('saves op-level mocks alongside scenarios in an object-shaped sidecar', () => {
    const store = new ApiStore(root);
    store.save(
      {
        id: 'del-claim',
        name: 'Delete claim',
        version: 1,
        nodes: [],
        edges: [],
        scenarios: [{ id: 's', name: 's', input: {} }],
        mocks: { dbNode: { rows: [] } },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      'claims/claims/delete',
    );
    const sidecar = JSON.parse(rf(join(root, 'claims', 'claims', 'delete.scenarios.json'), 'utf8'));
    expect(sidecar).toEqual({ scenarios: [{ id: 's', name: 's', input: {} }], mocks: { dbNode: { rows: [] } } });
    const loaded = store.load('del-claim')!;
    expect(loaded.scenarios).toEqual([{ id: 's', name: 's', input: {} }]);
    expect(loaded.mocks).toEqual({ dbNode: { rows: [] } });
  });

  it('re-saving with scenarios only preserves the sidecar\'s existing top-level mocks untouched', () => {
    const store = new ApiStore(root);
    store.save(
      {
        id: 'del-claim',
        name: 'Delete claim',
        version: 1,
        nodes: [],
        edges: [],
        scenarios: [{ id: 's', name: 's', input: {} }],
        mocks: { dbNode: { rows: [] } },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      'claims/claims/delete',
    );
    // Re-save as if a caller edited only scenarios and passed a flow object
    // that never carried `mocks` at all (e.g. a client that doesn't round-trip
    // unknown fields) — the sidecar's mocks must survive untouched.
    store.save(
      {
        id: 'del-claim',
        name: 'Delete claim',
        version: 1,
        nodes: [],
        edges: [],
        scenarios: [{ id: 's', name: 's', input: {} }, { id: 's2', name: 's2', input: {} }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      'claims/claims/delete',
    );
    const loaded = store.load('del-claim')!;
    expect(loaded.scenarios).toEqual([{ id: 's', name: 's', input: {} }, { id: 's2', name: 's2', input: {} }]);
    expect(loaded.mocks).toEqual({ dbNode: { rows: [] } });
  });

  it('loads a legacy bare-array sidecar (no mocks) exactly as before', () => {
    const store = new ApiStore(root);
    const op = store.load('create-claim')!;
    expect(op.scenarios).toEqual([{ name: 'happy', input: { body: {} } }]);
    expect(op.mocks).toBeUndefined();
  });
});

describe('ApiStore.existsAt', () => {
  it('reports true for an existing op path and false for a free one', () => {
    const store = new ApiStore(root);
    expect(store.existsAt('billing/charge')).toBe(true);
    expect(store.existsAt('billing/refund')).toBe(false);
    expect(store.existsAt('claims/claims/create')).toBe(true);
  });
});

describe('ApiStore stale-cache resistance (out-of-band disk edits)', () => {
  it('still finds a renamed op after a warm scan, and finds new ops without reconstruction', () => {
    const store = new ApiStore(root);
    // Warm the index.
    expect(store.load('charge')).toBeDefined();

    // Rename on disk out-of-band (same in-file id, new path).
    renameSync(join(root, 'billing', 'charge.json'), join(root, 'billing', 'renamed.json'));
    expect(store.load('charge')).toBeDefined();
    expect(store.pathOf('charge')).toBe('billing/renamed');

    // Add a brand-new op file on disk after construction.
    writeFileSync(
      join(root, 'billing', 'refund.json'),
      JSON.stringify({
        id: 'refund',
        name: 'Refund',
        version: 1,
        nodes: [],
        edges: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    );
    expect(store.load('refund')).toBeDefined();
  });

  it('warns when two files share the same in-file id', () => {
    writeFileSync(
      join(root, 'billing', 'dup.json'),
      JSON.stringify({
        id: 'charge', // duplicate of billing/charge.json's id
        name: 'Duplicate charge',
        version: 1,
        nodes: [],
        edges: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new ApiStore(root).list();
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('duplicate operation id "charge"'))).toBe(true);
    warn.mockRestore();
  });

  it('warns when saving over a file that holds a different op id', () => {
    const store = new ApiStore(root);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.save(
      {
        id: 'new-id',
        name: 'New name',
        version: 1,
        nodes: [],
        edges: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      'billing/charge', // currently holds id 'charge'
    );
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('overwriting') && String(msg).includes('"charge"'))).toBe(true);
    warn.mockRestore();
  });
});

describe('ApiStore.resolveAuth', () => {
  it('inherits an api-level _meta policy, op overrides win', () => {
    mkdirSync(join(root, 'svc'), { recursive: true });
    writeFileSync(join(root, 'svc', '_meta.json'), JSON.stringify({ auth: { scheme: 'bearer', secretRef: 'T' } }));
    writeFileSync(
      join(root, 'svc', 'pub.json'),
      JSON.stringify({
        id: 'pub-op-id',
        name: 'Public op',
        version: 1,
        nodes: [],
        edges: [],
        http: { method: 'GET', path: '/pub', auth: 'none' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    );
    writeFileSync(
      join(root, 'svc', 'sec.json'),
      JSON.stringify({
        id: 'sec-op-id',
        name: 'Secure op',
        version: 1,
        nodes: [],
        edges: [],
        http: { method: 'GET', path: '/sec' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    );
    const store = new ApiStore(root);
    expect(store.resolveAuth('sec-op-id')).toEqual({ scheme: 'bearer', secretRef: 'T' });
    expect(store.resolveAuth('pub-op-id')).toBeNull();
  });

  it('_meta.json is not listed as an operation', () => {
    writeFileSync(join(root, '_meta.json'), JSON.stringify({ auth: { scheme: 'apiKey', secretRef: 'K' } }));
    expect(new ApiStore(root).list().some((o) => (o.id as string) === '_meta')).toBe(false);
  });

  it('fails closed (throws) when a present _meta.json in the chain is unparseable, instead of silently resolving to public', () => {
    mkdirSync(join(root, 'svc'), { recursive: true });
    // Corrupt JSON — e.g. a partial write or a typo.
    writeFileSync(join(root, 'svc', '_meta.json'), '{ "auth": { "scheme": "bearer", ');
    writeFileSync(
      join(root, 'svc', 'op.json'),
      JSON.stringify({
        id: 'broken-meta-op',
        name: 'Broken meta op',
        version: 1,
        nodes: [],
        edges: [],
        http: { method: 'GET', path: '/svc-op' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    );
    const store = new ApiStore(root);
    expect(() => store.resolveAuth('broken-meta-op')).toThrow(/unparseable/i);
  });
});
