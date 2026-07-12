import { describe, expect, it } from 'vitest';
import { parsePathParams } from './pathParams';

// The Run-guard semantics that used to live here (missingPathParams) moved to
// src/engine/diagnostics.ts as the `missing-param-default` diagnostic; its
// behavior contract is covered by src/engine/diagnostics.test.ts.

describe('parsePathParams', () => {
  it('extracts a single param', () => {
    expect(parsePathParams('/api/channels/:id/approvals')).toEqual(['id']);
  });

  it('extracts multiple params in order', () => {
    expect(parsePathParams('/api/channels/:id/approvals/:approvalId')).toEqual(['id', 'approvalId']);
  });

  it('returns empty array when there are no colon segments', () => {
    expect(parsePathParams('/api/channels')).toEqual([]);
  });

  it('ignores standalone colons that do not start a param name', () => {
    expect(parsePathParams('/api/channels/id')).toEqual([]);
  });
});
