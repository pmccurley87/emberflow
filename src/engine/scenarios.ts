import type { ScenarioDefinition, WorkflowDefinition } from './types';

/** Find a scenario by name (exact) or id. Returns undefined when absent. */
export function findScenario(
  flow: WorkflowDefinition,
  nameOrId: string,
): ScenarioDefinition | undefined {
  return flow.scenarios?.find((s) => s.name === nameOrId || s.id === nameOrId);
}

/** Names of a flow's scenarios, for error messages. */
export function scenarioNames(flow: WorkflowDefinition): string[] {
  return (flow.scenarios ?? []).map((s) => s.name);
}

/** Merge an op's flow-level `mocks` with a scenario's `mocks` (scenario wins
 *  per nodeId) into the map an executor mock run consults. ONE merge shared
 *  by both places that start a mock run: the live serving path
 *  (server/index.ts POST /runs, when servingMode === 'mock') and the CLI test
 *  runner's `--mock` flag (server/testRunner.ts) — so mock semantics can't
 *  drift between "serve mock" and "test mock". */
export function mergeMocks(
  flow: WorkflowDefinition,
  scenario?: ScenarioDefinition,
): Record<string, unknown> {
  const opMocks = (flow.mocks ?? {}) as Record<string, unknown>;
  const scenarioMocks = (scenario?.mocks ?? {}) as Record<string, unknown>;
  return { ...opMocks, ...scenarioMocks };
}
