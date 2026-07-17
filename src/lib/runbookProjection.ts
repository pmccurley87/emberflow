import type { ExecutionRecord, LogLine, NodeRunState, WorkflowRun } from '../engine';
import type { RunHistoryEntry } from '../store/builderStore';
import type { RunbookDoc, RunbookItem } from './runbookModel';

export type StepVisualStatus = 'idle' | 'active' | 'ran' | 'failed' | 'skipped';

export interface StepProjection {
  status: StepVisualStatus;
  /** simple-register outcome: last info-level log line for this node in the current run, else '' */
  outcome: string;
  /**
   * technical line, prefixed `#N` once the node's receipt exists:
   * ran → `[#N ]${typeName} · ${durationMs}ms · in[a,b] → out[c,d]`,
   * failed → `[#N ]${typeName} · ${durationMs}ms · ERROR: ${error.slice(0,80)}`,
   * else → `[#N ]${typeName}`
   */
  tech: string;
  durationMs: number | null;
  /** loop-body nodes: latest execution index and total, from NodeRunState.iteration */
  iteration?: { index: number; total: number };
}

export interface ArmProjection {
  /** taken in the CURRENT run */
  takenNow: boolean;
  /** scenario names from run history whose runs took this arm (nodeStates of any gated member succeeded) */
  coveredBy: string[];
}

export interface RunbookProjection {
  steps: Map<string, StepProjection>;
  arms: Map<string, ArmProjection>; // key `${ownerId}::${arm}`
  coverage: { covered: number; total: number };
  loops: Map<string, { statuses: ('done' | 'failed' | 'pending' | 'running')[]; count: number }>; // key forEachId
}

function statusOf(state: NodeRunState | undefined): StepVisualStatus {
  switch (state?.status) {
    case 'running':
      return 'active';
    case 'succeeded':
      return 'ran';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'idle';
  }
}

function fieldList(value: unknown, label: string): string {
  const keys = value && typeof value === 'object' ? Object.keys(value as Record<string, unknown>) : [];
  const capped = keys.slice(0, 4);
  const shown = keys.length > 4 ? [...capped, '…'] : capped;
  return `${label}[${shown.join(',')}]`;
}

/**
 * Whether a log line belongs to the given node. A drilled-in subflow child's
 * log lines carry nodeIds prefixed with the caller chain
 * (`${callerNodeId}/${childNodeId}`, nested per level — see subflowRunner),
 * while the drilled view's runbook uses the raw child ids, so when projecting
 * a drilled child flow a suffix match after a slash also counts. Kept behind
 * `drilled` so an undriled parent view can never match a child's prefixed
 * line against a same-named parent node.
 */
function lineIsFor(line: LogLine, nodeId: string, drilled: boolean): boolean {
  if (line.nodeId === nodeId) return true;
  return drilled && !!line.nodeId && line.nodeId.endsWith(`/${nodeId}`);
}

function lastInfoOutcome(logs: LogLine[], nodeId: string, drilled: boolean): string {
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i];
    if (lineIsFor(line, nodeId, drilled) && line.level === 'info') return line.message;
  }
  return '';
}

/**
 * The execution sequence number from the node's ordered receipt — the
 * `#N ▶ execute` debug line the executor emits before each run (executor.ts).
 * The technical line prefixes `#N` so a step reads as proof of exactly what
 * ran, in what order. Returns the LATEST receipt (loop bodies emit one per
 * iteration); null when the node has no receipt yet (never executed).
 */
const RECEIPT_RE = /^#(\d+) ▶ execute/;
function receiptSeq(logs: LogLine[], nodeId: string, drilled: boolean): string | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i];
    if (lineIsFor(line, nodeId, drilled) && line.level === 'debug') {
      const match = RECEIPT_RE.exec(line.message);
      if (match) return match[1];
    }
  }
  return null;
}

function durationOf(state: NodeRunState | undefined): number | null {
  if (!state?.startedAt || !state?.completedAt) return null;
  return new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime();
}

/**
 * Per-iteration outcome text for a loop-body row when a loop chip is
 * selected. Logs aren't addressable per iteration, so this is the fallback
 * summary built straight from the execution record instead: the error when
 * the iteration failed (destructive text upstream), else the output field
 * names, matching the live outcome line's `out[a,b,c,d]` shorthand.
 */
