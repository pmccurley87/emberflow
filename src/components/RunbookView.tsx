import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, SparklesIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useBuilderStore } from '../store/builderStore';
import { Json } from './Json';
import { buildRunbook } from '../lib/runbookModel';
import type { RunbookBranchGroup, RunbookItem, RunbookLoopGroup, RunbookStep } from '../lib/runbookModel';
import { iterationSummary, projectRunbook } from '../lib/runbookProjection';
import type { RunbookProjection, StepVisualStatus } from '../lib/runbookProjection';
import type {WorkflowRun } from '../engine';

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Minimum gap between auto-scrolls — one deliberate move at a time, never a
 * flurry. */
const SCROLL_MIN_GAP_MS = 1100;

/** Fade-out duration for outcome-text crossfades; the swap happens at the
 * midpoint and the fade back in mirrors it, for a ~440ms round trip. */
const CROSSFADE_MS = 220;

/** Reveal floor between two terminal steps. A cheap flow finishes server-side
 * in a single frame; releasing steps no faster than this turns that burst into
 * a legible sequence you can actually read filling the document. Genuinely slow
 * steps (LLM calls) already outlast the floor, so they never wait on it — the
 * queue adds pacing only when the engine outran the eye. */
const STEP_REVEAL_MIN_MS = 350;

/** Per-iteration pace for a loop's mini-dots — a third of the step floor so a
 * five-iteration loop fills in ~0.6s instead of stalling the document, but
 * never faster than 120ms (below that the dots read as a flicker, not a fill). */
const LOOP_REVEAL_TICK_MS = Math.max(120, STEP_REVEAL_MIN_MS / 3);

interface PacedReveal {
  /** Maps a step's real projection status to what the document should show: a
   * terminal step waits at 'idle' until released, flashes 'active' as it is
   * released, then settles to its real status. */
  displayStatus: (nodeId: string, real: StepVisualStatus) => StepVisualStatus;
  /** The step currently being released (rendered active), for scroll-follow;
   * null when the queue is empty. */
  activeDisplayId: string | null;
}

/**
 * The paced-reveal queue. As steps reach a terminal status they are enqueued in
 * document order and released one at a time at STEP_REVEAL_MIN_MS spacing; the
 * released step renders 'active' (breathing) for one interval before settling.
 * A terminal step that arrives alone once the floor has already elapsed (a slow
 * node finishing, or a manual Step click between which the user paused far
 * longer than the floor) is revealed immediately — the queue never adds latency
 * on top of real latency. reduced-motion keeps the sequencing (it is
 * information, not decoration); the breathing ring itself is stilled by CSS.
 */
function usePacedReveal(orderedStepIds: string[], projection: RunbookProjection, runId: string | null): PacedReveal {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);

  const queueRef = useRef<string[]>([]);
  const enqueuedRef = useRef<Set<string>>(new Set());
  const activeRef = useRef<string | null>(null);
  const lastReleaseRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runIdRef = useRef<string | null>(runId);

  const drain = useRef<() => void>(() => {});
  drain.current = () => {
    timerRef.current = null;
    const now = Date.now();
    const wait = lastReleaseRef.current + STEP_REVEAL_MIN_MS - now;
    if (wait > 0) {
      timerRef.current = setTimeout(() => drain.current(), wait);
      return;
    }
    // The step released last interval has now breathed long enough — settle it.
    if (activeRef.current) {
      const done = activeRef.current;
      activeRef.current = null;
      setRevealed((prev) => new Set(prev).add(done));
    }
    if (queueRef.current.length === 0) {
      setActiveId(null);
      return;
    }
    const next = queueRef.current.shift()!;
    activeRef.current = next;
    lastReleaseRef.current = now;
    setActiveId(next);
    timerRef.current = setTimeout(() => drain.current(), STEP_REVEAL_MIN_MS);
  };

  const schedule = () => {
    if (timerRef.current) return; // already draining
    if (queueRef.current.length === 0 && activeRef.current === null) return;
    timerRef.current = setTimeout(() => drain.current(), 0);
  };

  useEffect(() => {
    const now = Date.now();
    // New run (or reset): forget the previous fill, and stamp the release clock
    // to now so the first burst paces from step one rather than dumping instantly.
    if (runId !== runIdRef.current) {
      runIdRef.current = runId;
      queueRef.current = [];
      enqueuedRef.current = new Set();
      activeRef.current = null;
      lastReleaseRef.current = now;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setRevealed(new Set());
      setActiveId(null);
    }

    for (const id of orderedStepIds) {
      const st = projection.steps.get(id)?.status;
      if ((st === 'ran' || st === 'failed') && !enqueuedRef.current.has(id)) {
        enqueuedRef.current.add(id);
        const idle = queueRef.current.length === 0 && activeRef.current === null;
        if (idle && now - lastReleaseRef.current >= STEP_REVEAL_MIN_MS) {
          // Straggler: floor already elapsed, reveal with no artificial flash.
          lastReleaseRef.current = now;
          setRevealed((prev) => new Set(prev).add(id));
        } else {
          queueRef.current.push(id);
        }
      }
    }
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projection, runId, orderedStepIds]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const displayStatus = (nodeId: string, real: StepVisualStatus): StepVisualStatus => {
    if (activeId === nodeId) return 'active';
    if (real === 'active') return 'active'; // engine is genuinely mid-flight here
    if (real === 'ran' || real === 'failed') return revealed.has(nodeId) ? real : 'idle';
    return real;
  };

  return { displayStatus, activeDisplayId: activeId };
}

