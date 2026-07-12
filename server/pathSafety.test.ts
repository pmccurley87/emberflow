import { describe, expect, it } from 'vitest';
import { isPathWithin } from './pathSafety';

describe('isPathWithin', () => {
  const base = '/project/apis';

  it('allows simple nested relative paths', () => {
    expect(isPathWithin(base, 'svc/thing')).toBe(true);
    expect(isPathWithin(base, 'a/b/c')).toBe(true);
    expect(isPathWithin(base, 'billing/charge')).toBe(true);
  });

  it('rejects parent traversal', () => {
    expect(isPathWithin(base, '../x')).toBe(false);
    expect(isPathWithin(base, 'a/../../b')).toBe(false);
    expect(isPathWithin(base, 'a/../b')).toBe(false);
  });

  it('rejects absolute paths', () => {
    expect(isPathWithin(base, '/etc/x')).toBe(false);
  });

  it('rejects empty strings and empty segments', () => {
    expect(isPathWithin(base, '')).toBe(false);
    expect(isPathWithin(base, 'a//b')).toBe(false);
  });

  it('rejects backslash segments (Windows separator smuggling a traversal)', () => {
    expect(isPathWithin(base, 'a\\..\\b')).toBe(false);
    expect(isPathWithin(base, 'a\\b')).toBe(false);
  });

  it('rejects a bare "." or ".." segment', () => {
    expect(isPathWithin(base, '.')).toBe(false);
    expect(isPathWithin(base, '..')).toBe(false);
    expect(isPathWithin(base, 'a/.')).toBe(false);
  });
});
