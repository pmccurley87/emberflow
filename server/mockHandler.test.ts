import { describe, expect, it } from 'vitest';
import { mockResponseFor } from './mockHandler';
import type { ScenarioDefinition, WorkflowDefinition } from '../src/engine';

function flow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'flow-1',
    name: 'Flow One',
    version: 1,
    nodes: [],
    edges: [],
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  } as WorkflowDefinition;
}

function scenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    id: 'scn-1',
    name: 'Scenario One',
    input: {},
    ...overrides,
  } as ScenarioDefinition;
}

describe('mockResponseFor', () => {
  it('defaults to the first scenario that has an expect, skipping expect-less ones', () => {
    const scenarios = [
      scenario({ id: 'a', name: 'A' }),
      scenario({ id: 'b', name: 'B', expect: { status: 201, body: { ok: true } } }),
      scenario({ id: 'c', name: 'C', expect: { status: 999, body: {} } }),
    ];
    const result = mockResponseFor(flow(), scenarios, { headers: {}, query: {} });
    expect(result).toEqual({ status: 201, body: { ok: true }, scenario: 'B' });
  });

  it('selects by x-emberflow-scenario header (exact name match)', () => {
    const scenarios = [
      scenario({ id: 'a', name: 'A', expect: { status: 200, body: { which: 'a' } } }),
      scenario({ id: 'b', name: 'B', expect: { status: 202, body: { which: 'b' } } }),
    ];
    const result = mockResponseFor(flow(), scenarios, {
      headers: { 'x-emberflow-scenario': 'B' },
      query: {},
    });
    expect(result).toEqual({ status: 202, body: { which: 'b' }, scenario: 'B' });
  });

  it('selects by __scenario query param when no header is present', () => {
    const scenarios = [
      scenario({ id: 'a', name: 'A', expect: { status: 200, body: { which: 'a' } } }),
      scenario({ id: 'b', name: 'B', expect: { status: 202, body: { which: 'b' } } }),
    ];
    const result = mockResponseFor(flow(), scenarios, {
      headers: {},
      query: { __scenario: 'A' },
    });
    expect(result).toEqual({ status: 200, body: { which: 'a' }, scenario: 'A' });
  });

  it('prefers the header over the query param when both are present', () => {
    const scenarios = [
      scenario({ id: 'a', name: 'A', expect: { status: 200, body: { which: 'a' } } }),
      scenario({ id: 'b', name: 'B', expect: { status: 202, body: { which: 'b' } } }),
    ];
    const result = mockResponseFor(flow(), scenarios, {
      headers: { 'x-emberflow-scenario': 'B' },
      query: { __scenario: 'A' },
    });
    expect(result).toEqual({ status: 202, body: { which: 'b' }, scenario: 'B' });
  });

  it('returns 404 for a named-but-unknown scenario (header)', () => {
    const scenarios = [scenario({ id: 'a', name: 'A', expect: { status: 200, body: {} } })];
    const result = mockResponseFor(flow(), scenarios, {
      headers: { 'x-emberflow-scenario': 'Nope' },
      query: {},
    });
    expect(result).toEqual({ status: 404, body: { error: 'unknown scenario "Nope"' } });
  });

  it('returns 404 for a named-but-unknown scenario (query)', () => {
    const scenarios = [scenario({ id: 'a', name: 'A', expect: { status: 200, body: {} } })];
    const result = mockResponseFor(flow(), scenarios, {
      headers: {},
      query: { __scenario: 'Nope' },
    });
    expect(result).toEqual({ status: 404, body: { error: 'unknown scenario "Nope"' } });
  });

  it('returns 501 when a named scenario exists but has no expect', () => {
    const scenarios = [scenario({ id: 'a', name: 'A' })];
    const result = mockResponseFor(flow(), scenarios, {
      headers: { 'x-emberflow-scenario': 'A' },
      query: {},
    });
    expect(result).toEqual({
      status: 501,
      body: { error: 'scenario "A" has no expect to mock from' },
    });
  });

  it('returns 501 when no scenario has an expect at all', () => {
    const scenarios = [scenario({ id: 'a', name: 'A' }), scenario({ id: 'b', name: 'B' })];
    const result = mockResponseFor(flow(), scenarios, { headers: {}, query: {} });
    expect(result).toEqual({
      status: 501,
      body: { error: 'no mockable scenario (add an expect to a scenario)' },
    });
  });

  it('returns 501 with no scenarios at all', () => {
    const result = mockResponseFor(flow(), [], { headers: {}, query: {} });
    expect(result).toEqual({
      status: 501,
      body: { error: 'no mockable scenario (add an expect to a scenario)' },
    });
  });

  it('defaults status to 200 when expect only has a body', () => {
    const scenarios = [scenario({ id: 'a', name: 'A', expect: { body: { hello: 'world' } } })];
    const result = mockResponseFor(flow(), scenarios, { headers: {}, query: {} });
    expect(result).toEqual({ status: 200, body: { hello: 'world' }, scenario: 'A' });
  });

  it('defaults body to {} when expect only has a status', () => {
    const scenarios = [scenario({ id: 'a', name: 'A', expect: { status: 204 } })];
    const result = mockResponseFor(flow(), scenarios, { headers: {}, query: {} });
    expect(result).toEqual({ status: 204, body: {}, scenario: 'A' });
  });

  it('treats an empty expect object as mockable with defaults', () => {
    const scenarios = [scenario({ id: 'a', name: 'A', expect: {} })];
    const result = mockResponseFor(flow(), scenarios, { headers: {}, query: {} });
    expect(result).toEqual({ status: 200, body: {}, scenario: 'A' });
  });
});
