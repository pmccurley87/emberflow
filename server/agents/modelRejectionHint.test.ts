import { describe, expect, it } from 'vitest';
import { modelRejectionHint } from './modelRejectionHint';

describe('modelRejectionHint', () => {
  it('returns undefined for unrelated stderr', () => {
    expect(modelRejectionHint('codex', 'some non-fatal mcp auth error')).toBeUndefined();
  });

  it('returns undefined for empty stderr', () => {
    expect(modelRejectionHint('codex', '')).toBeUndefined();
  });

  it.each([
    'Error: unknown model "gpt-5.6-sol"',
    "Error: unsupported model 'gpt-5.6-sol'",
    'invalid model specified',
    'model gpt-5.6-sol not found',
    'the requested model is not supported',
  ])('matches known model-rejection shapes: %s', (stderr) => {
    expect(modelRejectionHint('codex', stderr)).toBe(
      'hint: your codex CLI may be too old for the selected model — upgrade it or switch backend in Settings.',
    );
  });

  it('names the given agent kind in the hint text', () => {
    expect(modelRejectionHint('claude', 'unknown model')).toBe(
      'hint: your claude CLI may be too old for the selected model — upgrade it or switch backend in Settings.',
    );
  });
});