/**
 * Loop mini-dots fill at their own gentle pace: terminal iterations are
 * revealed one tick at a time so a completed loop sweeps rather than snapping.
 * Returns a display copy of `statuses` with not-yet-revealed terminal dots held
 * at 'pending' and the one being revealed shown 'running'.
 */
function usePacedLoopStatuses(
  statuses: ('done' | 'failed' | 'pending' | 'running')[],
  resetKey: string,
): ('done' | 'failed' | 'pending' | 'running')[] {
  const terminalIdx = useMemo(
    () => statuses.map((s, i) => (s === 'done' || s === 'failed' ? i : -1)).filter((i) => i >= 0),
    [statuses],
  );
  const [revealedCount, setRevealedCount] = useState(0);
  const prevResetKey = useRef(resetKey);
  if (resetKey !== prevResetKey.current) {
    prevResetKey.current = resetKey;
    // Reset synchronously during render so a fresh run never flashes the old fill.
    if (revealedCount !== 0) setRevealedCount(0);
  }

  useEffect(() => {
    if (revealedCount >= terminalIdx.length) return;
    const t = setTimeout(() => setRevealedCount((c) => c + 1), LOOP_REVEAL_TICK_MS);
    return () => clearTimeout(t);
  }, [revealedCount, terminalIdx.length]);

  const revealedSet = new Set(terminalIdx.slice(0, revealedCount));
  const releasingIdx = terminalIdx[revealedCount];
  return statuses.map((s, i) => {
    if (s === 'running') return 'running';
    if (s === 'done' || s === 'failed') {
      if (revealedSet.has(i)) return s;
      if (i === releasingIdx) return 'running';
      return 'pending';
    }
    return s;
  });
}

/** Flattens the runbook tree to its step node ids in document (render) order —
 * the order terminal steps are released in. */
function flattenStepIds(items: RunbookItem[], out: string[] = []): string[] {
  for (const item of items) {
    if (item.kind === 'step') out.push(item.nodeId);
    else flattenStepIds(item.items, out);
  }
  return out;
}

/** Crossfades text changes instead of snapping: fade the old text out, swap
 * the displayed string once it's invisible, then let the caller's own
 * transition fade it back in via the returned `fading` flag. */
function useCrossfadeText(text: string): { display: string; fading: boolean } {
  const [display, setDisplay] = useState(text);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (text === display) return;
    setFading(true);
    const timeout = setTimeout(() => {
      setDisplay(text);
      setFading(false);
    }, CROSSFADE_MS);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return { display, fading };
}

/** Shared read-only context threaded through the item tree — avoids re-deriving
 * the same store values at every nesting level. */
interface RunbookCtx {
  projection: RunbookProjection;
  run: WorkflowRun | null;
  /** Reset key for per-group local state (manual overrides, loop chip
   * selection): `${flow.id}:${run?.id}`. Flow id is part of the key because
   * this view isn't remounted per flow and group keys are plain node ids that
   * collide across flows — without it, toggles/chips on flow A bleed into
   * flow B whenever the run identity alone doesn't change. */
  resetKey: string;
  selectedNodeId: string | null;
  selectNode: (id: string | null) => void;
  /** Registers/unregisters a step row's DOM element for the scroll-band
   * auto-scroll effect, keyed by nodeId. */
  registerRow: (nodeId: string, el: HTMLElement | null) => void;
  /** Selected loop iteration index for the nearest enclosing loop group, set
   * by clicking a rail chip; undefined outside a loop or before any chip is
   * clicked, in which case rows show the live projection as normal. */
  loopIterIndex?: number;
  /** Simple register renders outcomes only; technical also reveals type names. */
  register: 'simple' | 'technical';
  /** Present when this flow is an HTTP operation: the request contract, rendered
   *  in place of the entry Input node's normal row so step 1 reads as the route. */
  request?: {
    inputNodeId: string;
    method: string;
    path: string;
    fields: { name: string; type?: string; required?: boolean }[];
    /** Input node defaults, used to build the example request body (technical). */
    defaults: Record<string, unknown>;
  };
  /** Maps a step's real projection status through the paced-reveal queue to the
   * status the document should actually show right now. */
  displayStatus: (nodeId: string, real: StepVisualStatus) => StepVisualStatus;
  /** Header toggle: expand every branch group regardless of taken state. */
  expandAll: boolean;
}

/** The 9px status square: idle is an empty outline, ran/failed fill solid,
 * active fills and breathes with the ember pulse, skipped dims. */
