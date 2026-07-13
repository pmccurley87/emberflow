import type {
  FlowRun,
  LogLine,
  NodeRegistry,
  NodeRunState,
  StartRunOptions,
  SubflowResult,
  TraceSink,
  WorkflowDefinition,
  WorkflowRun,
} from '../src/engine';
import { runOutput, startRun } from '../src/engine';

/** Max depth of nested Subflow calls (ancestry chain length) before a run fails. */
export const SUBFLOW_DEPTH_CAP = 8;

/**
 * One live drilled-into child on a stepped run. Pushed by the subflow runner
 * when a Subflow node starts its child; popped by the registry's composite
 * step() when the child's own stepping completes. `resolve`/`reject` settle
 * the promise the parent's Subflow node execution is blocked on.
 */
export interface DrillEntry {
  handle: FlowRun;
  /** The child flow's id (what the caller drilled into). */
  workflowId: string;
  /** The parent Subflow node that triggered the child. */
  viaNodeId: string;
  /** Hands the completed child run back to the blocked parent Subflow node. */
  resolve: (run: WorkflowRun) => void;
  reject: (err: unknown) => void;
  /**
   * This level's own executor.step() promise, left pending while a DEEPER
   * child runs (a Subflow node's execution blocks on its child). Stashed by
   * the registry when it observes `entered`; folded back in on exit.
   */
  pendingStep?: Promise<boolean>;
}

/**
 * Per-root-run drill state for stepped runs. The root's subflow runner and
 * every nested child's runner share the SAME instance, so grandchildren push
 * onto the same stack and nesting Just Works.
 */
export interface DrillState {
  stack: DrillEntry[];
  /** Armed by the registry's step() while it awaits a level's step, so a
   *  child starting can be raced against the (now blocked) step promise. */
  onChildStarted?: (entry: DrillEntry) => void;
  /** Set by RunRegistry.cancel(): unwinding parent executions must not start
   *  (or block on) new children — runSubflow fails fast instead. */
  cancelled?: boolean;
}

export interface SubflowRunnerOptions {
  /** Resolves a child workflow by id (server hosts this via apiStore.load). */
  loadFlow: (id: string) => WorkflowDefinition | undefined;
  registry: NodeRegistry;
  secrets: Record<string, string>;
  vars: Record<string, string>;
  environment: string;
  safeMode: boolean;
  /** When true, child runs execute in Mock mode too — nothing real is ever
   *  touched during a mock run, including inside Subflow children. See
   *  `StartRunOptions.mockRun`. */
  mockRun?: boolean;
  /** Optional trace sink shared with the parent run (SSE/samples plumbing). */
  trace?: TraceSink;
  /** Optional child-log forwarder — receives the child's log lines already
   *  prefixed with the child flow's name and the caller node's id, exactly as
   *  the live runner streams them over SSE. Absent for headless runs. */
  onLog?: (line: LogLine) => void;
  /**
   * Present only for stepped runs: children become step-drivable instead of
   * running to completion. The runner pushes each started child onto
   * `drill.stack` and blocks the Subflow node until the registry pops it.
   */
  drill?: DrillState;
  /** Child nodeState forwarder for stepped runs — receives the CHILD flow's
   *  id so the client can route states to the drilled-in view. Only wired
   *  when `drill` is present (non-stepped children keep today's behavior:
   *  their node states are discarded, only the output returns). */
  onNodeState?: (workflowId: string, nodeId: string, state: NodeRunState) => void;
}

/**
 * Shared Subflow-runner factory used by BOTH the live runner
 * (server/runRegistry.ts) and the in-process test runner
 * (server/testRunner.ts): resolve the child via `loadFlow`, run it to
 * completion on the same registry sharing the parent's environment
 * (secrets/vars/safeMode), and return its collected Result output. The
 * ancestry chain enforces the depth cap and catches A→B→A cycles; nested
 * children keep their own execution sequence.
 */
