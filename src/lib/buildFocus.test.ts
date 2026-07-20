import { describe, expect, it } from 'vitest';
import { buildFocus } from './buildFocus';
import type { WorkflowSummary } from '../store/builderStore';

const plan = {
  location: 'default',
  ops: [
    { id: 'default/daily-signals/dispatch', name: 'Daily Signal Dispatch' },
    { id: 'default/daily-signals/check-project', name: 'Daily Project Signal Check' },
    { id: 'default/daily-signals/dead-letter', name: 'Daily Signal Dead Letter' },
  ],
};
const workflows: WorkflowSummary[] = [
  { id: 'default/daily-signals/dispatch', name: 'Loaded Name' },
];

describe('buildFocus', () => {
  it('names the op being written this tick, its folder, and progress against the declared plan', () => {
    const focus = buildFocus(
      {
        'default/daily-signals/dispatch': 'done',
        'default/daily-signals/check-project': 'building',
        'default/daily-signals/dead-letter': 'queued',
      },
      plan,
      workflows,
    );
    expect(focus).toEqual({
      id: 'default/daily-signals/check-project',
      name: 'Daily Project Signal Check',
      location: 'default/daily-signals',
      done: 1,
      total: 3,
    });
  });

  it('prefers the declared plan name over the loaded op name', () => {
    const focus = buildFocus({ 'default/daily-signals/dispatch': 'building' }, plan, workflows);
    expect(focus?.name).toBe('Daily Signal Dispatch');
  });

  it('falls back to the loaded op name, then the slug, for ops outside the plan', () => {
    expect(buildFocus({ 'default/daily-signals/dispatch': 'building' }, null, workflows)?.name).toBe('Loaded Name');
    expect(buildFocus({ 'billing/charge': 'building' }, null, [])?.name).toBe('charge');
  });

  it('reports no current op between operations, keeping the progress count', () => {
    const focus = buildFocus({ 'default/daily-signals/dispatch': 'done' }, plan, workflows);
    expect(focus?.id).toBeNull();
    expect(focus?.name).toBeNull();
    expect(focus).toMatchObject({ done: 1, total: 3 });
  });

  it('without a plan the ledger supplies the denominator, never below what is done', () => {
    const focus = buildFocus({ a: 'done', b: 'building' }, null, []);
    expect(focus).toMatchObject({ id: 'b', done: 1, total: 2 });
  });

  it('is null when there is nothing to report', () => {
    expect(buildFocus(null, null, [])).toBeNull();
    expect(buildFocus({}, null, [])).toBeNull();
  });
});
