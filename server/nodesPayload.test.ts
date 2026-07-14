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

  it('adds a repo-relative sourceRef when the captured file is inside the project root', () => {
    const r = new NodeRegistry();
    r.register({ type: 'X', label: 'X' }, async () => ({}), {
      sourceRef: { file: '/proj/nodes/logic.mjs', line: 12 },
    });
    const node = nodesPayload(r, '/proj').nodes[0];
    expect(node.sourceRef).toEqual({ file: 'nodes/logic.mjs', line: 12 });
    expect(node.builtin).toBeUndefined();
  });

  it('flags builtin: true when the sourceRef points outside the project root', () => {
    const r = new NodeRegistry();
    r.register({ type: 'Y', label: 'Y' }, async () => ({}), {
      sourceRef: { file: '/somewhere/else/pkg/node.ts', line: 3 },
    });
    const node = nodesPayload(r, '/proj').nodes[0];
    expect(node.builtin).toBe(true);
    expect(node.sourceRef).toBeUndefined();
  });

  it('omits sourceRef and builtin entirely when nothing was captured', () => {
    const r = new NodeRegistry();
    r.register({ type: 'Z', label: 'Z' }, async () => ({}));
    const node = nodesPayload(r, '/proj').nodes[0];
    expect('sourceRef' in node).toBe(false);
    expect('builtin' in node).toBe(false);
  });

  it('preserves the source (toString) field alongside sourceRef', () => {
    const r = new NodeRegistry();
    r.register({ type: 'W', label: 'W' }, async () => ({ shout: true }), {
      sourceRef: { file: '/proj/w.mjs', line: 1 },
    });
    const node = nodesPayload(r, '/proj').nodes[0];
    expect(node.source).toContain('shout');
    expect(node.sourceRef).toEqual({ file: 'w.mjs', line: 1 });
  });
});
