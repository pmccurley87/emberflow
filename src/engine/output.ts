import type { WorkflowDefinition, WorkflowRun } from './types';

/**
 * The output a finished run surfaces: the data collected by its Result nodes —
 * exactly what the Dock's Output tab shows. A run with a single Result that
 * produced output yields that output directly; multiple Results are keyed by
 * node label; a run whose Result nodes were all skipped (or has none) yields
 * undefined. Used to derive a Subflow node's return value on both hosts
 * (browser store and server run registry), so subflow output follows the same
 * convention users already see for a run.
 */
export function runOutput(run: WorkflowRun, flow: WorkflowDefinition): unknown {
  const produced = flow.nodes.filter(
    (n) => n.type === 'Result' && run.nodeStates[n.id]?.output !== undefined,
  );
  if (produced.length === 0) return undefined;
  if (produced.length === 1) return run.nodeStates[produced[0].id]!.output;
  const out: Record<string, unknown> = {};
  for (const n of produced) out[n.label] = run.nodeStates[n.id]!.output;
  return out;
}
