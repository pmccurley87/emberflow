import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadInfrastructure } from './infrastructure';

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'infra-'));
  mkdirSync(join(root, 'emberflow'), { recursive: true });
  return root;
}

function writeManifest(root: string, contents: string): void {
  writeFileSync(join(root, 'emberflow', 'infrastructure.json'), contents);
}

describe('loadInfrastructure', () => {
  let root: string;

  beforeEach(() => {
    root = project();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null (no warning) when the file is absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadInfrastructure(root)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('loads a well-formed manifest, preserving fields', () => {
    writeManifest(
      root,
      JSON.stringify({
        version: 1,
        scannedAt: '2026-07-12T00:00:00Z',
        greenfield: false,
        summary: 'Express app with Postgres (Prisma) and Stripe.',
        items: [
          {
            id: 'postgres-main',
            kind: 'database',
            name: 'Postgres (Prisma)',
            evidence: [{ file: 'prisma/schema.prisma', note: 'datasource db provider=postgresql' }],
            suggestedSecretRefs: ['DATABASE_URL'],
            suggestedVars: [],
            notes: 'Schema defines User, Order, Invoice models.',
          },
        ],
      }),
    );
    const manifest = loadInfrastructure(root);
    expect(manifest).not.toBeNull();
    expect(manifest!.summary).toContain('Postgres');
    expect(manifest!.items).toHaveLength(1);
    expect(manifest!.items[0]).toMatchObject({
      id: 'postgres-main',
      kind: 'database',
      name: 'Postgres (Prisma)',
      suggestedSecretRefs: ['DATABASE_URL'],
    });
    expect(manifest!.items[0].evidence[0]).toEqual({ file: 'prisma/schema.prisma', note: 'datasource db provider=postgresql' });
  });

  it('preserves unknown top-level and item fields (forward compatibility)', () => {
    writeManifest(
      root,
      JSON.stringify({
        version: 2,
        greenfield: false,
        futureTopField: 'keep me',
        items: [{ id: 'x', kind: 'cache', name: 'Redis', futureItemField: 42 }],
      }),
    );
    const manifest = loadInfrastructure(root);
    expect(manifest!.futureTopField).toBe('keep me');
    expect(manifest!.items[0].futureItemField).toBe(42);
    expect(manifest!.version).toBe(2);
  });

  it('clamps an unknown item kind to "other" and defaults missing required fields', () => {
    writeManifest(
      root,
      JSON.stringify({
        greenfield: false,
        items: [{ kind: 'blockchain' }],
      }),
    );
    const manifest = loadInfrastructure(root);
    expect(manifest!.items[0].kind).toBe('other');
    expect(manifest!.items[0].name).toBe('Unnamed');
    expect(manifest!.items[0].id).toBe('item-0');
    expect(manifest!.items[0].evidence).toEqual([]);
    expect(manifest!.items[0].suggestedSecretRefs).toEqual([]);
    // version defaults to 1 when absent.
    expect(manifest!.version).toBe(1);
  });

  it('supports a greenfield manifest with empty items', () => {
    writeManifest(root, JSON.stringify({ version: 1, greenfield: true, summary: 'Empty project.', items: [] }));
    const manifest = loadInfrastructure(root);
    expect(manifest!.greenfield).toBe(true);
    expect(manifest!.items).toEqual([]);
  });

  it('returns null + one warning on invalid JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeManifest(root, '{ not json');
    expect(loadInfrastructure(root)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    // Repeat load: deduped, no second warning.
    expect(loadInfrastructure(root)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('the invalid-JSON warning never echoes the parse error message (no file-content leakage)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A "secret" fragment near the break point — JSON.parse's own error
    // message would normally quote a few characters around here.
    writeManifest(root, '{ "token": "sk_live_super_secret_value丹');
    expect(loadInfrastructure(root)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('is not valid JSON');
    expect(message).not.toContain('sk_live_super_secret_value');
    warn.mockRestore();
  });

  it('returns null + warning when items is not an array', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeManifest(root, JSON.stringify({ version: 1, greenfield: false, items: 'nope' }));
    expect(loadInfrastructure(root)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('drops non-object items but keeps the valid siblings', () => {
    writeManifest(
      root,
      JSON.stringify({
        version: 1,
        greenfield: false,
        items: [null, 'bad', { id: 'ok', kind: 'llm', name: 'OpenAI' }],
      }),
    );
    const manifest = loadInfrastructure(root);
    expect(manifest!.items).toHaveLength(1);
    expect(manifest!.items[0].name).toBe('OpenAI');
  });
});
