import { describe, expect, it } from 'vitest';
import { buildRunbook } from './runbookModel';
import { createPradarFlows } from '../flows/pradar-flows';
import { createDefaultRegistry } from '../nodes';

const registry = createDefaultRegistry();
const flow = (id: string) =>
  [...createPradarFlows()].find((f) => f.id === id)!;

function flat(items: any[], out: any[] = []): any[] {
  for (const it of items) { out.push(it); if (it.items) flat(it.items, out); }
  return out;
}

describe('buildRunbook', () => {
  it('covers every node exactly once (steps + loop headers), Collect excluded', () => {
    for (const id of ['ev-evaluate-cycle']) {
      const f = flow(id);
      const doc = buildRunbook(f, registry);
      const all = flat(doc.items);
      const stepIds = all.filter((i) => i.kind === 'step').map((i) => i.nodeId);
      const loopHeads = all.filter((i) => i.kind === 'loop');
      const collectIds = loopHeads.map((l) => l.collectId);
      const forEachIds = loopHeads.map((l) => l.forEachId);
      const expected = f.nodes.map((n) => n.id).filter((id2) => !collectIds.includes(id2) && !forEachIds.includes(id2));
      expect([...stepIds].sort()).toEqual([...expected].sort());
      expect(new Set(stepIds).size).toBe(stepIds.length);
    }
  });

  it('ev-evaluate-cycle: night-window work is nested under the off arm, not a sibling of solar work', () => {
    const doc = buildRunbook(flow('ev-evaluate-cycle'), registry);
    const all = flat(doc.items);
    const night = all.find((i) => i.kind === 'step' && i.nodeId === 'subflowNight');
    const surplus = all.find((i) => i.kind === 'step' && i.nodeId === 'surplus');
    expect(night.depth).toBeGreaterThan(0);
    expect(surplus.depth).toBeGreaterThan(0);
    // they sit under DIFFERENT arms of condSolar
    const nightGuards = doc.guards.get('subflowNight')!.map((g) => `${g.ownerId}:${g.arm}`);
    const surplusGuards = doc.guards.get('surplus')!.map((g) => `${g.ownerId}:${g.arm}`);
    expect(nightGuards.some((g) => g.startsWith('condSolar:'))).toBe(true);
    expect(surplusGuards.some((g) => g.startsWith('condSolar:'))).toBe(true);
    expect(nightGuards.find((g) => g.startsWith('condSolar:'))).not.toBe(
      surplusGuards.find((g) => g.startsWith('condSolar:')));
  });

  it('numbers are hierarchical and unique', () => {
    const doc = buildRunbook(flow('ev-evaluate-cycle'), registry);
    const nums = flat(doc.items).map((i) => i.number);
    expect(new Set(nums).size).toBe(nums.length);
    expect(nums.some((n) => /^\d+\.\d+$/.test(n))).toBe(true);
  });

  it('Subflow steps carry subflowId; mutation steps carry mutation flag', () => {
    const doc = buildRunbook(flow('ev-evaluate-cycle'), registry);
    const all = flat(doc.items);
    const sub = all.find((i) => i.kind === 'step' && i.subflow);
    expect(sub.subflowId).toBe('ev-night-charge');
    expect(all.some((i) => i.kind === 'step' && i.mutation)).toBe(true);
  });
});
