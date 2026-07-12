import { describe, expect, it } from 'vitest';
import { isMountablePath } from './pathGuard';

describe('isMountablePath', () => {
  it('rejects bare root, empty, missing, no-leading-slash, and double-slash paths', () => {
    expect(isMountablePath('/')).toBe(false);
    expect(isMountablePath('')).toBe(false);
    expect(isMountablePath(undefined)).toBe(false);
    expect(isMountablePath(null)).toBe(false);
    expect(isMountablePath('no-leading-slash')).toBe(false);
    expect(isMountablePath('//x')).toBe(false);
  });

  it('accepts real sub-paths', () => {
    expect(isMountablePath('/things')).toBe(true);
    expect(isMountablePath('/a/b')).toBe(true);
    expect(isMountablePath('/things/:id')).toBe(true);
  });
});
