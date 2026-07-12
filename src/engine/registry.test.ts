import { describe, expect, it } from 'vitest';
import { NodeRegistry } from './registry';
import type { NodeDefinition } from './types';

const def = (type: string): NodeDefinition => ({ type, label: type });
const impl = async () => ({});

describe('NodeRegistry', () => {
  it('registers and retrieves a node', () => {
    const r = new NodeRegistry();
    r.register(def('a'), impl);
    expect(r.get('a').definition.type).toBe('a');
    expect(r.has('a')).toBe(true);
  });

  it('throws on duplicate registration', () => {
    const r = new NodeRegistry();
    r.register(def('a'), impl);
    expect(() => r.register(def('a'), impl)).toThrow(/already registered/);
  });

  it('throws on unknown type', () => {
    expect(() => new NodeRegistry().get('nope')).toThrow(/Unknown node type/);
  });

  it('lists definitions', () => {
    const r = new NodeRegistry();
    r.register(def('a'), impl);
    r.register(def('b'), impl);
    expect(r.list().map((d) => d.type)).toEqual(['a', 'b']);
  });
});

describe('NodeRegistry.registerDefinition', () => {
  it('adds a metadata-only node whose implementation throws server-required', async () => {
    const r = new NodeRegistry();
    r.registerDefinition({ type: 'Remote', label: 'Remote' }, 'async () => ({})');
    expect(r.has('Remote')).toBe(true);
    expect(r.list().map((d) => d.type)).toContain('Remote');
    expect(r.getSource('Remote')).toBe('async () => ({})');
    await expect(r.get('Remote').implementation({} as never)).rejects.toThrow(/server/i);
  });

  it('does not overwrite an already-registered node', () => {
    const r = new NodeRegistry();
    r.register({ type: 'A', label: 'Real' }, async () => ({ real: true }));
    r.registerDefinition({ type: 'A', label: 'Stub' });
    expect(r.get('A').definition.label).toBe('Real');
  });

  it('getSource returns implementation source for real nodes', () => {
    const r = new NodeRegistry();
    r.register({ type: 'B', label: 'B' }, async () => ({ v: 1 }));
    expect(r.getSource('B')).toContain('v: 1');
  });

  it('withSameNodes returns a new instance that shares the same nodes', () => {
    const r = new NodeRegistry();
    r.register({ type: 'C', label: 'C' }, async () => ({}));
    const clone = r.withSameNodes();
    expect(clone).not.toBe(r);
    expect(clone.has('C')).toBe(true);
  });
});
