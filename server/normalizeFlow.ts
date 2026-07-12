import { parsePathParams } from '../src/lib/pathParams';
import type { WorkflowDefinition, WorkflowNode } from '../src/engine';

export interface SeedParamDefaultsResult {
  flow: WorkflowDefinition;
  /** Path-param names that were newly seeded with `''`, in path order. */
  seeded: string[];
}

/**
 * Pure normalization step run before validation/persist on every write path
 * (PUT /workflows/:id, POST /operations): seeds an empty-string placeholder
 * under the first Input node's `config.defaults.params` for every `:param`
 * in `flow.http.path` that has no default yet, so a plain Run reaches nodes
 * with `params.<name> === ''` instead of crashing on `undefined` (same
 * scaffold shape `emberflow create` already produces).
 *
 * Mirrors the `missing-param-default` guard semantics (src/engine/diagnostics.ts):
 * presence, not meaningfulness, is what's checked/seeded. No-ops (returning
 * the SAME `flow` object, unmodified) when there's no `:param` in the path,
 * no Input node, or every param already has a default — never overwrites an
 * existing value, whatever it is (including `''`).
 */
export function seedParamDefaults(flow: WorkflowDefinition): SeedParamDefaultsResult {
  const path = flow.http?.path;
  const params = path ? parsePathParams(path) : [];
  if (params.length === 0) return { flow, seeded: [] };

  const inputNode = flow.nodes.find((n) => n.type === 'Input');
  if (!inputNode) return { flow, seeded: [] };

  const existingDefaults = inputNode.config?.defaults as Record<string, unknown> | undefined;
  const existingParams =
    existingDefaults && typeof existingDefaults === 'object' && !Array.isArray(existingDefaults)
      ? (existingDefaults.params as Record<string, unknown> | undefined)
      : undefined;

  const seeded = params.filter((name) => !existingParams || existingParams[name] === undefined);
  if (seeded.length === 0) return { flow, seeded: [] };

  const newParams = { ...(existingParams ?? {}) };
  for (const name of seeded) newParams[name] = '';

  const newInputNode: WorkflowNode = {
    ...inputNode,
    config: {
      ...(inputNode.config ?? {}),
      defaults: { ...(existingDefaults ?? {}), params: newParams },
    },
  };

  return {
    flow: {
      ...flow,
      nodes: flow.nodes.map((n) => (n === inputNode ? newInputNode : n)),
    },
    seeded,
  };
}
