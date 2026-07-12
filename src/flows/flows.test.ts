import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../nodes';
import { validateFlow } from '../engine';
import { createWeatherFlow } from './weather-flow';
import { createLoginFlow } from './login-flow';
import { createAnomalyFlows } from './anomaly-flows';
import { createCitySweepFlow } from './city-sweep-flow';

/**
 * Every example/sample flow shipped with the builder must validate cleanly
 * (no error-severity issues) against the default registry — this is the
 * catch-all that would have caught e.g. a loop region leaking an edge, or a
 * branch node's edges/config drifting out of sync with each other.
 */
describe('example flows', () => {
  const registry = createDefaultRegistry(0);
  const flows = [
    createWeatherFlow(),
    createLoginFlow(),
    ...createAnomalyFlows(),
    createCitySweepFlow(),
  ];

  for (const flow of flows) {
    it(`${flow.name} has no validation errors`, () => {
      const issues = validateFlow(flow, registry).filter((i) => i.severity === 'error');
      expect(issues, JSON.stringify(issues)).toEqual([]);
    });
  }
});
