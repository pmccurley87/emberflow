import { describe, expect, it } from 'vitest';
import { parseFlow, serializeFlow } from './persistence';
import { createLoginFlow } from '../flows/login-flow';

describe('flow persistence', () => {
  it('round-trips a flow through JSON', () => {
    const flow = createLoginFlow();
    expect(parseFlow(serializeFlow(flow))).toEqual(flow);
  });

  it('rejects garbage', () => {
    expect(() => parseFlow('{"nope": true}')).toThrow('Invalid flow JSON');
    expect(() => parseFlow('not json')).toThrow();
  });
});
