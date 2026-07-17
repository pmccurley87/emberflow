import { describe, expect, it } from 'vitest';
import { routeCommand } from './commandRouting';

const ctx = { currentFlowId: 'billing/charge', currentFlowName: 'Charge', hasOps: true };

describe('routeCommand', () => {
  it('questions route to ask (interrogatives and trailing ?)', () => {
    expect(routeCommand('why did the last run fail?', ctx)[0].kind).toBe('ask');
    expect(routeCommand('how does auth work here', ctx)[0].kind).toBe('ask');
  });
  it('build verbs with no current-op reference route to build-api', () => {
    expect(routeCommand('build an onboarding API for new tenants', ctx)[0].kind).toBe('build');
    expect(routeCommand('create endpoints for the billing worker', ctx)[0].kind).toBe('build');
  });
  it('default with a selected op is edit-current', () => {
    expect(routeCommand('add a retry to the DB write', ctx)[0].kind).toBe('edit');
  });
  it('scenario wording routes to scenario', () => {
    expect(routeCommand('add a scenario for the VIP path', ctx)[0].kind).toBe('scenario');
  });
  it('always returns all four options, deduped, smart default first', () => {
    const routed = routeCommand('do something', ctx);
    expect(routed.map((r) => r.kind).sort()).toEqual(['ask', 'build', 'edit', 'scenario']);
  });
  it('no ops in project → build is the default', () => {
    expect(routeCommand('do something', { ...ctx, hasOps: false })[0].kind).toBe('build');
  });
});
