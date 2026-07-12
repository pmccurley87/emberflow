import { runOutput, type WorkflowDefinition, type WorkflowRun } from '../src/engine';

/** Map a finished operation run to an HTTP response. A flow can have more than
 *  one `Response` node (e.g. a success branch and an error branch) — only one
 *  of them actually ran. Among the `Response`-type nodes, pick the one whose
 *  run state actually succeeded (first such node by array order if somehow
 *  more than one did); its output (already `{ status, body }`) wins.
 *  Otherwise — no Response node, or none of them succeeded — fall back to
 *  200 + the run's Result output. */
export function extractResponse(run: WorkflowRun, flow: WorkflowDefinition): { status: number; body: unknown } {
  const responseNodes = flow.nodes.filter((n) => n.type === 'Response');
  const succeeded = responseNodes.find((n) => run.nodeStates[n.id]?.status === 'succeeded');
  const out = succeeded ? run.nodeStates[succeeded.id]?.output : undefined;
  if (out && typeof out === 'object') {
    const o = out as { status?: unknown; body?: unknown };
    return { status: typeof o.status === 'number' ? o.status : 200, body: o.body };
  }
  // No Response node succeeded. If the run itself failed, a 200 fallback would
  // silently mask the failure (runOutput returns undefined → 200 + null). Surface
  // it as a 500, preferring the first failed node's error string (a stable shape,
  // no stack traces) so the caller sees why.
  if (run.status === 'failed') {
    const nodeError = Object.values(run.nodeStates).find((s) => s?.status === 'failed')?.error;
    return { status: 500, body: nodeError ? { error: 'run failed', detail: nodeError } : { error: 'run failed' } };
  }
  return { status: 200, body: runOutput(run, flow) };
}
