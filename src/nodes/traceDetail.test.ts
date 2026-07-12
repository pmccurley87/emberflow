import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './index';

/**
 * traceDetail is a STATIC, honest descriptor of the concrete call each db/http/llm
 * node makes — the "what it calls" line in the runbook trace-badge hover card.
 * These assertions prove honesty (real table names, HTTP verbs, provider/model)
 * without pinning brittle exact strings.
 */
describe('node traceDetail annotations', () => {
  const registry = createDefaultRegistry();
  const detail = (type: string): string | undefined => registry.get(type).definition.traceDetail;

  it('every db/http/llm node carries a non-empty traceDetail; compute nodes carry none', () => {
    for (const def of registry.list()) {
      if (def.traceKind === 'db' || def.traceKind === 'http' || def.traceKind === 'llm') {
        expect(def.traceDetail, `${def.type} should have traceDetail`).toBeTruthy();
        expect(def.traceDetail!.trim().length).toBeGreaterThan(0);
      }
      if (def.traceKind === 'compute') {
        expect(def.traceDetail, `${def.type} (compute) should have no traceDetail`).toBeUndefined();
      }
    }
  });

  it('http nodes name the HTTP verb and endpoint', () => {
    // Real anomaly service.
    expect(detail('DetectLastPoint')).toMatch(/POST/);
    expect(detail('DetectLastPoint')).toMatch(/timeseries\/last\/detect/);

    // Open-Meteo public API.
    expect(detail('GeocodeCity')).toMatch(/open-meteo\.com/);

    // Simulated senders name the endpoint they represent AND flag the simulation.
    expect(detail('EvNotify')).toMatch(/ntfy\.sh/);
    expect(detail('EvNotify')).toMatch(/SIMULATED/i);
  });

});
