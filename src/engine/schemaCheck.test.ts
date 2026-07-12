import { describe, expect, it } from 'vitest';
import { validateAgainstSchema } from './schemaCheck';

describe('validateAgainstSchema', () => {
  it('passes when no schema', () => {
    expect(validateAgainstSchema(undefined, { a: 1 })).toBeNull();
  });
  it('flags a missing required field', () => {
    const s = { type: 'object', required: ['name'] };
    expect(validateAgainstSchema(s, {})).toMatch(/name/);
    expect(validateAgainstSchema(s, { name: 'x' })).toBeNull();
  });
  it('flags a wrong property type', () => {
    const s = { type: 'object', properties: { age: { type: 'number' } } };
    expect(validateAgainstSchema(s, { age: 'not a number' })).toMatch(/age/);
    expect(validateAgainstSchema(s, { age: 5 })).toBeNull();
  });
  it('requires an object at the top when type is object', () => {
    expect(validateAgainstSchema({ type: 'object' }, 'nope')).toMatch(/object/);
  });
});
