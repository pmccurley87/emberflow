import type { ScenarioDefinition, WorkflowDefinition } from '../src/engine';

const SCENARIO_HEADER = 'x-emberflow-scenario';
const SCENARIO_QUERY = '__scenario';

export interface MockResponse {
  status: number;
  body: unknown;
  scenario?: string;
}

function fromExpect(scenario: ScenarioDefinition): MockResponse {
  const expect = scenario.expect;
  if (!expect) {
    return {
      status: 501,
      body: { error: `scenario "${scenario.name}" has no expect to mock from` },
    };
  }
  return { status: expect.status ?? 200, body: expect.body ?? {}, scenario: scenario.name };
}

function asScenarioName(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Pure scenario→response selection for mock mode. No I/O, no auth, no node
 *  execution. Selection: `x-emberflow-scenario` header (exact scenario name)
 *  → `__scenario` query param → first scenario with an `expect`. A named but
 *  unknown scenario is a 404; a named scenario without an `expect` is a 501;
 *  no scenario with an `expect` at all is a 501. */
export function mockResponseFor(
  _flow: WorkflowDefinition,
  scenarios: ScenarioDefinition[],
  req: { headers: Record<string, unknown>; query: Record<string, unknown> },
): MockResponse {
  const requestedName = asScenarioName(req.headers[SCENARIO_HEADER]) ?? asScenarioName(req.query[SCENARIO_QUERY]);

  if (requestedName !== undefined) {
    const named = scenarios.find((s) => s.name === requestedName);
    if (!named) {
      return { status: 404, body: { error: `unknown scenario "${requestedName}"` } };
    }
    return fromExpect(named);
  }

  const defaultScenario = scenarios.find((s) => s.expect !== undefined);
  if (!defaultScenario) {
    return { status: 501, body: { error: 'no mockable scenario (add an expect to a scenario)' } };
  }
  return fromExpect(defaultScenario);
}
