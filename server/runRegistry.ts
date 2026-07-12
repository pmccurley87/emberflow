import type {
  LogLine, NodeExecutionSample, NodeRunState,
  WorkflowDefinition, WorkflowRun,
} from '../src/engine';
import { InMemoryTraceSink, startRun, type FlowRun, type NodeRegistry } from '../src/engine';
import { createDefaultRegistry } from '../src/nodes';
import { redactSecrets } from './redact';
import { makeSubflowRunner } from './subflowRunner';

/** SSE-shaped events, mirroring ExecutorEvents 1:1. */
export type RunEvent =
  | { type: 'nodeState'; nodeId: string; state: NodeRunState }
  | { type: 'log'; line: LogLine }
  | {
      type: 'finished';
      run: WorkflowRun;
      /** Present only when this run is an error-handler invocation: the
       *  workflowId of the run whose failure fired it. */
      errorHandler?: { firedBy: string };
    };

type Listener = (event: RunEvent) => void;

interface LiveRun {
  handle: FlowRun;
  buffer: RunEvent[];
  listeners: Set<Listener>;
  finished: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const RETAIN_FINISHED_MS = 10 * 60 * 1000; // 10 minutes
const MAX_LIVE_RUNS = 100;

/** Manages live runs: buffers engine events per run and fans them out to SSE subscribers. */
export class RunRegistry {
  private readonly registry: NodeRegistry;
  private readonly runs = new Map<string, LiveRun>();
  readonly sink = new InMemoryTraceSink();

  /**
   * @param loadFlow Resolves a workflow by id for Subflow nodes (server hosts
   *   this via flowStore.load). Absent → Subflow nodes fail with a clear message.
   * @param registry Execution registry to run against. Defaults to the
   *   built-in node set; project mode passes one preloaded with consumer nodes.
   * @param errorOperation Op id (resolved via `loadFlow`, same as Subflow
   *   nodes) to run whenever a run finishes with status 'failed'. Best-effort:
   *   never throws, never affects the failed run. Absent → disabled.
   */
  constructor(
    private readonly loadFlow?: (id: string) => WorkflowDefinition | undefined,
    registry: NodeRegistry = createDefaultRegistry(),
    private readonly errorOperation?: string,
  ) {
    this.registry = registry;
  }

  /** Number of registered node types (for boot logging). */
  get nodeCount(): number {
    return this.registry.list().length;
  }

  /** The registry runs execute against — used to verify artifact node hashes. */
  get executionRegistry(): NodeRegistry {
    return this.registry;
  }

  /** Samples recorded for a node across all runs on this registry (newest first, capped). */
  samplesFor(nodeId: string): NodeExecutionSample[] {
    return this.sink.samplesFor(nodeId).slice(0, 100);
  }

  /** Create a run; wires engine events into a per-run buffer + attached subscribers. */
  create(
    flow: WorkflowDefinition,
    opts: {
      secrets: Record<string, string>;
      vars: Record<string, string>;
      environment: string;
      safeMode: boolean;
      pins?: Record<string, unknown>;
      input?: Record<string, unknown>;
      /** When true, runs in Mock mode: mocked nodes return their canned
       *  output, unmocked infra nodes fail loud. See `StartRunOptions.mockRun`. */
      mockRun?: boolean;
      /** nodeId -> canned output, consulted only when `mockRun` is true. */
      mocks?: Record<string, unknown>;
      /** Internal: marks this run as an error-workflow invocation so it never
       *  itself triggers `errorOperation` (recursion guard — a flag, not an id
       *  comparison, since an error op can legitimately fail on its own). */
      isErrorHandler?: boolean;
      /** Internal: the workflowId of the run that failed and fired this
       *  error-handler run — stamped onto this run's `finished` event as
       *  `errorHandler: { firedBy }`. Only meaningful alongside isErrorHandler. */
      errorHandlerFiredBy?: string;
    },
  ): { runId: string; handle: FlowRun } {
    this.evictIfNeeded();

    // Placeholder entry so the ExecutorEvents closures can reach the live run.
    const entry: LiveRun = { handle: undefined as unknown as FlowRun, buffer: [], listeners: new Set(), finished: false };

    // Redact secret values from every event before it reaches the buffer
    // (replayed to SSE subscribers) or any listener — internal run state
    // (`entry.handle`, `handle.run.nodeStates`) is never routed through
    // `emit` and stays raw.
    const scrub = <T>(e: T): T => redactSecrets(e, opts.secrets ?? {});

    const emit = (event: RunEvent): void => {
      const scrubbed = scrub(event);
      entry.buffer.push(scrubbed);
      for (const listener of entry.listeners) listener(scrubbed);
    };

    // Subflow runner (shared factory — see server/subflowRunner.ts): resolves
    // the child via loadFlow, runs it to completion on the same registry
    // sharing the parent's environment, and forwards its (prefixed) logs into
    // this run's SSE stream via `onLog`.
    const subflowRunner = makeSubflowRunner(
      {
        loadFlow: (id) => this.loadFlow?.(id),
        registry: this.registry,
        secrets: opts.secrets,
        vars: opts.vars,
        environment: opts.environment,
        safeMode: opts.safeMode,
        mockRun: opts.mockRun,
        trace: this.sink,
        onLog: (line) => emit({ type: 'log', line }),
      },
      [flow.id],
    );

    const handle = startRun({
      flow,
      registry: this.registry,
      secrets: opts.secrets,
      vars: opts.vars,
      environment: opts.environment,
      safeMode: opts.safeMode,
      pins: opts.pins,
      input: opts.input,
      mockRun: opts.mockRun,
      mocks: opts.mocks,
      trace: this.sink,
      subflowRunner,
      events: {
        onNodeStateChange: (nodeId, state) => emit({ type: 'nodeState', nodeId, state }),
        onLog: (line) => emit({ type: 'log', line }),
        onRunFinished: (run) => {
          emit({
            type: 'finished',
            run,
            ...(opts.isErrorHandler && opts.errorHandlerFiredBy
              ? { errorHandler: { firedBy: opts.errorHandlerFiredBy } }
              : {}),
          });
          entry.finished = true;
          this.scheduleCleanup(run.id);
          if (run.status === 'failed' && !opts.isErrorHandler) this.fireErrorWorkflow(run, flow, opts);
        },
      },
    });

    entry.handle = handle;
    this.runs.set(handle.run.id, entry);
    return { runId: handle.run.id, handle };
  }

