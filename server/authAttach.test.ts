import { describe, expect, it } from 'vitest';
import { attachCredential, captureCredential } from './authAttach';
import type { EnvAuth } from './environments';

describe('attachCredential', () => {
  it('sets a cookie on empty headers', () => {
    const attach: EnvAuth['attach'] = { as: 'cookie', name: 'session', secretRef: 'S' };
    const result = attachCredential({}, attach, 'abc');
    expect(result).toEqual({ cookie: 'session=abc' });
  });

  it('appends a cookie to an existing Cookie header', () => {
    const attach: EnvAuth['attach'] = { as: 'cookie', name: 'session', secretRef: 'S' };
    const result = attachCredential({ cookie: 'x=1' }, attach, 'abc');
    expect(result).toEqual({ cookie: 'x=1; session=abc' });
  });

  it('sets a header', () => {
    const attach: EnvAuth['attach'] = { as: 'header', name: 'Authorization', secretRef: 'S' };
    const result = attachCredential({}, attach, 'Bearer abc');
    expect(result).toEqual({ authorization: 'Bearer abc' });
  });

  it('returns headers unchanged when the target header is already present', () => {
    const attach: EnvAuth['attach'] = { as: 'header', name: 'Authorization', secretRef: 'S' };
    const headers = { authorization: 'Bearer explicit' };
    const result = attachCredential(headers, attach, 'Bearer abc');
    expect(result).toBe(headers);
    expect(result).toEqual({ authorization: 'Bearer explicit' });
  });

  it('returns headers unchanged when the target header is already present under different casing', () => {
    const attach: EnvAuth['attach'] = { as: 'header', name: 'Authorization', secretRef: 'x' };
    const headers = { Authorization: 'Bearer caller' };
    const result = attachCredential(headers, attach, 'injected');
    expect(result).toBe(headers);
    expect(result).toEqual({ Authorization: 'Bearer caller' });
    expect(Object.prototype.hasOwnProperty.call(result, 'authorization')).toBe(false);
  });

  it('returns headers unchanged when the target cookie name is already present', () => {
    const attach: EnvAuth['attach'] = { as: 'cookie', name: 'session', secretRef: 'S' };
    const headers = { cookie: 'session=explicit' };
    const result = attachCredential(headers, attach, 'abc');
    expect(result).toBe(headers);
    expect(result).toEqual({ cookie: 'session=explicit' });
  });

  it('returns a new headers object (does not mutate input) when attaching', () => {
    const attach: EnvAuth['attach'] = { as: 'header', name: 'Authorization', secretRef: 'S' };
    const headers = {};
    const result = attachCredential(headers, attach, 'Bearer abc');
    expect(result).not.toBe(headers);
    expect(headers).toEqual({});
  });

  it('prepends the prefix to a header value', () => {
    const attach: EnvAuth['attach'] = { as: 'header', name: 'Authorization', secretRef: 'S', prefix: 'Bearer ' };
    const result = attachCredential({}, attach, 'tok123');
    expect(result).toEqual({ authorization: 'Bearer tok123' });
  });

  it('prepends the prefix to a cookie value', () => {
    const attach: EnvAuth['attach'] = { as: 'cookie', name: 'session', secretRef: 'S', prefix: 'Basic ' };
    const result = attachCredential({}, attach, 'tok123');
    expect(result).toEqual({ cookie: 'session=Basic tok123' });
  });

  it('returns headers unchanged when the target header is already present, even with a prefix configured', () => {
    const attach: EnvAuth['attach'] = { as: 'header', name: 'Authorization', secretRef: 'S', prefix: 'Bearer ' };
    const headers = { authorization: 'Bearer explicit' };
    const result = attachCredential(headers, attach, 'tok123');
    expect(result).toBe(headers);
    expect(result).toEqual({ authorization: 'Bearer explicit' });
  });

  it('behaves identically to no-prefix behavior when prefix is absent', () => {
    const attach: EnvAuth['attach'] = { as: 'header', name: 'Authorization', secretRef: 'S' };
    const result = attachCredential({}, attach, 'tok123');
    expect(result).toEqual({ authorization: 'tok123' });
  });
});

