import { describe, expect, it } from 'vitest';
import { enforceAuth } from './enforce';
import { createDefaultVerifierRegistry } from './verifiers';
import { isHttpError } from '../../src/engine';

const verifiers = createDefaultVerifierRegistry();

describe('enforceAuth', () => {
  it('passes with a valid bearer token and returns user', () => {
    const r = enforceAuth({
      policy: { scheme: 'bearer', secretRef: 'T' },
      request: { headers: { authorization: 'Bearer t' } },
      secrets: { T: 't' },
      verifiers,
    });
    expect(r.user).toEqual({ scheme: 'bearer' });
  });

  it('401s on a bad token', () => {
    try {
      enforceAuth({
        policy: { scheme: 'bearer', secretRef: 'T' },
        request: { headers: {} },
        secrets: { T: 't' },
        verifiers,
      });
      expect.unreachable();
    } catch (e) {
      expect(isHttpError(e) && e.status).toBe(401);
    }
  });

  it('500s when the named verifier is missing (fail closed)', () => {
    try {
      enforceAuth({
        policy: { scheme: 'bearer', secretRef: 'T', verify: 'ghost' },
        request: { headers: {} },
        secrets: { T: 't' },
        verifiers,
      });
      expect.unreachable();
    } catch (e) {
      expect(isHttpError(e) && e.status).toBe(500);
      expect(isHttpError(e) && (e.body as { error?: string })?.error).toBe('auth misconfigured: no verifier ghost');
    }
  });

  it('500s when the secret is unresolved (fail closed)', () => {
    try {
      enforceAuth({
        policy: { scheme: 'bearer', secretRef: 'MISSING' },
        request: { headers: { authorization: 'Bearer t' } },
        secrets: {},
        verifiers,
      });
      expect.unreachable();
    } catch (e) {
      expect(isHttpError(e) && e.status).toBe(500);
    }
  });
});
