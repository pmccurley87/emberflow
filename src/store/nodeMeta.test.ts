import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchNodeMeta } from './nodeMeta';

afterEach(() => vi.unstubAllGlobals());

describe('fetchNodeMeta', () => {
  it('returns the runner node list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ nodes: [{ type: 'X', label: 'X', source: 'fn' }] }),
    })));
    expect(await fetchNodeMeta()).toEqual([{ type: 'X', label: 'X', source: 'fn' }]);
  });

  it('returns [] when the runner is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await fetchNodeMeta()).toEqual([]);
  });

  it('returns [] on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    expect(await fetchNodeMeta()).toEqual([]);
  });
});
