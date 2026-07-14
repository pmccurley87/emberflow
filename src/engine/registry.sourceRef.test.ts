import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { NodeRegistry } from './registry';

// realpath: tmpdir() on macOS returns a /var/folders symlink; module loaders
// report the resolved /private/var path, so compare against the real path.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'registry-sourceref-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('NodeRegistry sourceRef capture', () => {
  it('does not capture by default (browser registries never pay)', () => {
    const r = new NodeRegistry();
    r.register({ type: 'A', label: 'A' }, async () => ({}));
    expect(r.getSourceRef('A')).toBeUndefined();
  });

  it('explicit opts.sourceRef wins over automatic capture', () => {
    const r = new NodeRegistry({ captureSourceRefs: true });
    r.register({ type: 'B', label: 'B' }, async () => ({}), {
      sourceRef: { file: '/x/custom.ts', line: 7 },
    });
    expect(r.getSourceRef('B')).toEqual({ file: '/x/custom.ts', line: 7 });
  });

  it('explicit opts.sourceRef is stored even when capture is off', () => {
    const r = new NodeRegistry();
    r.register({ type: 'B2', label: 'B2' }, async () => ({}), {
      sourceRef: { file: '/x/other.mjs', line: 2 },
    });
    expect(r.getSourceRef('B2')).toEqual({ file: '/x/other.mjs', line: 2 });
  });

  it('captures the exact caller file and line from an imported .mjs module (real loader)', () => {
    // Runs under a child tsx process: vitest's vite-node transform wraps
    // dynamically imported modules and shifts line numbers, so in-process
    // assertions would test the transform, not the capture. tsx/node load
    // a plain .mjs verbatim — that is what production does.
    const fixture = join(tmp, 'nodes.mjs');
    writeFileSync(
      fixture,
      [
        '// fixture module that registers a node — the register() call is on line 3',
        'export function registerFixtureNodes(registry) {',
        '  registry.register({ type: "FixtureNode", label: "Fixture" }, async () => ({ ok: true }));',
        '}',
        '',
      ].join('\n'),
    );
    const registryPath = fileURLToPath(new URL('./registry.ts', import.meta.url));
    const driver = join(tmp, 'driver.mjs');
    writeFileSync(
      driver,
      [
        `import { NodeRegistry } from ${JSON.stringify(pathToFileURL(registryPath).href)};`,
        `import { registerFixtureNodes } from ${JSON.stringify(pathToFileURL(fixture).href)};`,
        'const r = new NodeRegistry({ captureSourceRefs: true });',
        'registerFixtureNodes(r);',
        "console.log(JSON.stringify(r.getSourceRef('FixtureNode') ?? null));",
        '',
      ].join('\n'),
    );
    const out = execFileSync('npx', ['tsx', driver], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 30_000,
    });
    const ref = JSON.parse(out.trim().split('\n').pop()!) as { file: string; line?: number } | null;
    expect(ref).not.toBeNull();
    expect(ref!.file).toBe(fixture);
    expect(ref!.line).toBe(3);
  }, 40_000);

  it('captures a plain path (no file:// prefix, no query string) from TS caller frames', () => {
    const r = new NodeRegistry({ captureSourceRefs: true });
    r.register({ type: 'C', label: 'C' }, async () => ({}));
    const ref = r.getSourceRef('C');
    expect(ref).toBeDefined();
    expect(ref!.file).toContain('registry.sourceRef.test');
    expect(ref!.file.startsWith('file://')).toBe(false);
    expect(ref!.file).not.toContain('?');
    expect(typeof ref!.line).toBe('number');
  });

  it('restores Error.prepareStackTrace after capture', () => {
    const sentinel = (): string => 'sentinel';
    const original = Error.prepareStackTrace;
    Error.prepareStackTrace = sentinel as unknown as typeof Error.prepareStackTrace;
    try {
      const r = new NodeRegistry({ captureSourceRefs: true });
      r.register({ type: 'D', label: 'D' }, async () => ({}));
      expect(Error.prepareStackTrace).toBe(sentinel);
    } finally {
      Error.prepareStackTrace = original;
    }
  });

  it('adopt() and withSameNodes() carry sourceRefs', () => {
    const a = new NodeRegistry({ captureSourceRefs: true });
    a.register({ type: 'E', label: 'E' }, async () => ({}), {
      sourceRef: { file: '/p/e.mjs', line: 1 },
    });
    const shared = a.withSameNodes();
    expect(shared.getSourceRef('E')).toEqual({ file: '/p/e.mjs', line: 1 });
    const b = new NodeRegistry();
    b.adopt(a);
    expect(b.getSourceRef('E')).toEqual({ file: '/p/e.mjs', line: 1 });
  });
});