export function makeSubflowRunner(
  opts: SubflowRunnerOptions,
  ancestry: string[],
): NonNullable<StartRunOptions['subflowRunner']> {
  return async (workflowId, input, callerNodeId): Promise<SubflowResult> => {
    // A cancelled stepped run's unwinding parents (their runSubflow was
    // rejected) may retry: never push a new child that nothing will step.
    if (opts.drill?.cancelled) {
      return { status: 'failed', error: 'run cancelled' };
    }
    if (ancestry.length >= SUBFLOW_DEPTH_CAP) {
      return { status: 'failed', error: `subflow depth cap (${SUBFLOW_DEPTH_CAP}) exceeded` };
    }
    if (ancestry.includes(workflowId)) {
      return { status: 'failed', error: `subflow cycle: ${[...ancestry, workflowId].join(' → ')}` };
    }
    const childFlow = opts.loadFlow(workflowId);
    if (!childFlow) return { status: 'failed', error: `Unknown workflow: ${workflowId}` };
    try {
      const childHandle = startRun({
        flow: childFlow,
        registry: opts.registry,
        secrets: opts.secrets,
        vars: opts.vars,
        environment: opts.environment,
        safeMode: opts.safeMode,
        input,
        // Mock mode propagates into the child: nothing real is ever touched
        // in a mock run, including inside Subflow children. Scenario context
        // never propagates (the parent didn't pick one for the child) — only
        // the CHILD op's own op-level mocks apply, since nodeIds are scoped
        // per-flow and reusing the parent's mock map would be meaningless
        // (or worse, silently wrong) for the child's node ids.
        mockRun: opts.mockRun,
        mocks: (childFlow as { mocks?: Record<string, unknown> }).mocks ?? {},
        trace: opts.trace,
        subflowRunner: makeSubflowRunner(opts, [...ancestry, workflowId]),
        events:
          opts.onLog || (opts.drill && opts.onNodeState)
            ? {
                ...(opts.onLog
                  ? {
                      onLog: (line: LogLine) =>
                        opts.onLog!({
                          ...line,
                          nodeLabel: `${childFlow.name} › ${line.nodeLabel ?? ''}`,
                          nodeId: line.nodeId ? `${callerNodeId}/${line.nodeId}` : callerNodeId,
                        }),
                    }
                  : {}),
                // Stepped children stream their node states into the ROOT
                // run's SSE stream, tagged with the child flow's id.
                ...(opts.drill && opts.onNodeState
                  ? {
                      onNodeStateChange: (nodeId: string, state: NodeRunState) =>
                        opts.onNodeState!(childFlow.id, nodeId, state),
                    }
                  : {}),
              }
            : undefined,
      });
      // Stepped run: don't run the child here. Push it onto the shared drill
      // stack and block this Subflow node until the registry's composite
      // step() drives the child to completion and pops the entry — resolving
      // with the completed child run, which flows into the exact same
      // output-extraction / failure-mapping path runToEnd feeds today.
      const childRun = opts.drill
        ? await new Promise<WorkflowRun>((resolve, reject) => {
            const entry: DrillEntry = { handle: childHandle, workflowId, viaNodeId: callerNodeId, resolve, reject };
            opts.drill!.stack.push(entry);
            opts.drill!.onChildStarted?.(entry);
          })
        : await childHandle.runToEnd();
      if (childRun.status !== 'succeeded') {
        // Surface the child's actual failure (e.g. the Mock-mode "would touch
        // real infrastructure" boundary message) through the Subflow node's
        // own error, rather than an opaque "failed" — the first failed
        // node's `error`, if any, wins.
        const failedNode = Object.values(childRun.nodeStates).find((s) => s.status === 'failed' && s.error);
        const detail = failedNode?.error;
        return {
          status: 'failed',
          error: `subflow "${childFlow.name}" ${childRun.status}${detail ? `: ${detail}` : ''}`,
        };
      }
      return { status: 'succeeded', output: runOutput(childRun, childFlow) };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  };
}