describe('captureCredential', () => {
  function makeRes(headersInit: Record<string, string>, body: unknown): { headers: Headers; json: () => Promise<any> } {
    return {
      headers: new Headers(headersInit),
      json: async () => body,
    };
  }

  it('captures a named cookie value from set-cookie', async () => {
    const res = makeRes({ 'set-cookie': 'session=abc; Path=/; HttpOnly' }, {});
    const capture: NonNullable<EnvAuth['login']>['capture'] = { from: 'set-cookie', cookieName: 'session' };
    const value = await captureCredential(res, capture);
    expect(value).toBe('abc');
  });

  it('captures the whole cookie pair when cookieName is omitted', async () => {
    const res = makeRes({ 'set-cookie': 'session=abc; Path=/; HttpOnly' }, {});
    const capture: NonNullable<EnvAuth['login']>['capture'] = { from: 'set-cookie' };
    const value = await captureCredential(res, capture);
    expect(value).toBe('session=abc');
  });

  it('captures a value from a json dot-path', async () => {
    const res = makeRes({}, { token: 'tok-123' });
    const capture: NonNullable<EnvAuth['login']>['capture'] = { from: 'json', path: 'token' };
    const value = await captureCredential(res, capture);
    expect(value).toBe('tok-123');
  });

  it('captures a value from a nested json dot-path', async () => {
    const res = makeRes({}, { data: { token: 'tok-nested' } });
    const capture: NonNullable<EnvAuth['login']>['capture'] = { from: 'json', path: 'data.token' };
    const value = await captureCredential(res, capture);
    expect(value).toBe('tok-nested');
  });

  it('captures a header value', async () => {
    const res = makeRes({ 'x-auth-token': 'tok-header' }, {});
    const capture: NonNullable<EnvAuth['login']>['capture'] = { from: 'header', name: 'x-auth-token' };
    const value = await captureCredential(res, capture);
    expect(value).toBe('tok-header');
  });

  it('returns null when the set-cookie header is missing', async () => {
    const res = makeRes({}, {});
    const capture: NonNullable<EnvAuth['login']>['capture'] = { from: 'set-cookie', cookieName: 'session' };
    const value = await captureCredential(res, capture);
    expect(value).toBeNull();
  });

  it('selects the named cookie line from multiple getSetCookie() lines', async () => {
    const res = {
      headers: {
        getSetCookie: () => ['other=1; Path=/', 'better-auth.session_token=zzz; HttpOnly', 'trailing=x'],
        get: () => null,
      } as unknown as Headers,
      json: async () => ({}),
    };
    const capture: NonNullable<EnvAuth['login']>['capture'] = {
      from: 'set-cookie',
      cookieName: 'better-auth.session_token',
    };
    const value = await captureCredential(res, capture);
    expect(value).toBe('zzz');
  });

  it('falls back to the single comma-joined get(set-cookie) when getSetCookie is unavailable', async () => {
    const res = {
      headers: {
        get: (name: string) => (name === 'set-cookie' ? 'session=abc; Path=/; HttpOnly' : null),
      } as unknown as Headers,
      json: async () => ({}),
    };
    const capture: NonNullable<EnvAuth['login']>['capture'] = { from: 'set-cookie', cookieName: 'session' };
    const value = await captureCredential(res, capture);
    expect(value).toBe('abc');
  });

  it('returns null when the json path is not found', async () => {
    const res = makeRes({}, { other: 'x' });
    const capture: NonNullable<EnvAuth['login']>['capture'] = { from: 'json', path: 'token' };
    const value = await captureCredential(res, capture);
    expect(value).toBeNull();
  });

  it('returns null when the header is missing', async () => {
    const res = makeRes({}, {});
    const capture: NonNullable<EnvAuth['login']>['capture'] = { from: 'header', name: 'x-auth-token' };
    const value = await captureCredential(res, capture);
    expect(value).toBeNull();
  });
});