function StatusRing({ status }: { status: StepVisualStatus }) {
  return (
    <span
      className={cn(
        'flex size-[9px] shrink-0 items-center justify-center rounded-[3px] border border-border',
        status === 'ran' && 'border-success bg-success',
        status === 'failed' && 'border-destructive bg-destructive',
        status === 'active' && 'ember-step-active border-highlight bg-highlight',
        status === 'skipped' && 'opacity-40',
      )}
    >
      {status === 'ran' && <span className="text-[7px] leading-none font-bold text-background">✓</span>}
    </span>
  );
}

/** Trace-kind badge labels + colors for the technical register. Colors are the
 * brief's fixed palette (db blue, http violet, llm gold); compute stays muted.
 * Borders render at 35% alpha so the chip reads as a quiet annotation, not a
 * button. */
const KIND_LABEL: Record<string, string> = { db: 'SQL', http: 'HTTP', llm: 'LLM', compute: 'FN' };
const KIND_COLOR: Record<string, string> = { db: '#8fb8d8', http: '#c9a6e8', llm: '#d8c88f' };

const KIND_TITLE: Record<string, string> = {
  db: 'Database query',
  http: 'HTTP call',
  llm: 'LLM call',
  compute: 'Pure function',
};

/** Small label for the "what it calls" line, keyed off kind. */
const KIND_DETAIL_LABEL: Record<string, string> = {
  db: 'query',
  http: 'endpoint',
  llm: 'model',
  compute: 'detail',
};

/** Trace-kind badge with a hover card: the quiet chip expands into the step's
 * full technical story — mechanism (full node description), the live trace
 * line (receipt · exact duration · IO keys), and effect semantics. CSS-only
 * hover; the card ignores pointer events so it never traps the mouse. */
function KindBadge({
  kind,
  typeName,
  tech,
  mutation,
  error,
}: {
  kind: 'db' | 'http' | 'llm' | 'compute';
  typeName: string;
  tech?: string;
  mutation?: boolean;
  error?: string;
}) {
  const registry = useBuilderStore((st) => st.registry);
  const definition = registry.has(typeName) ? registry.get(typeName).definition : undefined;
  const label = KIND_LABEL[kind];
  const color = KIND_COLOR[kind];
  const chip =
    kind === 'compute' ? (
      <span className="rounded border border-border/35 px-1 font-mono text-[8.5px] leading-tight text-muted-foreground">
        {label}
      </span>
    ) : (
      <span
        className="rounded border px-1 font-mono text-[8.5px] leading-tight"
        style={{ color, borderColor: `${color}59` }}
      >
        {label}
      </span>
    );
  return (
    <span className="group/badge relative shrink-0 cursor-help">
      {chip}
      <span className="pointer-events-none absolute top-full left-0 z-50 mt-1.5 hidden w-[380px] rounded-lg border border-border bg-card p-3 shadow-[0_18px_48px_rgb(0_0_0/0.55)] group-hover/badge:block">
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-[9px] tracking-wide" style={kind !== 'compute' ? { color } : undefined}>
            {KIND_TITLE[kind]}
          </span>
          <span className="font-mono text-[10.5px] text-foreground">{typeName}</span>
        </span>
        {definition?.description && (
          <span className="mt-1.5 block text-[11.5px] leading-relaxed text-muted-foreground">
            {definition.description}
          </span>
        )}
        {definition?.traceDetail && (
          <span className="mt-2 block">
            <span
              className="mr-1.5 font-mono text-[8.5px] tracking-wide uppercase"
              style={kind !== 'compute' ? { color } : undefined}
            >
              {KIND_DETAIL_LABEL[kind]}
            </span>
            <span className="font-mono text-[10.5px] leading-relaxed break-words text-foreground/90">
              {definition.traceDetail}
            </span>
          </span>
        )}
        {tech && (
          <span className="mt-2 block border-t border-border/60 pt-2 font-mono text-[10.5px] leading-relaxed text-foreground/90">
            {tech}
          </span>
        )}
        {error && (
          <span className="mt-1.5 block font-mono text-[10.5px] text-destructive-foreground">{error}</span>
        )}
        {mutation && (
          <span className="mt-1.5 block text-[10px] text-warn">
            ⚡ mutation — dry-runs under safe mode, executes live otherwise
          </span>
        )}
      </span>
    </span>
  );
}

