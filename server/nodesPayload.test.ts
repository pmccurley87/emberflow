import { describe, expect, it } from 'vitest';
import { NodeRegistry } from '../src/engine';
import { nodesPayload } from './nodesPayload';

describe('nodesPayload', () => {
  it('returns each node definition with its implementation source', () => {
    const r = new NodeRegistry();
    r.register(
      { type: 'Shout', label: 'Shout', category: 'demo', tags: ['x'] },
      async (ctx) => ({ loud: String(ctx.input.text).toUpperCase() }),
    );
    const payload = nodesPayload(r);
    expect(payload.nodes).toHaveLength(1);
    const node = payload.nodes[0];
    expect(node.type).toBe('Shout');
    expect(node.label).toBe('Shout');
    expect(node.category).toBe('demo');
    expect(node.tags).toEqual(['x']);
    expect(node.source).toContain('toUpperCase');
  });

  it('is JSON-serializable (no functions leak through)', () => {
    const r = new NodeRegistry();
    r.register({ type: 'A', label: 'A' }, async () => ({}));
    const round = JSON.parse(JSON.stringify(nodesPayload(r)));
    expect(round.nodes[0].type).toBe('A');
    expect(typeof round.nodes[0].source).toBe('string');
  });
});