export function iterationSummary(exec: ExecutionRecord): string {
  if (exec.error) return exec.error;
  const keys =
    exec.output && typeof exec.output === 'object' ? Object.keys(exec.output as Record<string, unknown>) : [];
  return `→ out[${keys.slice(0, 4).join(', ')}]`;
}

/** One honest phrase for where a run's data came from — mock runs must never
 *  read as real success. Rendered beside the run status line. */
export function runSourceLabel(mock: boolean, environment: string): string {
  if (mock) return 'on example data — nothing real executed';
  return environment ? `against ${environment}` : 'against the default environment';
}

/**
 * Resolve mock/environment for whichever run is actually DISPLAYED, not the
 * live editor's current toggles. `viewRun` (builderStore.ts) can point `run`
 * at a `runHistory` entry without touching `activeRunMock`/`selectedEnvironment`
 * — e.g. run in mock, switch to prod, then open an old mocked run from
 * history. Reading the live flags in that case mislabels the historical run
 * with the CURRENT session's env/mock state.
 *
 * `historyEntry` (the `runHistory` row matching `run.id`, when present) is
 * the run's own frozen provenance — `mock` per `RunHistoryEntry.mock`
 * (builderStore.ts recordRun tags it from `activeRunMock` at record time,
 * never mutated after). When no history entry matches, the run is still
 * live/in-flight (not yet recorded — see `recordRun`), so the live mock flag
 * is the correct, only available source.
 *
 * Environment prefers the run's own `WorkflowRun.environment` (set by the
 * server on the finished run — see `onFinished` in builderStore.ts) over the
 * history entry's copy of it, falling back to the live `selectedEnvironment`
 * only for a run still in flight (the server hasn't reported `environment`
 * back yet).
 */
export function runProvenance(
  run: WorkflowRun | null,
  historyEntry: RunHistoryEntry | undefined,
  liveMock: boolean,
  liveEnvironment: string,
): { mock: boolean; environment: string } {
  if (!run) return { mock: liveMock, environment: liveEnvironment };
  return {
    mock: historyEntry ? !!historyEntry.mock : liveMock,
    environment: run.environment ?? historyEntry?.environment ?? liveEnvironment,
  };
}

interface CollectedStep {
  nodeId: string;
  typeName: string;
}

/** Walks the item tree, collecting every 'step' leaf (branch/loop bodies included), recursively. */
function collectSteps(items: RunbookItem[], out: CollectedStep[] = []): CollectedStep[] {
  for (const item of items) {
    if (item.kind === 'step') {
      out.push({ nodeId: item.nodeId, typeName: item.typeName });
    } else {
      collectSteps(item.items, out);
    }
  }
  return out;
}

interface CollectedLoop {
  forEachId: string;
  bodyStepIds: string[];
}

/** Walks the item tree for loop groups (including nested ones inside branches/other loops). */
function collectLoops(items: RunbookItem[], out: CollectedLoop[] = []): CollectedLoop[] {
  for (const item of items) {
    if (item.kind === 'loop') {
      out.push({ forEachId: item.forEachId, bodyStepIds: collectSteps(item.items).map((s) => s.nodeId) });
      collectLoops(item.items, out);
    } else if (item.kind === 'branch') {
      collectLoops(item.items, out);
    }
  }
  return out;
}

/** Every node id that is a gated member of `(ownerId, arm)`, per doc.guards. */
function membersOf(doc: RunbookDoc, ownerId: string, arm: string): string[] {
  const members: string[] = [];
  for (const [nodeId, guardList] of doc.guards) {
    if (guardList.some((g) => g.ownerId === ownerId && g.arm === arm)) members.push(nodeId);
  }
  return members;
}

