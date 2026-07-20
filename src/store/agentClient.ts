/**
 * Client for the agent-run API (server/agents/*), reached through the Vite
 * proxy at /api → 127.0.0.1:8092, same-origin as serverRunner.ts/nodeMeta.ts.
 *
 * NOTE ON DUPLICATION: the browser bundle cannot import from server/ (it's a
 * Node-only tree), so `AgentEvent`/`AgentKind` (mirroring server/agents/types.ts)
 * and `AgentIntent` (mirroring server/agents/prompt.ts) are duplicated here.
 * Keep this shape in sync by hand if the server types change.
 */

const BASE = '/api';

export type AgentKind = 'codex' | 'claude';

export interface DetectedAgent {
  kind: AgentKind;
  version: string | null;
}

export interface AgentEvent {
  type: 'started' | 'message' | 'command' | 'mcp' | 'approval-request' | 'done' | 'error';
  text?: string; // message/error text
  command?: string; // for 'command'
  commandStatus?: 'in_progress' | 'completed' | 'failed';
  exitCode?: number | null; // for 'command'
  output?: string; // command aggregated output OR an mcp call's result
  toolUseId?: string; // for 'command'/'mcp' (Claude) — correlates a tool_use with its later tool_result
  approvalId?: string; // for 'approval-request' (Claude)
  usage?: Record<string, number>; // for 'done'
  mcpServer?: string; // for 'mcp' — e.g. 'emberflow'
  mcpTool?: string; // for 'mcp' — e.g. 'run_operation'
  mcpStatus?: 'in_progress' | 'completed' | 'failed';
}

export type AgentIntent =
  | { action: 'new-scenario'; flowId: string; instruction: string }
  | { action: 'edit-node'; flowId: string; nodeId: string; instruction: string }
  | { action: 'edit-flow'; flowId: string; instruction: string; scaffold?: boolean }
  | { action: 'new-operation'; location: string; instruction: string }
  | { action: 'build-api'; location: string; instruction: string }
  | { action: 'setup-auth'; environment: string; instruction: string }
  | { action: 'setup-environments'; instruction: string }
  | { action: 'scout-infrastructure'; instruction: string }
  | { action: 'guided-setup'; instruction: string }
  | { action: 'cover-operation'; flowId: string; instruction: string }
  | { action: 'ask'; flowId?: string; instruction: string };

export interface StartAgentOptions {
  agent?: AgentKind;
  model?: string;
  reasoning?: 'low' | 'medium' | 'high';
}

/** GET /agent/available — which agent CLIs the server detected on PATH, and their versions. Returns [] if unreachable. */
export async function fetchAvailableAgents(): Promise<DetectedAgent[]> {
  try {
    const response = await fetch(`${BASE}/agent/available`);
    if (!response.ok) return [];
    const { agents } = (await response.json()) as { agents: DetectedAgent[] };
    return agents ?? [];
  } catch {
    return [];
  }
}

/** POST /agent — start an agent run, returns its id. */
export async function startAgent(intent: AgentIntent, opts?: StartAgentOptions): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent, ...opts }),
    });
  } catch {
    // fetch rejects with a bare "Failed to fetch" on network errors — say what
    // that actually means here and what to do about it.
    throw new Error('Could not reach the runner — check it is still running, then try again.');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to start agent (HTTP ${response.status})`);
  }
  const { agentRunId } = (await response.json()) as { agentRunId: string };
  return agentRunId;
}

/**
 * Subscribe to an agent run's SSE stream at /agent/:id/events. Each server
 * event carries its own `type` field mirrored in `data`, so we listen for
 * every AgentEvent type and hand the parsed payload straight to `onEvent`.
 * Returns an unsubscribe function.
 */
export function streamAgent(agentRunId: string, onEvent: (event: AgentEvent) => void): () => void {
  const source = new EventSource(`${BASE}/agent/${agentRunId}/events`);
  // Set once the server delivers the run's terminal event — from then on any
  // connection-level error (the server closing the response right after) is
  // expected, not a lost stream, so onerror must stay quiet.
  let sawTerminal = false;
  const types: AgentEvent['type'][] = ['started', 'message', 'command', 'mcp', 'approval-request', 'done', 'error'];
  for (const type of types) {
    source.addEventListener(type, (event) => {
      // EventSource dispatches its CONNECTION errors as `error` events too —
      // those carry no data, unlike the server's named `event: error` payloads.
      const raw = (event as MessageEvent).data as string | undefined;
      if (raw === undefined) return;
      const data = JSON.parse(raw) as AgentEvent;
      onEvent(data);
      if (type === 'done' || type === 'error') {
        sawTerminal = true;
        source.close();
      }
    });
  }
  source.onerror = () => {
    if (!sawTerminal && source.readyState === EventSource.CLOSED) {
      onEvent({ type: 'error', text: 'Lost connection to the agent event stream' });
    }
  };
  return () => source.close();
}

export interface AgentDiffResult {
  diff: string;
  files: string[];
}

/** GET /agent/:id/diff */
/** One operation of a running build's declared plan (mirrors server AgentPlanOp). */
export interface AgentPlanOp {
  id: string;
  name: string;
  method?: string;
  path?: string;
}

/** GET /agent-plan — the surface the LIVE build run declared (null when no run/plan). */
export async function fetchAgentPlan(): Promise<{ location: string; ops: AgentPlanOp[] } | null> {
  try {
    const response = await fetch(`${BASE}/agent-plan`);
    if (!response.ok) return null;
    const { plan } = (await response.json()) as { plan: { location: string; ops: AgentPlanOp[] } | null };
    return plan ?? null;
  } catch {
    return null;
  }
}

/** One persisted agent conversation (mirrors server AgentHistoryRecord). */
export interface AgentHistoryRun {
  id: string;
  action: string;
  instruction: string;
  status: 'done' | 'error';
  startedAt: string;
  finishedAt: string;
  events: AgentEvent[];
}

/** GET /agent-history?flow=… — persisted conversations for one operation, oldest first. [] if unreachable. */
export async function fetchAgentHistory(flowId: string): Promise<AgentHistoryRun[]> {
  try {
    const response = await fetch(`${BASE}/agent-history?flow=${encodeURIComponent(flowId)}`);
    if (!response.ok) return [];
    const { runs } = (await response.json()) as { runs: AgentHistoryRun[] };
    return runs ?? [];
  } catch {
    return [];
  }
}

export async function fetchAgentDiff(agentRunId: string): Promise<AgentDiffResult> {
  const response = await fetch(`${BASE}/agent/${agentRunId}/diff`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to fetch agent diff (HTTP ${response.status})`);
  }
  return (await response.json()) as AgentDiffResult;
}

/** POST /agent/:id/revert — returns the list of reverted file paths. */
export async function revertAgent(agentRunId: string): Promise<{ reverted: string[] }> {
  const response = await fetch(`${BASE}/agent/${agentRunId}/revert`, { method: 'POST' });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to revert agent run (HTTP ${response.status})`);
  }
  return (await response.json()) as { reverted: string[] };
}

/** POST /agent/:id/cancel */
export async function cancelAgent(agentRunId: string): Promise<void> {
  await fetch(`${BASE}/agent/${agentRunId}/cancel`, { method: 'POST' }).catch(() => undefined);
}
