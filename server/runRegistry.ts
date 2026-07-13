import type {
  LogLine, NodeExecutionSample, NodeRunState,
  WorkflowDefinition, WorkflowRun,
} from '../src/engine';
import { InMemoryTraceSink, startRun, type FlowRun, type NodeRegistry } from '../src/engine';
import { createDefaultRegistry } from '../src/nodes';
import { redactSecrets } from './redact';
import { makeSubflowRunner, type DrillEntry, type DrillState } from './subflowRunner';

/** SSE-shaped events, mirroring ExecutorEvents 1:1. */
export type RunEvent =
  /** `workflowId` is the flow the node belongs to: the root flow for the
   *  run's own nodes, the CHILD flow's id for a stepped subflow's nodes. */
  | { type: 'nodeState'; workflowId: string; nodeId: string; state: NodeRunState }
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
  /** Serializes step() calls per run: a second concurrent step() would
   *  re-arm `state.onChildStarted` (last writer wins) and double-drive the
   *  executor, hanging the first caller. */
  stepChain?: Promise<unknown>;
  /** Present only for stepped runs: subflow drill-in state (see step()). */
  drill?: {
    state: DrillState;
    /** The ROOT executor's step() promise left pending while a child runs. */
    rootPendingStep?: Promise<boolean>;
  };
}

/** Result of one composite step on a stepped run (see RunRegistry.step). */
export interface StepResult {
  done: boolean;
  /** Set when this step drove execution INTO a subflow child. */
  entered?: { workflowId: string; nodeId: string };
  /** Set when this step completed the deepest child and popped back out. */
  exited?: true;
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
      /** When true (a step-mode run), Subflow children become step-drivable:
       *  entering one pauses inside it instead of running it to completion in
       *  a single opaque step. Drive the run via `step(runId)`. */
      stepped?: boolean;
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
    // Stepped runs share ONE drill state across the root's runner and every
    // nested child's runner (makeSubflowRunner threads `opts` through), so a
    // grandchild pushes onto the same stack and nesting works.
    const drillState: DrillState | undefined = opts.stepped ? { stack: [] } : undefined;

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
        drill: drillState,
        // Stepped children stream node states into this run's SSE stream,
        // tagged with the CHILD flow's id so the client can route them.
        // After a drill-aware cancel the rejected parent executions unwind in
        // the background (recording their Subflow nodes as failed) — child
        // states from that unwinding must not reach subscribers post-finish.
        onNodeState: drillState
          ? (workflowId, nodeId, state) => {
              if (drillState.cancelled) return;
              emit({ type: 'nodeState', workflowId, nodeId, state });
            }
          : undefined,
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
        onNodeStateChange: (nodeId, state) =>
          emit({ type: 'nodeState', workflowId: flow.id, nodeId, state }),
        onLog: (line) => emit({ type: 'log', line }),
        onRunFinished: (run) => {
          // Idempotent: after a drill-aware cancel the root executor's pending
          // Subflow execution can fail in the background and re-finish the run
          // — subscribers already saw the cancelled `finished` event.
          if (entry.finished) return;
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
    if (drillState) entry.drill = { state: drillState };
    this.runs.set(handle.run.id, entry);
    return { runId: handle.run.id, handle };
  }

  /**
   * One composite step of a run, drill-aware. For stepped runs a Subflow node
   * is no longer one opaque step: entering it pauses inside the child
   * (`entered`), subsequent steps drive the child's nodes, and completing the
   * child pops back out (`exited`). Non-stepped runs (no drill state) fall
   * back to a plain executor step. Unknown run → undefined.
   */
  async step(runId: string): Promise<StepResult | undefined> {
    const entry = this.runs.get(runId);
    if (!entry) return undefined;
    // Serialize per run: concurrent step() calls would each arm
    // `state.onChildStarted` (last writer wins) and double-drive the
    // executor, so the second caller waits for the first to settle.
    const result = (entry.stepChain ?? Promise.resolve()).then(() => this.stepLevels(entry));
    entry.stepChain = result.catch(() => undefined);
    return result;
  }

