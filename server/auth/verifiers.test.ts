import { describe, expect, it } from 'vitest';
import { bearerVerifier, apiKeyVerifier, createDefaultVerifierRegistry } from './verifiers';
import { isHttpError } from '../../src/engine';

const call = (v: () => unknown) => {
  try {
    v();
    return null;
  } catch (e) {
    return e;
  }
};

describe('default verifiers', () => {
  it('bearer accepts a matching token', () => {
    const r = bearerVerifier({ request: { headers: { authorization: 'Bearer s3cret' } }, policy: { scheme: 'bearer', secretRef: 'T' }, secret: 's3cret' });
    expect(r.user).toEqual({ scheme: 'bearer' });
  });
  it('bearer 401s a wrong/missing token', () => {
    const e = call(() => bearerVerifier({ request: { headers: {} }, policy: { scheme: 'bearer', secretRef: 'T' }, secret: 's3cret' }));
    expect(isHttpError(e) && e.status).toBe(401);
  });
  it('bearer 500s when the secret is unset (fail closed)', () => {
    const e = call(() => bearerVerifier({ request: { headers: { authorization: 'Bearer x' } }, policy: { scheme: 'bearer', secretRef: 'T' }, secret: undefined }));
    expect(isHttpError(e) && e.status).toBe(500);
  });
  it('apiKey reads the configured header', () => {
    const r = apiKeyVerifier({ request: { headers: { 'x-api-key': 'k' } }, policy: { scheme: 'apiKey', secretRef: 'K' }, secret: 'k' });
    expect(r.user).toEqual({ scheme: 'apiKey' });
  });
  it('registry seeds bearer + apiKey', () => {
    const reg = createDefaultVerifierRegistry();
    expect(reg.get('bearer')).toBe(bearerVerifier);
    expect(reg.get('apiKey')).toBe(apiKeyVerifier);
    expect(reg.get('nope')).toBeUndefined();
  });
});
