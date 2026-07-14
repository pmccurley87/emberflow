import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSourceFile, resetSourceNavCaches, type SourceFilePayload } from './sourceNav';
import { buildRegistries } from './projectMode';
import { nodesPayload } from './nodesPayload';
import type { NodeRegistry } from '../src/engine';

let root: string;

function write(rel: string, lines: string[]): void {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, lines.join('\n') + '\n');
}

async function payloadOf(rel: string): Promise<SourceFilePayload> {
  const result = await getSourceFile(root, rel);
  if (!result.ok) throw new Error(`expected ok for ${rel}, got ${result.status}: ${result.error}`);
  return result.payload;
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sourcenav-')));
  resetSourceNavCaches();

  write('nodes.mjs', [
    "import { deriveTrackingActual } from './shipment-logic.mjs';", // 1
    "import { createHash } from 'node:crypto';", // 2
    "import express from 'express';", // 3
    "import { helper } from '@scope/pkg/utils';", // 4
    '', // 5
    'const TAX_RATE = 0.2;', // 6
    '', // 7
    'export function handler(input) {', // 8
    "  void createHash('sha256');", // 9
    '  void express;', // 10
    '  void helper;', // 11
    '  return deriveTrackingActual(input) * TAX_RATE;', // 12
    '}', // 13
    '', // 14
    'export async function loadPlugin(name) {', // 15
    '  return await import(name);', // 16
    '}', // 17
  ]);

  write('shipment-logic.mjs', [
    'function nestedHelper(shipment) {', // 1
    '  return shipment.weight * 2;', // 2
    '}', // 3
    '', // 4
    'export function deriveTrackingActual(shipment) {', // 5
    '  return nestedHelper(shipment);', // 6
    '}', // 7
  ]);

  write('index.mjs', [
    "export { deriveTrackingActual } from './shipment-logic.mjs';", // 1
    "export * from './extras.mjs';", // 2
  ]);
  write('extras.mjs', ['export const EXTRA = 1;']);

  write('via-index.mjs', [
    "import { deriveTrackingActual } from './index.mjs';", // 1
    '', // 2
    'export function viaIndex(x) {', // 3
    '  return deriveTrackingActual(x);', // 4
    '}', // 5
  ]);

  // Mutual value-import cycle.
  write('circ-a.mjs', [
    "import { b } from './circ-b.mjs';",
    'export function a() {',
    '  return b();',
    '}',
  ]);
  write('circ-b.mjs', [
    "import { a } from './circ-a.mjs';",
    'export function b() {',
    '  return a();',
    '}',
  ]);

  // Re-export cycle: chasing the declaration must terminate.
  write('reexp-a.mjs', ["export { spin } from './reexp-b.mjs';"]);
  write('reexp-b.mjs', ["export { spin } from './reexp-a.mjs';"]);
  write('spin-consumer.mjs', [
    "import { spin } from './reexp-a.mjs';",
    'export const useSpin = spin;',
  ]);

  // TS variant with type annotations + TS-style .js specifier for a .ts file.
  write('ts/handler.ts', [
    "import { deriveTs } from './logic.js';", // 1
    '', // 2
    'export function tsHandler(n: number): number {', // 3
    '  return deriveTs(n);', // 4
    '}', // 5
  ]);
  write('ts/logic.ts', [
    'export function deriveTs(n: number): number {', // 1
    '  return n * 2;', // 2
    '}', // 3
  ]);

  // tsconfig paths alias (JSONC — comments must parse leniently).
  write('tsconfig.json', [
    '{',
    '  // single-star paths alias, exercised by aliased.ts',
    '  "compilerOptions": {',
    '    "paths": { "@lib/*": ["lib/*"] }',
    '  }',
    '}',
  ]);
  write('lib/util.ts', ['export function util(): number {', '  return 1;', '}']);
  write('aliased.ts', ["import { util } from '@lib/util';", '', 'export const z = util();']);

  // Secrets / denied files that must never be served.
  write('.env', ['SECRET=shh']);
  mkdirSync(join(root, 'sub'), { recursive: true });
  write('sub/.env.local', ['SECRET=shh']);
  write('server.key', ['---KEY---']);
  write('cert.pem', ['---PEM---']);
  write('emberflow.secrets.json', ['{}']);
  mkdirSync(join(root, 'node_modules', 'somepkg'), { recursive: true });
  write('node_modules/somepkg/index.js', ['module.exports = 1;']);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('getSourceFile: parse + declarations', () => {
  it('serves the whole file with language and repo-relative path', async () => {
    const p = await payloadOf('nodes.mjs');
    expect(p.path).toBe('nodes.mjs');
    expect(p.language).toBe('js');
    expect(p.content).toContain('TAX_RATE');
    expect(p.resolver).toBeUndefined();
  });

  it('extracts top-level declarations with kind, lines, and exported flag', async () => {
    const p = await payloadOf('shipment-logic.mjs');
    const decls = p.symbols.declarations;
    const nested = decls.find((d) => d.name === 'nestedHelper');
    expect(nested).toMatchObject({ kind: 'fn', line: 1, endLine: 3, exported: false });
    const derive = decls.find((d) => d.name === 'deriveTrackingActual');
    expect(derive).toMatchObject({ kind: 'fn', line: 5, endLine: 7, exported: true });
  });

  it('extracts a local const with an initializer', async () => {
    const p = await payloadOf('nodes.mjs');
    const tax = p.symbols.declarations.find((d) => d.name === 'TAX_RATE');
    expect(tax).toMatchObject({ kind: 'const', line: 6, exported: false });
  });
});

describe('getSourceFile: import resolution', () => {
  it('resolves a relative sibling import to a project file with the declaration line', async () => {
    const p = await payloadOf('nodes.mjs');
    const imp = p.symbols.imports.find((i) => i.local === 'deriveTrackingActual');
    expect(imp).toBeDefined();
    expect(imp!.from).toBe('./shipment-logic.mjs');
    expect(imp!.resolution).toEqual({ kind: 'project', path: 'shipment-logic.mjs', line: 5 });
  });

  it('classifies node:crypto as builtin', async () => {
    const p = await payloadOf('nodes.mjs');
    const imp = p.symbols.imports.find((i) => i.local === 'createHash');
    expect(imp!.resolution).toEqual({ kind: 'builtin' });
  });

  it('classifies a bare specifier as external with the package name', async () => {
    const p = await payloadOf('nodes.mjs');
    const imp = p.symbols.imports.find((i) => i.local === 'express');
    expect(imp!.name).toBe('default');
    expect(imp!.resolution).toEqual({ kind: 'external', package: 'express' });
  });

  it('extracts the scoped package name from a deep specifier', async () => {
    const p = await payloadOf('nodes.mjs');
    const imp = p.symbols.imports.find((i) => i.local === 'helper');
    expect(imp!.resolution).toEqual({ kind: 'external', package: '@scope/pkg' });
  });

  it('reports a computed dynamic import as unresolved with a reason', async () => {
    const p = await payloadOf('nodes.mjs');
    const dyn = p.symbols.imports.find((i) => i.resolution.kind === 'unresolved');
    expect(dyn).toBeDefined();
    expect((dyn!.resolution as { reason: string }).reason).toMatch(/dynamic/i);
  });

  it('follows a re-export chain through an index module to the declaring file', async () => {
    const p = await payloadOf('via-index.mjs');
    const imp = p.symbols.imports.find((i) => i.local === 'deriveTrackingActual');
    expect(imp!.from).toBe('./index.mjs');
    expect(imp!.resolution).toEqual({ kind: 'project', path: 'shipment-logic.mjs', line: 5 });
  });

  it('handles a circular import pair without looping', async () => {
    const p = await payloadOf('circ-a.mjs');
    const imp = p.symbols.imports.find((i) => i.local === 'b');
    expect(imp!.resolution).toMatchObject({ kind: 'project', path: 'circ-b.mjs' });
  });

  it('terminates on a re-export cycle (depth cap + cycle set)', async () => {
    const p = await payloadOf('spin-consumer.mjs');
    const imp = p.symbols.imports.find((i) => i.local === 'spin');
    expect(imp!.resolution.kind).toBe('project');
  });

  it('maps a TS-style .js specifier to the .ts source (extension ladder)', async () => {
    const p = await payloadOf('ts/handler.ts');
    expect(p.language).toBe('ts');
    const imp = p.symbols.imports.find((i) => i.local === 'deriveTs');
    expect(imp!.resolution).toEqual({ kind: 'project', path: 'ts/logic.ts', line: 1 });
  });

  it('honors single-star tsconfig paths (parsed leniently as JSONC)', async () => {
    const p = await payloadOf('aliased.ts');
    const imp = p.symbols.imports.find((i) => i.local === 'util');
    expect(imp!.resolution).toEqual({ kind: 'project', path: 'lib/util.ts', line: 1 });
  });
});

describe('getSourceFile: re-exports of the served file', () => {
  it('lists named and star re-exports with resolutions', async () => {
    const p = await payloadOf('index.mjs');
    const named = p.symbols.reexports.find((r) => r.name === 'deriveTrackingActual');
    expect(named!.from).toBe('./shipment-logic.mjs');
    expect(named!.resolution).toEqual({ kind: 'project', path: 'shipment-logic.mjs', line: 5 });
    const star = p.symbols.reexports.find((r) => r.name === '*');
    expect(star!.from).toBe('./extras.mjs');
    expect(star!.resolution).toMatchObject({ kind: 'project', path: 'extras.mjs' });
  });
});

describe('getSourceFile: path guards', () => {
  const denied = [
    '../../etc/passwd',
    '/etc/passwd',
    'node_modules/somepkg/index.js',
    '.env',
    'sub/.env.local',
    'server.key',
    'cert.pem',
    'emberflow.secrets.json',
  ];
  for (const rel of denied) {
    it(`denies ${rel} with a generic 400`, async () => {
      const result = await getSourceFile(root, rel);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      // Generic message: never echo the requested path back.
      expect(result.error).not.toContain(rel);
    });
  }

  it('404s for a missing file inside the root', async () => {
    const result = await getSourceFile(root, 'does-not-exist.mjs');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});

describe('getSourceFile: caching', () => {
  it('invalidates the parse cache when the file mtime changes', async () => {
    write('mut.mjs', ['export const FIRST = 1;']);
    utimesSync(join(root, 'mut.mjs'), 1_000, 1_000);
    const before = await payloadOf('mut.mjs');
    expect(before.content).toContain('FIRST');
    expect(before.symbols.declarations.map((d) => d.name)).toContain('FIRST');

    write('mut.mjs', ['export const SECOND = 2;']);
    utimesSync(join(root, 'mut.mjs'), 2_000, 2_000);
    const after = await payloadOf('mut.mjs');
    expect(after.content).toContain('SECOND');
    expect(after.symbols.declarations.map((d) => d.name)).toContain('SECOND');
    expect(after.content).not.toContain('FIRST');
  });
});

describe('getSourceFile: typescript unavailable', () => {
  it('returns resolver: unavailable with content but empty symbols when the ts import fails', async () => {
    const result = await getSourceFile(root, 'nodes.mjs', {
      tsLoader: async () => {
        throw new Error('typescript not installed');
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.resolver).toBe('unavailable');
    expect(result.payload.content).toContain('TAX_RATE');
    expect(result.payload.symbols.declarations).toEqual([]);
    expect(result.payload.symbols.imports).toEqual([]);
  });
});

describe('regression: DeriveShipmentActuals → deriveTrackingActual (thin-adapter consumer shape)', () => {
  let regRoot: string;

  beforeAll(async () => {
    regRoot = realpathSync(mkdtempSync(join(tmpdir(), 'sourcenav-regression-')));
    const w = (rel: string, lines: string[]): void =>
      writeFileSync(join(regRoot, rel), lines.join('\n') + '\n');
    w('shipment-logic.mjs', [
      'function nestedHelper(shipment) {', // 1
      '  return (shipment.weight ?? 0) * 2;', // 2
      '}', // 3
      '', // 4
      'export function deriveTrackingActual(shipment) {', // 5
      '  return nestedHelper(shipment);', // 6
      '}', // 7
    ]);
    w('nodes.mjs', [
      "import { deriveTrackingActual } from './shipment-logic.mjs';", // 1
      '', // 2
      'export function registerNodes(registry) {', // 3
      '  registry.register(', // 4
      "    { type: 'DeriveShipmentActuals', label: 'Derive Shipment Actuals' },", // 5
      '    async (ctx) => ({ actual: deriveTrackingActual(ctx.input) }),', // 6
      '  );', // 7
      '}', // 8
    ]);
  });

  afterAll(() => {
    if (regRoot) rmSync(regRoot, { recursive: true, force: true });
  });

  it('nodesPayload carries the node sourceRef, and /source-file navigates to the helper', async () => {
    const mod = (await import(pathToFileURL(join(regRoot, 'nodes.mjs')).href)) as {
      registerNodes: (r: NodeRegistry) => void;
    };
    const { validation } = buildRegistries({
      root: regRoot,
      flowsDir: join(regRoot, 'emberflow', 'flows'),
      language: 'javascript',
      registerNodes: mod.registerNodes,
    });

    // 1. The registration was captured and lands in the payload repo-relative.
    // (Exact line accuracy under the production loader is asserted by
    // registry.sourceRef.test.ts and sourceNavRoute.test.ts — vitest's
    // vite-node transform shifts lines of in-process dynamic imports.)
    const payload = nodesPayload(validation, regRoot);
    const node = payload.nodes.find((n) => n.type === 'DeriveShipmentActuals');
    expect(node).toBeDefined();
    expect(node!.sourceRef!.file).toBe('nodes.mjs');
    expect(typeof node!.sourceRef!.line).toBe('number');
    expect(node!.builtin).toBeUndefined();

    // Built-ins registered from the Emberflow package are outside regRoot.
    const builtinNode = payload.nodes.find((n) => n.type === 'ValidateCredentials');
    expect(builtinNode).toBeDefined();
    expect(builtinNode!.builtin).toBe(true);
    expect(builtinNode!.sourceRef).toBeUndefined();

    // 2. /source-file on the handler module resolves the imported helper.
    const handlerFile = await getSourceFile(regRoot, 'nodes.mjs');
    expect(handlerFile.ok).toBe(true);
    if (!handlerFile.ok) return;
    const imp = handlerFile.payload.symbols.imports.find((i) => i.local === 'deriveTrackingActual');
    expect(imp!.resolution).toEqual({ kind: 'project', path: 'shipment-logic.mjs', line: 5 });

    // 3. /source-file on the helper module exposes its declaration lines.
    const logicFile = await getSourceFile(regRoot, 'shipment-logic.mjs');
    expect(logicFile.ok).toBe(true);
    if (!logicFile.ok) return;
    const derive = logicFile.payload.symbols.declarations.find(
      (d) => d.name === 'deriveTrackingActual',
    );
    expect(derive).toMatchObject({ kind: 'fn', line: 5, endLine: 7, exported: true });
    const nested = logicFile.payload.symbols.declarations.find((d) => d.name === 'nestedHelper');
    expect(nested).toMatchObject({ kind: 'fn', line: 1, exported: false });
  });
});
