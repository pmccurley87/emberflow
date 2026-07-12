import { describe, expect, it } from 'vitest';
import { HttpError, isHttpError } from './httpError';

describe('HttpError', () => {
  it('carries status and body', () => {
    const e = new HttpError(404, { error: 'gone' });
    expect(e.status).toBe(404);
    expect(e.body).toEqual({ error: 'gone' });
    expect(isHttpError(e)).toBe(true);
    expect(isHttpError(new Error('x'))).toBe(false);
  });
});
