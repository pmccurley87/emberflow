import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('redacts a secret embedded inside a longer string', () => {
    const payload = { line: 'cookie: session=SECRETVAL; Path=/' };
    const result = redactSecrets(payload, { sessionCookie: 'SECRETVAL' });
    expect(result).toEqual({ line: 'cookie: session=«secret:sessionCookie»; Path=/' });
  });

  it('redacts the URL-encoded form of a secret', () => {
    const value = 'a b+c/d';
    const encoded = encodeURIComponent(value);
    const payload = { url: `https://x/y?token=${encoded}` };
    const result = redactSecrets(payload, { apiToken: value });
    expect(result).toEqual({ url: `https://x/y?token=«secret:apiToken»` });
  });

  it('redacts within nested objects and arrays', () => {
    const payload = {
      a: { b: ['prefix SECRETVAL suffix', { c: 'SECRETVAL again' }] },
    };
    const result = redactSecrets(payload, { key: 'SECRETVAL' });
    expect(result).toEqual({
      a: { b: ['prefix «secret:key» suffix', { c: '«secret:key» again' }] },
    });
  });

  it('redacts multiple secrets in one payload', () => {
    const payload = { line: 'user=USERSECRET pass=PASSSECRET' };
    const result = redactSecrets(payload, { user: 'USERSECRET', pass: 'PASSSECRET' });
    expect(result).toEqual({ line: 'user=«secret:user» pass=«secret:pass»' });
  });

  it('redacts multiple occurrences of one secret', () => {
    const payload = { line: 'SECRETVAL and SECRETVAL again' };
    const result = redactSecrets(payload, { key: 'SECRETVAL' });
    expect(result).toEqual({ line: '«secret:key» and «secret:key» again' });
  });

  it('prefers the longer matching secret over one whose value is its substring', () => {
    const payload = { line: 'value=XABCDEFY end' };
    const result = redactSecrets(payload, { short: 'ABCDEF', long: 'XABCDEFY' });
    expect(result).toEqual({ line: 'value=«secret:long» end' });
  });

  it('does not redact values shorter than 6 characters', () => {
    const payload = { line: 'short=abcde end' };
    const result = redactSecrets(payload, { short: 'abcde' });
    expect(result).toEqual({ line: 'short=abcde end' });
  });

  it('leaves a payload with no strings unchanged', () => {
    const payload = { n: 42, b: true, nil: null, list: [1, 2, 3] };
    const result = redactSecrets(payload, { key: 'SECRETVAL' });
    expect(result).toEqual(payload);
  });

  it('is the identity function when the secrets map is empty', () => {
    const payload = { line: 'SECRETVAL stays', nested: { x: 'SECRETVAL' } };
    const result = redactSecrets(payload, {});
    expect(result).toEqual(payload);
  });

  it('does not mutate the input object', () => {
    const payload = { line: 'SECRETVAL here', nested: { x: 'SECRETVAL' } };
    const clone = JSON.parse(JSON.stringify(payload));
    redactSecrets(payload, { key: 'SECRETVAL' });
    expect(payload).toEqual(clone);
  });

  it('redacts the base64 form of a secret', () => {
    const value = 'supersecret123';
    const encoded = Buffer.from(value).toString('base64');
    const payload = { line: `token=${encoded}` };
    const result = redactSecrets(payload, { key: value });
    expect(result).toEqual({ line: 'token=«secret:key»' });
  });

  it('redacts raw, url-encoded, and base64 forms of a secret in one payload', () => {
    const value = 'a b+c/d';
    const encoded = encodeURIComponent(value);
    const b64 = Buffer.from(value).toString('base64');
    const payload = { line: `raw=${value} enc=${encoded} b64=${b64}` };
    const result = redactSecrets(payload, { key: value });
    expect(result).toEqual({ line: 'raw=«secret:key» enc=«secret:key» b64=«secret:key»' });
  });
});