  /**
   * Best-effort: fires `errorOperation` (resolved via the same `loadFlow`
   * callback Subflow nodes use) as a new run when `failedRun` finished with
   * status 'failed'. Never throws and never affects the failed run — any
   * problem (unset config, unknown op id, the error op itself failing to
   * start) is logged and swallowed.
   */
  private fireErrorWorkflow(
    failedRun: WorkflowRun,
    failedFlow: WorkflowDefinition,
    opts: {
      secrets: Record<string, string>;
      vars: Record<string, string>;
      environment: string;
      safeMode: boolean;
      /** A failed MOCK run's error op must also run mocked — otherwise the
       *  most common mock failure (the fail-loud infra boundary) would fire
       *  an error op that touches real infrastructure. */
      mockRun?: boolean;
    },
  ): void {
    if (!this.errorOperation) return;
    try {
      const errorFlow = this.loadFlow?.(this.errorOperation);
      if (!errorFlow) {
        console.error(`[error-workflow] unknown errorOperation "${this.errorOperation}"`);
        return;
      }
      // Report the failure that HALTED the run: an `optional` (fail-soft) node
      // can fail earlier without aborting, so prefer the first failed state
      // whose node is not optional. Fall back to the first failed state only
      // when every failed node is optional.
      const failedEntries = Object.entries(failedRun.nodeStates).filter(([, s]) => s.status === 'failed');
      const failedEntry =
        failedEntries.find(([id]) => !failedFlow.nodes.find((n) => n.id === id)?.optional)
        ?? failedEntries[0];
      const failedNodeId = failedEntry?.[0];
      const error = failedEntry?.[1] && 'error' in failedEntry[1] ? failedEntry[1].error : undefined;
      const { handle } = this.create(errorFlow, {
        secrets: opts.secrets,
        vars: opts.vars,
        environment: opts.environment,
        safeMode: opts.safeMode,
        // Mock mode propagates with the ERROR op's own op-level mocks
        // (nodeIds are flow-scoped — the failed run's map doesn't apply).
        mockRun: opts.mockRun,
        mocks: (errorFlow as { mocks?: Record<string, unknown> }).mocks ?? {},
        input: {
          failedRunId: failedRun.id,
          failedWorkflowId: failedRun.workflowId,
          failedNodeId,
          error,
          environment: opts.environment,
        },
        isErrorHandler: true,
        errorHandlerFiredBy: failedRun.workflowId,
      });
      handle.runToEnd().catch((err) => {
        console.error('[error-workflow] error op run failed', err instanceof Error ? err.message : String(err));
      });
    } catch (err) {
      console.error('[error-workflow] failed to fire error operation', err instanceof Error ? err.message : String(err));
    }
  }

  get(runId: string): FlowRun | undefined {
    return this.runs.get(runId)?.handle;
  }

  /** Replay the buffer to the listener, then stream live events. Returns an unsubscribe fn. */
  subscribe(runId: string, listener: Listener): (() => void) | undefined {
    const entry = this.runs.get(runId);
    if (!entry) return undefined;
    for (const event of entry.buffer) listener(event);
    // A run that already finished has its full buffer replayed above; no live events follow.
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  private scheduleCleanup(runId: string): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = setTimeout(() => this.runs.delete(runId), RETAIN_FINISHED_MS);
  }

  /** Cap live entries: drop the oldest finished run, or the oldest run outright. */
  private evictIfNeeded(): void {
    if (this.runs.size < MAX_LIVE_RUNS) return;
    let victim: string | undefined;
    for (const [id, entry] of this.runs) {
      if (entry.finished) { victim = id; break; }
    }
    if (!victim) victim = this.runs.keys().next().value;
    if (victim) {
      const entry = this.runs.get(victim);
      if (entry?.cleanupTimer) clearTimeout(entry.cleanupTimer);
      this.runs.delete(victim);
    }
  }
}
