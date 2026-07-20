import type { AgentPlanOp } from '../store/agentClient';
import type { WorkflowSummary } from '../store/builderStore';

/**
 * What the agent is working on right now, and how far through the declared
 * surface it is. Derived from the live build ledger (`buildLedger`) plus the
 * declared plan (`agentPlan`) — both already maintained by the poll loop, so
 * this adds no fetching, only a readable projection of what they mean.
 */
export interface BuildFocus {
  /** Operation id the agent is writing this tick, or null when between ops. */
  id: string | null;
  /** Display name for `id` — the plan's name, else the loaded op's, else the slug. */
  name: string | null;
  /** Folder the op lives in (`api/folder`), for the "where" line. */
  location: string | null;
  /** Operations finished so far, out of the declared/known total. */
  done: number;
  total: number;
}

/** Prefer the human name — the declared plan's, then the loaded op's, then the slug. */
function nameFor(id: string, plan: AgentPlanOp[], workflows: WorkflowSummary[]): string {
  return (
    plan.find((p) => p.id === id)?.name ??
    workflows.find((w) => w.id === id)?.name ??
    (id.split('/').pop() ?? id)
  );
}

export function buildFocus(
  ledger: Record<string, 'queued' | 'building' | 'done'> | null,
  plan: { location: string; ops: AgentPlanOp[] } | null,
  workflows: WorkflowSummary[],
): BuildFocus | null {
  if (!ledger && !plan) return null;
  const entries = Object.entries(ledger ?? {});
  const planOps = plan?.ops ?? [];
  const building = entries.find(([, state]) => state === 'building')?.[0] ?? null;
  const done = entries.filter(([, state]) => state === 'done').length;
  // The declared surface is the honest denominator; without a plan, fall back
  // to what the ledger has seen so far (never less than `done`).
  const total = planOps.length > 0 ? planOps.length : entries.length;
  if (!building && total === 0) return null;
  return {
    id: building,
    name: building ? nameFor(building, planOps, workflows) : null,
    location: building ? building.split('/').slice(0, -1).join('/') || null : null,
    done,
    total: Math.max(total, done),
  };
}
