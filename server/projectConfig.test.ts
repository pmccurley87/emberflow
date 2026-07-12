import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProjectConfig } from './projectConfig';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ef-proj-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('loadProjectConfig', () => {
  it('returns null when no config file exists', async () => {
    expect(await loadProjectConfig(scratch())).toBeNull();
  });

  it('loads emberflow.config.mjs, resolving flowsDir against the config dir', async () => {
    const d = scratch();
    mkdirSync(join(d, 'my-flows'));
    writeFileSync(
      join(d, 'emberflow.config.mjs'),
      `export default { flowsDir: 'my-flows', registerNodes: (r) => { r.register({ type: 'X', label: 'X' }, async () => ({})); } };\n`,
    );
    const cfg = await loadProjectConfig(d);
    expect(cfg).not.toBeNull();
    expect(cfg!.root).toBe(d);
    expect(cfg!.flowsDir).toBe(join(d, 'my-flows'));
    expect(typeof cfg!.registerNodes).toBe('function');
  });

  it('defaults flowsDir to <root>/emberflow/flows and creates nothing', async () => {
    const d = scratch();
    writeFileSync(join(d, 'emberflow.config.mjs'), `export default {};\n`);
    const cfg = await loadProjectConfig(d);
    expect(cfg!.flowsDir).toBe(join(d, 'emberflow', 'flows'));
  });

  it('throws a readable error for an unparseable config', async () => {
    const d = scratch();
    writeFileSync(join(d, 'emberflow.config.mjs'), `export default {;\n`);
    await expect(loadProjectConfig(d)).rejects.toThrow(/emberflow\.config/);
  });

  it('infers language "javascript" from a .mjs config when unset', async () => {
    const d = scratch();
    writeFileSync(join(d, 'emberflow.config.mjs'), `export default {};\n`);
    const cfg = await loadProjectConfig(d);
    expect(cfg!.language).toBe('javascript');
  });

  it('infers language "typescript" from a .ts config when unset', async () => {
    const d = scratch();
    writeFileSync(join(d, 'emberflow.config.ts'), `export default {};\n`);
    const cfg = await loadProjectConfig(d);
    expect(cfg!.language).toBe('typescript');
  });

  it('explicit language field wins over extension inference', async () => {
    const d = scratch();
    writeFileSync(join(d, 'emberflow.config.mjs'), `export default { language: 'typescript' };\n`);
    const cfg = await loadProjectConfig(d);
    expect(cfg!.language).toBe('typescript');
  });
});