export function projectRunbook(
  doc: RunbookDoc,
  run: WorkflowRun | null,
  logs: LogLine[],
  history: RunHistoryEntry[],
  flowId: string,
  /** True when projecting a drilled-in subflow child view: log lines then
   *  also match by `…/${nodeId}` suffix (child log ids are caller-prefixed). */
  drilled = false,
): RunbookProjection {
  // ── steps ──
  const steps = new Map<string, StepProjection>();
  for (const { nodeId, typeName } of collectSteps(doc.items)) {
    const state = run?.nodeStates[nodeId];
    const status = statusOf(state);
    // A failed node's outcome line is its error, not the last info log (which
    // may be stale from a prior successful attempt or simply absent).
    const outcome =
      status === 'failed'
        ? state?.error || lastInfoOutcome(logs, nodeId, drilled)
        : lastInfoOutcome(logs, nodeId, drilled);
    const durationMs = durationOf(state);
    // `#N` receipt prefix once the node has executed; bare type name before that.
    const seq = receiptSeq(logs, nodeId, drilled);
    const prefix = seq ? `#${seq} ` : '';
    const ms = `${durationMs ?? 0}ms`;
    let tech: string;
    if (status === 'ran') {
      tech = `${prefix}${typeName} · ${ms} · ${fieldList(state?.input, 'in')} → ${fieldList(state?.output, 'out')}`;
    } else if (status === 'failed') {
      tech = `${prefix}${typeName} · ${ms} · ERROR: ${(state?.error ?? '').slice(0, 80)}`;
    } else {
      tech = `${prefix}${typeName}`;
    }
    const projection: StepProjection = { status, outcome, tech, durationMs };
    if (state?.iteration) projection.iteration = state.iteration;
    steps.set(nodeId, projection);
  }

  // ── arms ──
  const arms = new Map<string, ArmProjection>();
  for (const { ownerId, arm } of doc.arms) {
    const members = membersOf(doc, ownerId, arm);

    // Primary signal: the OWNER's own recorded decision. This is what makes
    // every arm coverable — an arm whose only downstream node is a join (per
    // buildGuardMap's intersection, see runbookModel.ts) has no gated members
    // at all, so member-based detection can never fire for it. The gated
    // member check remains as an OR-fallback for robustness: some Route-like
    // nodes spread their branch output onto downstream nodes rather than
    // keeping `$branch` on their own nodeState.
    const ownerTookArm = (state: NodeRunState | undefined): boolean =>
      (state?.output as Record<string, unknown> | undefined)?.$branch === arm;

    const takenNow =
      (!!run && ownerTookArm(run.nodeStates[ownerId])) ||
      (!!run &&
        members.some((id) => {
          const s = run.nodeStates[id]?.status;
          return s === 'succeeded' || s === 'failed' || s === 'running';
        }));

    const coveredBy: string[] = [];
    for (const entry of history) {
      if (coveredBy.length >= 3) break;
      if (entry.workflowId !== flowId) continue;
      const covers =
        ownerTookArm(entry.nodeStates[ownerId]) ||
        members.some((id) => {
          const s = entry.nodeStates[id]?.status;
          return s === 'succeeded' || s === 'failed';
        });
      if (!covers) continue;
      const name = entry.scenarioName ?? 'manual run';
      if (!coveredBy.includes(name)) coveredBy.push(name);
    }

    arms.set(`${ownerId}::${arm}`, { takenNow, coveredBy });
  }

  const covered = [...arms.values()].filter((a) => a.takenNow || a.coveredBy.length > 0).length;
  const coverage = { covered, total: doc.arms.length };

  // ── loops ──
  const loops = new Map<string, { statuses: ('done' | 'failed' | 'pending' | 'running')[]; count: number }>();
  for (const { forEachId, bodyStepIds } of collectLoops(doc.items)) {
    const feState = run?.nodeStates[forEachId];
    const executions = feState?.executions ?? [];

    let count = feState?.iteration?.total ?? 0;
    for (const ex of executions) count = Math.max(count, ex.iteration.total);
    for (const id of bodyStepIds) {
      const it = run?.nodeStates[id]?.iteration;
      if (it) count = Math.max(count, it.total);
    }

    const statuses: ('done' | 'failed' | 'pending' | 'running')[] = Array.from({ length: count }, () => 'pending');
    for (const ex of executions) {
      statuses[ex.iteration.index] = ex.status === 'succeeded' ? 'done' : 'failed';
    }
    for (const id of bodyStepIds) {
      const st = run?.nodeStates[id];
      if (st?.status === 'running' && st.iteration && statuses[st.iteration.index] === 'pending') {
        statuses[st.iteration.index] = 'running';
      }
    }

    loops.set(forEachId, { statuses, count });
  }

  return { steps, arms, coverage, loops };
}
