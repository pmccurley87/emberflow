import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './index';
import { isHttpError } from '../engine';

describe('requireAuth node', () => {
  it('is registered with type requireAuth', () => {
    expect(createDefaultRegistry().get('requireAuth').definition.type).toBe('requireAuth');
  });

  it('returns { user } for a valid bearer token', async () => {
    const impl = createDefaultRegistry().get('requireAuth').implementation;
    const ctx = {
      input: { headers: { authorization: 'Bearer good' } },
      config: { scheme: 'bearer', secretRef: 'T' },
      secrets: { T: 'good' },
      vars: {},
      safeMode: false,
      runInput: {},
      log: () => {},
    } as never;
    expect(await impl(ctx)).toEqual({ user: { scheme: 'bearer' } });
  });

  it('throws HttpError 401 for a missing/wrong token', async () => {
    const impl = createDefaultRegistry().get('requireAuth').implementation;
    const ctx = {
      input: { headers: {} },
      config: { scheme: 'bearer', secretRef: 'T' },
      secrets: { T: 'good' },
      vars: {},
      safeMode: false,
      runInput: {},
      log: () => {},
    } as never;
    try {
      await impl(ctx);
      expect.unreachable();
    } catch (e) {
      expect(isHttpError(e) && e.status).toBe(401);
    }
  });

  it('throws HttpError 500 when the secret is unset (fail closed)', async () => {
    const impl = createDefaultRegistry().get('requireAuth').implementation;
    const ctx = {
      input: { headers: { authorization: 'Bearer x' } },
      config: { scheme: 'bearer', secretRef: 'T' },
      secrets: {},
      vars: {},
      safeMode: false,
      runInput: {},
      log: () => {},
    } as never;
    try {
      await impl(ctx);
      expect.unreachable();
    } catch (e) {
      expect(isHttpError(e) && e.status).toBe(500);
    }
  });

  it('supports the apiKey scheme with a custom header', async () => {
    const impl = createDefaultRegistry().get('requireAuth').implementation;
    const ctx = {
      input: { headers: { 'x-svc-key': 'k' } },
      config: { scheme: 'apiKey', secretRef: 'K', header: 'x-svc-key' },
      secrets: { K: 'k' },
      vars: {},
      safeMode: false,
      runInput: {},
      log: () => {},
    } as never;
    expect(await impl(ctx)).toEqual({ user: { scheme: 'apiKey' } });
  });
});