function StepRow({ step, ctx }: { step: RunbookStep; ctx: RunbookCtx }) {
  const registry = useBuilderStore((s) => s.registry);
  const proj = ctx.projection.steps.get(step.nodeId);
  const status = ctx.displayStatus(step.nodeId, proj?.status ?? 'idle');
  const executed = status === 'ran' || status === 'failed' || status === 'active';
  const technical = ctx.register === 'technical';

  // Result and display nodes surface their collected payload right in the
  // document — an inline expandable JSON box, so the run's actual result is
  // readable without hopping to the Inspector. Auto-opens once it has run.
  // Result (internal terminus), Response (HTTP terminus — its { status, body }
  // is the operation's resulting JSON), and display-tagged nodes surface their
  // output inline, auto-expanding once they run.
  const showsResult =
    step.typeName === 'Result' ||
    step.typeName === 'Response' ||
    (registry.has(step.typeName) && (registry.get(step.typeName).definition.tags?.includes('display') ?? false));
  const resultState = ctx.run?.nodeStates[step.nodeId];
  const resultValue = resultState?.output ?? resultState?.input;
  const hasResult = showsResult && resultValue !== undefined;
  const [resultOpen, setResultOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const wasExecuted = useRef(false);
  if (hasResult && (status === 'ran' || status === 'failed') && !wasExecuted.current) {
    wasExecuted.current = true;
    if (!resultOpen) setResultOpen(true);
  }
  if (!hasResult && wasExecuted.current) wasExecuted.current = false;

  // The outcome column: simple speaks the human outcome (last info log, else
  // the step's description); technical speaks the projection's `tech` line (type
  // · ms · in→out, `#N` receipt-prefixed) once the step has run. Before it runs,
  // technical falls back to the description rather than the bare type name —
  // repeating the type here would just double the type-mono badge beside the name.
  // A loop chip is selected and this row lives in that loop's body with a
  // recorded execution for the chosen iteration: show that iteration's data
  // instead of the live (latest) projection. Falls through to the normal
  // live text otherwise (e.g. iteration index has no execution yet).
  let text = technical
    ? executed
      ? proj?.tech ?? step.typeName
      : step.description || step.typeName
    : executed
      ? proj?.outcome || step.simpleDescription
      : step.simpleDescription;
  let destructive = status === 'failed';
  if (ctx.loopIterIndex != null) {
    const exec = ctx.run?.nodeStates[step.nodeId]?.executions?.[ctx.loopIterIndex];
    if (exec) {
      text = iterationSummary(exec);
      destructive = !!exec.error;
    }
  }

  const { display, fading } = useCrossfadeText(text);
  const selected = ctx.selectedNodeId === step.nodeId;

  // For an HTTP operation, the entry Input node renders as the request contract:
  // method + path, then the accepted fields (required marked). Register-aware —
  // simple shows plain field names, technical adds `:type`. Keeps the row's
  // number, status ring, and selection so it's still step 1 of the run.
  const isRequest = ctx.request?.inputNodeId === step.nodeId;
  if (isRequest && ctx.request) {
    const req = ctx.request;
    const methodColor = KIND_COLOR.http;
    // Technical only: an example request body. Use a real scalar default when
    // present, but replace internal {$env}/{$secret} refs (and absent fields)
    // with a `<type>` placeholder — a client would POST a value, not the ref.
    const exampleBody = Object.fromEntries(
      req.fields.map((f) => {
        const d = req.defaults[f.name];
        const isRef = !!d && typeof d === 'object' && !Array.isArray(d) && ('$env' in d || '$secret' in d);
        const usable = f.name in req.defaults && !isRef;
        return [f.name, usable ? d : `<${f.type ?? 'any'}>`];
      }),
    );
    return (
      <>
        <div
          ref={(el) => ctx.registerRow(step.nodeId, el)}
          role="button"
          tabIndex={0}
          onClick={() => ctx.selectNode(step.nodeId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              ctx.selectNode(step.nodeId);
            }
          }}
          className={cn(
            '-mx-2.5 flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-highlight/5',
            selected && 'bg-highlight/15 ring-2 ring-inset ring-highlight shadow-lg',
          )}
        >
          <span className="w-11 shrink-0 text-right font-mono text-[10.5px] text-muted-foreground">{step.number}</span>
          <StatusRing status={status} />
          <span
            className="shrink-0 rounded border px-1.5 py-px font-mono text-[10px] font-semibold tracking-wide"
            style={{ color: methodColor, borderColor: `${methodColor}59` }}
          >
            {req.method}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">{req.path}</span>
          {req.fields.length > 0 && (
            <span className="shrink-0 text-[10px] uppercase tracking-widest text-muted-foreground">
              {req.fields.length} field{req.fields.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {/* Technical: reveal the request shape as JSON on demand. Simple stays
            clean — just the endpoint above. */}
        {technical && req.fields.length > 0 && (
          <div className="ml-[54px] mb-1">
            <button
              type="button"
              onClick={() => setRequestOpen((o) => !o)}
              aria-expanded={requestOpen}
              className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRightIcon className={cn('size-3 transition-transform', requestOpen && 'rotate-90')} />
              Request
            </button>
            {requestOpen && (
              <div className="mt-1">
                <Json value={exampleBody} maxHeight={320} />
              </div>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <>
    <div
      ref={(el) => ctx.registerRow(step.nodeId, el)}
      role="button"
      tabIndex={0}
      onClick={() => ctx.selectNode(step.nodeId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          ctx.selectNode(step.nodeId);
        }
      }}
      className={cn(
        '-mx-2.5 flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-highlight/5',
        selected && 'bg-highlight/15 font-medium ring-2 ring-inset ring-highlight shadow-lg',
      )}
    >
      <span className="w-11 shrink-0 text-right font-mono text-[10.5px] text-muted-foreground">{step.number}</span>
      <StatusRing status={status} />
      <span className="shrink-0 truncate text-[13.5px]" style={{ fontWeight: 550 }}>
        {step.label}
      </span>
      {technical && step.traceKind && (
        <KindBadge
          kind={step.traceKind}
          typeName={step.typeName}
          tech={proj?.tech}
          mutation={step.mutation}
          error={status === 'failed' ? ctx.run?.nodeStates[step.nodeId]?.error : undefined}
        />
      )}
      <span className={cn('shrink-0 font-mono text-[9.5px] text-muted-foreground', !technical && 'hidden')}>
        {step.typeName}
      </span>
      {step.mutation && (
        <span className="shrink-0 text-[11px] text-warn" title="Mutation: has side effects">
          ⚡
        </span>
      )}
      {(() => {
        if (!technical) return null;
        const attempts = ctx.run?.nodeStates[step.nodeId]?.attempts;
        return attempts !== undefined && attempts > 1 ? (
          <span
            className="shrink-0 rounded-sm border border-warn/40 px-1 font-mono text-[10px] text-warn"
            title={`Implementation retried — ${attempts} attempts total`}
          >
            retried ×{attempts - 1}
          </span>
        ) : null;
      })()}
      {ctx.run?.nodeStates[step.nodeId]?.mocked && (
        <span
          className="shrink-0 rounded-sm border border-warn/40 px-1 font-mono text-[10px] text-warn"
          title="This node returned its scenario mock — nothing executed."
        >
          mocked
        </span>
      )}
      {step.subflow && (
        <span className="shrink-0 rounded border border-dashed border-border px-1 text-[10px] text-muted-foreground">
          ↳ subflow
        </span>
      )}
      {step.decisionArms && step.decisionArms.length > 0 && (
        <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
          ⑂ {step.decisionArms.length}
        </span>
      )}
      <span
        className={cn(
          'min-w-0 flex-1 truncate transition-opacity ease-out',
          technical ? 'font-mono text-[11px]' : 'text-[12.5px]',
          destructive ? 'text-destructive' : status === 'active' ? 'text-highlight' : 'text-muted-foreground',
          !executed && 'opacity-55',
          fading && 'opacity-0',
        )}
        style={{ transitionDuration: `${CROSSFADE_MS}ms` }}
      >
        {display}
      </span>
      {status === 'ran' && proj?.durationMs != null && (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{formatDuration(proj.durationMs)}</span>
      )}
    </div>
    {hasResult && (
      <div className="ml-[54px] mb-1">
        <button
          type="button"
          onClick={() => setResultOpen((o) => !o)}
          aria-expanded={resultOpen}
          className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRightIcon className={cn('size-3 transition-transform', resultOpen && 'rotate-90')} />
          Result
        </button>
        {resultOpen && (
          <div className="mt-1">
            <Json value={resultValue} maxHeight={320} />
          </div>
        )}
      </div>
    )}
    </>
  );
}

function BranchGroupRow({ group, ctx }: { group: RunbookBranchGroup; ctx: RunbookCtx }) {
  const armKey = `${group.ownerId}::${group.arm}`;
  const arm = ctx.projection.arms.get(armKey);
  const taken = arm?.takenNow ?? false;

  // A sibling arm of the same owner took the run and this one didn't — dim
  // and collapse it (the panel-choreography feel: only the taken path stays
  // lit), unless the user explicitly opened it.
  const dimmed = useMemo(
    () =>
      !taken &&
      [...ctx.projection.arms.entries()].some(
        ([key, a]) => key !== armKey && key.startsWith(`${group.ownerId}::`) && a.takenNow,
      ),
    [ctx.projection.arms, armKey, group.ownerId, taken],
  );

  // Taken groups start open; others start closed. A group that becomes taken
  // mid-run force-opens unless the user just closed it; a dimmed sibling
  // force-collapses unless the user just opened it. Both overrides — and the
  // open/closed baseline itself — forget themselves whenever the reset key
  // changes (new run OR flow switch: node ids collide across flows).
  const [openState, setOpen] = useState(taken);
  const open = ctx.expandAll || openState;
  const wasTaken = useRef(taken);
  const manualOverride = useRef<'open' | 'closed' | null>(null);
  const prevResetKey = useRef(ctx.resetKey);

  useEffect(() => {
    if (ctx.resetKey !== prevResetKey.current) {
      prevResetKey.current = ctx.resetKey;
      manualOverride.current = null;
      wasTaken.current = taken;
      setOpen(taken);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.resetKey]);

  useEffect(() => {
    if (taken && !wasTaken.current && manualOverride.current !== 'closed') setOpen(true);
    wasTaken.current = taken;
  }, [taken]);

  useEffect(() => {
    if (dimmed && manualOverride.current !== 'open') setOpen(false);
  }, [dimmed]);

  const toggleOpen = () => {
    setOpen((o) => {
      manualOverride.current = o ? 'closed' : 'open';
      return !o;
    });
  };

  return (
    <div className="py-0.5">
      <div
        role="button"
        tabIndex={0}
        onClick={toggleOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleOpen();
          }
        }}
        className={cn(
          '-mx-2.5 flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1 transition-opacity duration-[400ms]',
          (dimmed || (!open && !taken)) && 'opacity-50',
        )}
      >
        <span className="w-11 shrink-0 text-right font-mono text-[10.5px] text-muted-foreground">{group.number}</span>
        <ChevronRightIcon
          className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <span className="min-w-0 truncate text-[13px]">
          If <span className="font-medium text-highlight">{group.arm}</span>:
        </span>
        {taken && (
          <Badge variant="highlight" className="ml-auto shrink-0 text-[9px]">
            this run
          </Badge>
        )}
      </div>
      {open && (
        <div className={cn('ml-[54px] border-l-[1.5px] pl-3', taken ? 'border-highlight/40' : 'border-border')}>
          <RunbookItems items={group.items} ctx={ctx} />
        </div>
      )}
    </div>
  );
}

const loopDotColor: Record<string, string> = {
  pending: 'bg-muted-foreground/40',
  done: 'bg-success',
  failed: 'bg-destructive',
  running: 'bg-highlight motion-safe:animate-pulse',
};

function LoopGroupRow({ group, ctx }: { group: RunbookLoopGroup; ctx: RunbookCtx }) {
  const loop = ctx.projection.loops.get(group.forEachId);
  const realStatuses = loop?.statuses ?? [];
  // Mini-dots fill at the loop pace; the rail's presence and chip selection key
  // off the real statuses so a chip is clickable the moment its iteration ran.
  const statuses = usePacedLoopStatuses(realStatuses, ctx.resetKey);
  // Chip rail only appears once at least one iteration has actually executed
  // (not merely counted from an expected total) — dots alone carry the
  // "nothing's happened yet" state.
  const hasExecutions = realStatuses.some((s) => s !== 'pending');

  // Which iteration chip is selected — swaps the body rows below to that
  // execution's data. Clears whenever the reset key changes (new run OR flow
  // switch: forEach ids collide across flows).
  const [selectedIteration, setSelectedIteration] = useState<number | null>(null);
  const prevResetKey = useRef(ctx.resetKey);
  useEffect(() => {
    if (ctx.resetKey !== prevResetKey.current) {
      prevResetKey.current = ctx.resetKey;
      setSelectedIteration(null);
    }
  }, [ctx.resetKey]);

  const bodyCtx: RunbookCtx = { ...ctx, loopIterIndex: selectedIteration ?? undefined };

  // The array being swept lives on the ForEach node's input; each chip is one
  // element. Show the *current* element's value subtly beside the rail so you
  // can read exactly what's being looped right now — the selected chip if the
  // user picked one, else the running iteration, else the last that ran.
  const feInput = ctx.run?.nodeStates[group.forEachId]?.input as Record<string, unknown> | undefined;
  const items = Array.isArray(feInput?.items) ? (feInput!.items as unknown[]) : undefined;
  const runningIdx = statuses.indexOf('running');
  let lastRanIdx = -1;
  for (let i = statuses.length - 1; i >= 0; i--) {
    if (statuses[i] === 'done' || statuses[i] === 'failed') { lastRanIdx = i; break; }
  }
  const activeIdx = selectedIteration ?? (runningIdx >= 0 ? runningIdx : lastRanIdx);
  const activeItem = items && activeIdx >= 0 ? items[activeIdx] : undefined;
  const activeItemText = activeItem === undefined ? '' : compactValue(activeItem);

  return (
    <div className="py-0.5">
      <div className="-mx-2.5 flex items-center gap-2.5 rounded-lg px-2.5 py-1">
        <span className="w-11 shrink-0 text-right font-mono text-[10.5px] text-muted-foreground">{group.number}</span>
        <span className="min-w-0 truncate text-[13px]">
          For each — <span className="font-medium">{group.label}</span> ({loop?.count ?? 0})
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {statuses.map((s, i) => (
            <span key={i} className={cn('size-[5px] shrink-0 rounded-full', loopDotColor[s])} />
          ))}
        </div>
      </div>
      <div className="ml-[54px] border-l-[1.5px] border-border pl-3">
        {hasExecutions && (
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pt-1">
            <div className="flex flex-wrap items-center gap-1">
              {statuses.map((s, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSelectedIteration(i)}
                  className={cn(
                    'flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground hover:border-highlight/40',
                    (selectedIteration === i || (selectedIteration === null && i === activeIdx)) &&
                      'border-highlight/60 text-foreground',
                  )}
                >
                  {i + 1}
                  <span className={cn('size-1.5 rounded-full', loopDotColor[s])} />
                </button>
              ))}
            </div>
            {activeItemText && (
              <span
                className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/60"
                title={typeof activeItem === 'string' ? activeItem : JSON.stringify(activeItem, null, 2)}
              >
                {activeItemText}
              </span>
            )}
          </div>
        )}
        <RunbookItems items={group.items} ctx={bodyCtx} />
      </div>
    </div>
  );
}

/** One-line, ~80-char preview of a loop item — a bare string as-is, anything
 * structured as compact JSON — for the subtle "what's looping now" annotation. */
function compactValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function RunbookItems({ items, ctx }: { items: RunbookItem[]; ctx: RunbookCtx }) {
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item) => {
        if (item.kind === 'step') return <StepRow key={item.nodeId} step={item} ctx={ctx} />;
        if (item.kind === 'branch') {
          return <BranchGroupRow key={`${item.ownerId}::${item.arm}`} group={item} ctx={ctx} />;
        }
        return <LoopGroupRow key={item.forEachId} group={item} ctx={ctx} />;
      })}
    </div>
  );
}

function RunbookHeader({
  name,
  environment,
  subtitle,
  expandAll,
  onToggleExpandAll,
}: {
  name: string;
  environment?: string;
  subtitle: string;
  expandAll: boolean;
  onToggleExpandAll: () => void;
}) {
  return (
    <div className="mb-6">
      <h1 className="text-[22px] font-bold tracking-tight">{name}</h1>
      <div className="mt-1.5 flex items-center gap-2 text-[12px] text-muted-foreground">
        {environment && (
          <Badge variant="outline" className="text-[9px] uppercase">
            {environment}
          </Badge>
        )}
        <span className="truncate">{subtitle}</span>
        <button
          type="button"
          onClick={onToggleExpandAll}
          title={expandAll ? 'Collapse branches' : 'Expand all branches'}
          aria-label={expandAll ? 'Collapse branches' : 'Expand all branches'}
          aria-pressed={expandAll}
          className={cn(
            'ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors',
            expandAll ? 'bg-secondary/60 text-foreground' : 'text-muted-foreground hover:bg-secondary/40 hover:text-foreground',
          )}
        >
          {expandAll ? <ChevronsDownUpIcon className="size-3.5" /> : <ChevronsUpDownIcon className="size-3.5" />}
        </button>
      </div>
    </div>
  );
}

/** Calm end-of-document run readout. While the reveal queue is still draining
 * (`filling`) it stays "Running" even though the engine already finished — the
 * document isn't done until the last step has been read out. */
function RunbookFooter({ run, filling }: { run: WorkflowRun; filling: boolean }) {
  const live = run.status === 'running' || filling;
  const ran = Object.values(run.nodeStates).filter(
    (s) => s.status === 'succeeded' || s.status === 'failed',
  ).length;
  const label = live
    ? 'Running'
    : run.status === 'succeeded'
      ? 'Completed'
      : run.status === 'failed'
        ? 'Failed'
        : 'Cancelled';
  const tone = live
    ? 'text-highlight'
    : run.status === 'failed'
      ? 'text-destructive'
      : run.status === 'succeeded'
        ? 'text-success'
        : 'text-muted-foreground';
  return (
    <div className="mt-8 flex items-center gap-2 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
      <span className={cn('size-1.5 shrink-0 rounded-full bg-current', tone, live && 'motion-safe:animate-pulse')} />
      <span className={cn('font-medium', tone)}>{label}</span>
      <span className="font-mono text-[10.5px] text-muted-foreground/80">
        {ran} step{ran === 1 ? '' : 's'} executed
      </span>
    </div>
  );
}

/**
 * The executable runbook: a linear document rendering of the flow — numbered
 * steps, branch groups with taken/coverage state, and loop groups with an
 * iteration rail — the primary way to read a flow.
 * Row clicks drive selection; the Inspector (not a second detail panel here)
 * shows the clicked node's full state.
 */
/** The canvas holding pattern shown while the agent scaffolds a just-created
 *  operation. The stub (name + route) is already selected; this stands in for
 *  the empty body until the agent writes the flow, which then loads live. */
function BuildingHolding({ route }: { route?: string }) {
  return (
    <div className="mt-10 flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-highlight/30 bg-highlight/[0.03] px-6 py-14 text-center">
      <span className="ember-step-active flex size-11 items-center justify-center rounded-full bg-highlight/15 text-highlight">
        <SparklesIcon className="size-5" />
      </span>
      <div className="flex flex-col gap-1">
        <span className="text-[14px] font-medium text-foreground">Building this operation…</span>
        <span className="max-w-sm text-[12.5px] leading-relaxed text-muted-foreground">
          The agent is writing the flow. It appears here live the moment it’s done — you can watch its
          progress in the Agent panel.
        </span>
      </div>
      {route && (
        <span className="rounded-md border border-border/60 bg-secondary/40 px-2 py-1 font-mono text-[11.5px] text-muted-foreground">
          {route}
        </span>
      )}
      <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-highlight/80">
        <span className="size-1.5 animate-pulse rounded-full bg-highlight" />
        waiting for the agent
      </span>
    </div>
  );
}

export function RunbookView({ register = 'simple' }: { register?: 'simple' | 'technical' } = {}) {
  const flow = useBuilderStore((s) => s.flow);
  const registry = useBuilderStore((s) => s.registry);
  const buildingOperationId = useBuilderStore((s) => s.buildingOperationId);
  const run = useBuilderStore((s) => s.run);
  const logs = useBuilderStore((s) => s.logs);
  const runHistory = useBuilderStore((s) => s.runHistory);
  const selectedNodeId = useBuilderStore((s) => s.selectedNodeId);
  const selectNode = useBuilderStore((s) => s.selectNode);

  const doc = useMemo(() => buildRunbook(flow, registry), [flow, registry]);
  const projection = useMemo(
    () => projectRunbook(doc, run, logs, runHistory, flow.id),
    [doc, run, logs, runHistory],
  );

  // Paced reveal: the document fills at a readable rhythm even when the engine
  // finished in one frame. displayStatus trails the real projection; the run is
  // still "filling" while activeDisplayId is non-null.
  const orderedStepIds = useMemo(() => flattenStepIds(doc.items), [doc]);
  const { displayStatus, activeDisplayId } = usePacedReveal(orderedStepIds, projection, run?.id ?? null);

  // ── calm auto-scroll: keep the active row inside the 20%-75% band of the
  // scroll container, at most once every SCROLL_MIN_GAP_MS. ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandAll, setExpandAll] = useState(false);
  const rowRefsMap = useRef(new Map<string, HTMLElement>());
  const registerRow = (nodeId: string, el: HTMLElement | null) => {
    if (el) rowRefsMap.current.set(nodeId, el);
    else rowRefsMap.current.delete(nodeId);
  };

  // Scroll follows the *display* cursor ONLY while there is live motion — the
  // paced reveal draining, or an actively running (incl. stepped) run. At rest
  // the document never repositions itself: the reader owns the scrollbar.
  const activeNodeId = useMemo(() => {
    if (activeDisplayId) return activeDisplayId;
    if (run?.status !== 'running') return null;
    const runningId = Object.entries(run.nodeStates).find(([, s]) => s.status === 'running')?.[0];
    // Stepped runs sit 'running' between steps with no running node — follow
    // the step cursor (selection tracks the just-executed step).
    return runningId ?? selectedNodeId;
  }, [activeDisplayId, run, selectedNodeId]);

  const activeNodeIdRef = useRef(activeNodeId);
  activeNodeIdRef.current = activeNodeId;

  // Manual scroll input detaches the follow for the rest of this run — the
  // wheel always beats the camera. A new run re-attaches.
  const detachedRef = useRef(false);
  useEffect(() => {
    detachedRef.current = false;
  }, [run?.id]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const detach = () => {
      detachedRef.current = true;
    };
    el.addEventListener('wheel', detach, { passive: true });
    el.addEventListener('touchmove', detach, { passive: true });
    return () => {
      el.removeEventListener('wheel', detach);
      el.removeEventListener('touchmove', detach);
    };
  }, []);

  useEffect(() => {
    let lastScrollAt = 0;
    const tick = setInterval(() => {
      const container = scrollRef.current;
      const id = activeNodeIdRef.current;
      if (!container || !id || detachedRef.current) return;
      const row = rowRefsMap.current.get(id);
      if (!row) return;
      const containerRect = container.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const relativeTop = (rowRect.top - containerRect.top) / containerRect.height;
      if (relativeTop >= 0.2 && relativeTop <= 0.75) return; // already in the calm band
      const now = Date.now();
      if (now - lastScrollAt < SCROLL_MIN_GAP_MS) return;
      lastScrollAt = now;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 250);
    return () => clearInterval(tick);
  }, []);

  // When the flow is an HTTP operation, the entry Input node IS the request
  // contract — surface method/path/fields there instead of a generic step.
  const request = useMemo(() => {
    if (!flow.http) return undefined;
    const entry = flow.nodes.find((n) => n.type === 'Input');
    if (!entry) return undefined;
    const rawFields = (entry.config?.fields as { name: string; type?: string; required?: boolean }[] | undefined) ?? [];
    return {
      inputNodeId: entry.id,
      method: flow.http.method,
      path: flow.http.path,
      fields: rawFields.filter((f) => f && typeof f.name === 'string'),
      defaults: (entry.config?.defaults as Record<string, unknown> | undefined) ?? {},
    };
  }, [flow]);

  const ctx: RunbookCtx = {
    projection,
    run,
    resetKey: `${flow.id}:${run?.id ?? 'none'}`,
    selectedNodeId,
    selectNode,
    registerRow,
    register,
    displayStatus,
    expandAll,
    request,
  };
  const subtitle = flow.folder ?? `${flow.nodes.length} step${flow.nodes.length === 1 ? '' : 's'}`;
  const building = buildingOperationId === flow.id;

  return (
    <div ref={scrollRef} className="h-full min-h-0 overflow-y-auto bg-background">
      <div className="mx-auto max-w-[800px] px-4 pt-[26px] pb-[140px]">
        <RunbookHeader
          name={flow.name}
          environment={flow.environment}
          subtitle={subtitle}
          expandAll={expandAll}
          onToggleExpandAll={() => setExpandAll((v) => !v)}
        />
        {building ? (
          <BuildingHolding route={flow.http ? `${flow.http.method} ${flow.http.path}` : undefined} />
        ) : (
          <>
            <RunbookItems items={doc.items} ctx={ctx} />
            {run && <RunbookFooter run={run} filling={activeDisplayId !== null} />}
          </>
        )}
      </div>
    </div>
  );
}
