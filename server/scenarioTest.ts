import type { ScenarioExpectation, WorkflowDefinition, WorkflowRun } from '../src/engine';
import { extractResponse } from './operationResult';

function fmt(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

/** Deep-subset match: every key/index present in `expected` must match the
 *  corresponding key/index in `actual`, recursively. Extra keys/indices in
 *  `actual` are ignored. `null` matches only `null`. Returns human-readable
 *  failure strings with dotted (and `[i]`) paths; empty array = match. */
export function deepSubsetMatch(expected: unknown, actual: unknown, path = ''): string[] {
  const label = path === '' ? '' : `${path}: `;

  if (expected === null) {
    return actual === null ? [] : [`${label}expected null, got ${fmt(actual)}`];
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return [`${label}expected array, got ${fmt(actual)}`];
    }
    const failures: string[] = [];
    for (let i = 0; i < expected.length; i++) {
      failures.push(...deepSubsetMatch(expected[i], actual[i], `${path}[${i}]`));
    }
    return failures;
  }

  if (typeof expected === 'object') {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
      return [`${label}expected object, got ${fmt(actual)}`];
    }
    const failures: string[] = [];
    for (const key of Object.keys(expected as Record<string, unknown>)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      failures.push(
        ...deepSubsetMatch(
          (expected as Record<string, unknown>)[key],
          (actual as Record<string, unknown>)[key],
          childPath,
        ),
      );
    }
    return failures;
  }

  // Primitive.
  return expected === actual ? [] : [`${label}expected ${fmt(expected)}, got ${fmt(actual)}`];
}

/** Check a scenario's finished run against its `expect` assertion. `status`/
 *  `body` come from `extractResponse` (the flow's Response-node mapping,
 *  defaulting to status 200); `executedNodes` checks each id's node state is
 *  `succeeded`. */
export function evaluateExpectation(
  run: WorkflowRun,
  flow: WorkflowDefinition,
  expect: ScenarioExpectation,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];

  if (expect.status !== undefined || expect.body !== undefined) {
    const { status, body } = extractResponse(run, flow);

    if (expect.status !== undefined && expect.status !== status) {
      failures.push(`status: expected ${expect.status}, got ${status}`);
    }

    if (expect.body !== undefined) {
      for (const failure of deepSubsetMatch(expect.body, body)) {
        failures.push(`body.${failure}`);
      }
    }
  }

  if (expect.executedNodes) {
    for (const id of expect.executedNodes) {
      const state = run.nodeStates[id];
      if (state?.status !== 'succeeded') {
        failures.push(`executedNodes: ${id} did not execute (status: ${state?.status ?? 'not run'})`);
      }
    }
  }

  return { ok: failures.length === 0, failures };
}