  /**
   * One composite step, drill-aware. Structured as a loop over levels: each
   * pass drives the current deepest level (a pending stashed step, or a fresh
   * executor step) while racing "a new child started". Popping a finished
   * child continues the loop on its parent's stashed step WITH the race still
   * armed — the parent's still-pending Subflow node execution may call
   * runSubflow again (retry, or a custom node making sequential calls), and
   * that re-entry must surface as `entered`, not deadlock the fold.
   */
  private async stepLevels(entry: LiveRun): Promise<StepResult> {
    const drill = entry.drill;
    if (!drill) {
      const more = await entry.handle.step();
      return { done: !more };
    }

    const { state } = drill;
    // Cancelled mid-drill: the stack was already unwound by cancel(); report
    // done without driving anything.
    if (state.cancelled) return { done: true };

    // Set once this step pops a child; carried onto whatever this step
    // ultimately reports (including an `entered` for a re-run child).
    let exited = false;
    const withExit = (r: StepResult): StepResult => (exited ? { ...r, exited: true } : r);

    for (;;) {
      // The level being stepped: the deepest drilled-in child, or the root run.
      const level = state.stack.length > 0 ? state.stack[state.stack.length - 1] : undefined;
      const handle = level ? level.handle : entry.handle;
      const pendingStep = level ? level.pendingStep : drill.rootPendingStep;
      const setPending = (p: Promise<boolean> | undefined): void => {
        if (level) level.pendingStep = p;
        else drill.rootPendingStep = p;
      };

      // A Subflow node's execution blocks inside runSubflow until its child
      // completes, so the step promise alone can never report "entered a
      // child" — arm the child-started signal BEFORE awaiting and race them.
      const childStarted = new Promise<DrillEntry>((res) => {
        state.onChildStarted = res;
      });
      const stepPromise = pendingStep ?? handle.step();
      setPending(undefined);

      type Raced = { kind: 'stepped'; more: boolean } | { kind: 'entered'; child: DrillEntry };
      let raced: Raced;
      try {
        raced = await Promise.race([
          stepPromise.then((more): Raced => ({ kind: 'stepped', more })),
          childStarted.then((child): Raced => ({ kind: 'entered', child })),
        ]);
      } catch (err) {
        state.onChildStarted = undefined;
        if (!level) throw err;
        // A child level's step threw outright (not a recorded node failure —
        // the executor catches those). Reject the parent's blocked runSubflow,
        // which surfaces it as the Subflow node's error, then fold the parent
        // (next loop pass, race re-armed).
        state.stack.pop();
        level.reject(err);
        exited = true;
        continue;
      }
      state.onChildStarted = undefined;

      if (raced.kind === 'entered') {
        // The level's step stays pending for the whole child run — stash it;
        // the step that later pops this child folds its boolean back in.
        setPending(stepPromise);
        return withExit({
          done: false,
          entered: { workflowId: raced.child.workflowId, nodeId: raced.child.viaNodeId },
        });
      }

      if (raced.more) return withExit({ done: false });

      // This level has no more nodes: its run is complete.
      if (!level) return withExit({ done: true });

      // Pop the finished child and hand its completed run (succeeded OR failed)
      // to the parent's blocked runSubflow — the success/failure semantics live
      // in subflowRunner, byte-identical to the non-stepped path. The parent's
      // stashed step is folded in by the next loop pass, with the child-started
      // race re-armed so a retrying Subflow node re-entering its child yields
      // `exited` + `entered` instead of hanging.
      state.stack.pop();
      level.resolve(level.handle.run);
      exited = true;
    }
  }

  /**
   * Cancel a run, drill-aware. For a stepped run drilled into subflows this
   * cancels every stacked child deepest-first and rejects the promise each
   * parent's Subflow node execution is blocked on — those pending executions
   * then unwind in the background exactly like an in-flight node after a
   * plain root cancel today (recorded, but the run is already finished).
   * step() after cancel reports { done: true } without executing anything.
   * Returns false for an unknown run.
   */
  /** Cancels every live (non-finished) run — the server's shutdown path, so
   *  in-flight executions (and their drilled subflow children) don't keep
   *  running headless after the process is asked to die. */
  shutdown(): void {
    for (const [id, run] of this.runs) {
      if (!run.finished) this.cancel(id);
    }
  }

  cancel(runId: string): boolean {
    const entry = this.runs.get(runId);
    if (!entry) return false;
    const drill = entry.drill;
    if (drill) {
      const { state } = drill;
      state.cancelled = true;
      state.onChildStarted = undefined;
      while (state.stack.length > 0) {
        const child = state.stack.pop()!;
        child.pendingStep = undefined;
        child.handle.cancel();
        child.reject(new Error('run cancelled'));
      }
      drill.rootPendingStep = undefined;
    }
    entry.handle.cancel();
    return true;
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
