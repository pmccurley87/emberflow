import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAgents, probe } from './detect';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(__dirname, '__fixtures__', name);

describe('detectAgents', () => {
  it('returns only the CLIs the injected probe reports as present, with parsed versions', () => {
    expect(detectAgents((bin) => (bin === 'codex' ? { version: '0.142.5' } : undefined))).toEqual([
      { kind: 'codex', version: '0.142.5' },
    ]);
    expect(detectAgents((bin) => (bin === 'claude' ? { version: '1.2.3' } : undefined))).toEqual([
      { kind: 'claude', version: '1.2.3' },
    ]);
  });

  it('returns both when both are present', () => {
    expect(detectAgents(() => ({ version: '1.0.0' }))).toEqual([
      { kind: 'codex', version: '1.0.0' },
      { kind: 'claude', version: '1.0.0' },
    ]);
  });

  it('returns [] when neither is present', () => {
    expect(detectAgents(() => undefined)).toEqual([]);
  });

  it('reports null version when present but the output has no parseable semver token', () => {
    expect(detectAgents((bin) => (bin === 'codex' ? { version: null } : undefined))).toEqual([
      { kind: 'codex', version: null },
    ]);
  });

  it('defaults to a real PATH probe that returns an array', () => {
    expect(Array.isArray(detectAgents())).toBe(true);
  });
});

describe('probe (real spawnSync path)', () => {
  it('parses the first semver-ish token out of well-formed --version output', () => {
    expect(probe(fixture('fake-version-good.mjs'))).toEqual({ version: '0.142.5' });
  });

  it('returns a null version when the output is garbage with no semver token', () => {
    expect(probe(fixture('fake-version-garbage.mjs'))).toEqual({ version: null });
  });

  it('returns a null version when the output is empty', () => {
    expect(probe(fixture('fake-version-empty.mjs'))).toEqual({ version: null });
  });

  it('returns undefined when the binary does not exist', () => {
    expect(probe('/nonexistent/nope-agent-cli')).toBeUndefined();
  });

  it('returns undefined when the binary exits nonzero', () => {
    expect(probe(fixture('fake-version-fail.mjs'))).toBeUndefined();
  });

  it('returns undefined when the binary hangs past the timeout', () => {
    expect(probe(fixture('fake-version-hang.mjs'))).toBeUndefined();
  }, 10000);
});
