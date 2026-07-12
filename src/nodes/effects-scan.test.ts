import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './index';

/**
 * Validation-layer backstop (design doc "Safe-mode enforcement", layer 3): any
 * node implementation whose source references the shared write primitives
 * (goTransaction, raw INSERT/UPDATE/DELETE SQL, or the assertEffectsAllowed
 * backstop) must declare `effects: 'mutation'` — this catches drift where a
 * node grows a write path but the declaration is forgotten. Heuristic, not
 * exhaustive: a node could write through some other, unmatched mechanism.
 */
const WRITE_PATTERN = /goTransaction|INSERT\s|UPDATE\s|DELETE\s|assertEffectsAllowed/i;

/**
 * Nodes whose implementation source matches WRITE_PATTERN for a reason other
 * than performing a write (e.g. a variable name that happens to contain
 * "Update " once concatenated, or a write pattern appearing only inside a
 * string built for a *different*, already-covered node). Empty today —
 * every node currently caught by the pattern is a genuine write node with
 * `effects: 'mutation'` declared. Add entries here only after inspecting the
 * matched source and confirming it isn't a real write.
 */
const FALSE_POSITIVES = new Set<string>([]);

describe('effects-scan: node implementations that look like writes declare effects: mutation', () => {
  const registry = createDefaultRegistry(0);
  const definitions = registry.list();

  it('found at least one node to scan (registry is populated)', () => {
    expect(definitions.length).toBeGreaterThan(0);
  });

  for (const definition of definitions) {
    const { implementation } = registry.get(definition.type);
    const source = implementation.toString();
    if (!WRITE_PATTERN.test(source)) continue;

    it(`${definition.type}: matches the write pattern, so it must declare effects: 'mutation'`, () => {
      if (FALSE_POSITIVES.has(definition.type)) return;
      expect(definition.effects).toBe('mutation');
    });
  }

});
