import type {
  LogLine,
  NodeRegistry,
  StartRunOptions,
  SubflowResult,
  TraceSink,
  WorkflowDefinition,
} from '../src/engine';
import { runOutput, startRun } from '../src/engine';

/** Max depth of nested Subflow calls (ancestry chain length) before a run fails. */
export const SUBFLOW_DEPTH_CAP = 8;

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
        events: opts.onLog
          ? {
              onLog: (line) =>
                opts.onLog!({
                  ...line,
                  nodeLabel: `${childFlow.name} › ${line.nodeLabel ?? ''}`,
                  nodeId: line.nodeId ? `${callerNodeId}/${line.nodeId}` : callerNodeId,
                }),
            }
          : undefined,
      });
      const childRun = await childHandle.runToEnd();
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
