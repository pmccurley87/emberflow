import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './index';

describe('Response node', () => {
  it('is registered with type Response', () => {
    expect(createDefaultRegistry().get('Response').definition.type).toBe('Response');
  });

  it('passes { status, body } through, defaulting status to 200', async () => {
    const impl = createDefaultRegistry().get('Response').implementation;
    const ctx = {
      input: { body: { ok: true } },
      config: {},
      secrets: {},
      vars: {},
      safeMode: false,
      runInput: {},
      log: () => {},
    } as never;
    expect(await impl(ctx)).toEqual({ status: 200, body: { ok: true } });

    const ctx2 = {
      input: { status: 201, body: { id: 1 } },
      config: {},
      secrets: {},
      vars: {},
      safeMode: false,
      runInput: {},
      log: () => {},
    } as never;
    expect(await impl(ctx2)).toEqual({ status: 201, body: { id: 1 } });
  });
});
