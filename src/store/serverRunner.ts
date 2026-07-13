import type { HttpTrigger, LogLine, NodeExecutionSample, NodeRunState, WorkflowDefinition, WorkflowRun } from '../engine';

/**
 * Client for the local runner (server/index.ts), reached through the Vite
 * proxy at /api → 127.0.0.1:8092. Event names/payloads mirror ExecutorEvents.
 */

const BASE = '/api';

/** Tags a finished run that was fired by an error-handler op (server/runRegistry.ts's
 *  fireErrorWorkflow) — carries the op id that triggered it. */
export interface ErrorHandlerTag {
  firedBy: string;
}

export interface ServerRunHandlers {
  onNodeState(nodeId: string, state: NodeRunState): void;
  onLog(line: LogLine): void;
  onFinished(run: WorkflowRun, errorHandler?: ErrorHandlerTag): void;
  onError(message: string): void;
}

/** Result of a health check: `online` mirrors the old boolean-only contract;
 *  `mock` reflects the runner's `/healthz` `mock` field (true when it's
 *  serving EMBERFLOW_MOCK responses instead of live execution). Both are
 *  false when the runner can't be reached at all. */
export interface RunnerHealth {
  online: boolean;
  mock: boolean;
}

export async function runnerHealthy(): Promise<RunnerHealth> {
  try {
    const response = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { online: false, mock: false };
    const body = (await response.json().catch(() => ({}))) as { mock?: unknown };
    return { online: true, mock: body.mock === true };
  } catch {
    return { online: false, mock: false };
  }
}

/** One operation's on-disk path + http metadata, from the runner's ApiStore. */
export interface OperationMeta {
  id: string;
  name: string;
  path: string;
  http?: HttpTrigger;
}

/** The runner's workflow set: full flow definitions plus per-operation path/http metadata. */
export interface WorkflowsPayload {
  flows: WorkflowDefinition[];
  operations: OperationMeta[];
}

/** Fetch the runner's workflow set (flows + operation path/http metadata). Returns null on any failure. */
export async function fetchWorkflows(): Promise<WorkflowsPayload | null> {
  try {
    const response = await fetch(`${BASE}/workflows`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    const body = (await response.json()) as { flows?: WorkflowDefinition[]; operations?: OperationMeta[] };
    if (!Array.isArray(body.flows)) return null;
    return { flows: body.flows, operations: Array.isArray(body.operations) ? body.operations : [] };
  } catch {
    return null;
  }
}

/** Fetch runner-recorded execution samples for a node. Returns [] on any failure. */
export async function fetchSamples(nodeId: string): Promise<NodeExecutionSample[]> {
  try {
    const response = await fetch(`${BASE}/samples?nodeId=${encodeURIComponent(nodeId)}`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return [];
    const { samples } = (await response.json()) as { samples: NodeExecutionSample[] };
    return Array.isArray(samples) ? samples : [];
  } catch {
    return [];
  }
}

/** PUT a flow to the runner. Returns false on any failure. The id is
 *  URL-encoded so operations whose id contains a slash (the apis-tree path,
 *  e.g. "util/echo-body") match the `/workflows/:id` route instead of 404ing. */
export async function putWorkflow(flow: WorkflowDefinition): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/workflows/${encodeURIComponent(flow.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(flow),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Result of a create-operation attempt: `ok: false` always carries a message
 *  the caller can show (e.g. a 409 collision or a network failure) — a
 *  creation failure must never be silent. */
export interface CreateOperationResult {
  ok: boolean;
  error?: string;
}

/**
 * Create a brand-new operation at an explicit `apis/` path. Unlike `putWorkflow`
 * (which resolves an EXISTING op's path, defaulting unknown ids to `default/<id>`),
 * a new op with a nested path-style id needs to land at that exact path — this
 * calls the runner's `POST /operations { flow, path }`. Never overwrites: the
 * runner 409s when an operation already exists at `path`, and that error
 * message is surfaced here rather than swallowed.
 */
export async function createOperationOnServer(
  flow: WorkflowDefinition,
  path: string,
): Promise<CreateOperationResult> {
  try {
    const response = await fetch(`${BASE}/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flow, path }),
    });
    if (response.ok) return { ok: true };
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    return { ok: false, error: body?.error ?? `Request failed with status ${response.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Delete an operation by its flow id (removes its .json + .scenarios sidecar). */
export async function deleteWorkflowOnServer(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${BASE}/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (response.status === 204 || response.ok) return { ok: true };
    return { ok: false, error: `Delete failed with status ${response.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Mirrors server/environments.ts EnvAuth — names/refs only, values never cross the wire. */
export interface EnvAuth {
  attach: { as: 'cookie' | 'header'; name: string; secretRef: string; prefix?: string };
  login?: {
    request: { method: string; url: string; headers?: Record<string, string>; bodyRef?: string };
    capture:
      | { from: 'set-cookie'; cookieName?: string }
      | { from: 'json'; path: string }
      | { from: 'header'; name: string };
  };
}

/** Summary of a runner environment — key names only, values never cross the wire. */
export interface EnvironmentSummary {
  name: string;
  protected: boolean;
  varKeys: string[];
  secretKeys: string[];
  /** Login-auth status (booleans only — secret values never cross the wire). Absent for envs with no auth config. */
  auth?: { configured: boolean; authenticated: boolean; secretRef?: string; config?: EnvAuth };
}

export interface EnvironmentList {
  defaultEnvironment: string;
  environments: EnvironmentSummary[];
  /** False when the runner synthesized its bare "local" fallback (no
   *  emberflow.environments.json) — the studio treats that as "no
   *  environments yet" rather than showing the synthetic entry. */
  configured?: boolean;
}

/** Fetch the runner's environments. Returns null on any failure (runner offline). */
export async function listEnvironments(): Promise<EnvironmentList | null> {
  try {
    const response = await fetch(`${BASE}/environments`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    const data = (await response.json()) as EnvironmentList;
    return data && Array.isArray(data.environments) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Fire the environment's configured login request; the runner persists the
 * captured credential into `emberflow.environments.json` under that env's
 * secrets. Never returns the credential — callers should re-fetch
 * environments afterward to observe the updated `auth.authenticated` flag.
 */
/**
 * Flip the runner's serving mode. 'mock' answers mounted endpoints from
 * scenario expectations (no nodes, no auth); 'real' executes them. Takes
 * effect immediately for every consumer of the mounted API.
 */
export async function setServingMode(mode: 'real' | 'mock'): Promise<void> {
  const response = await fetch(`${BASE}/serving`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to set serving mode (HTTP ${response.status})`);
  }
}

export async function loginEnvironment(name: string): Promise<void> {
  const response = await fetch(`${BASE}/environments/${encodeURIComponent(name)}/login`, { method: 'POST' });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Login failed for environment "${name}" (HTTP ${response.status})`);
  }
}

/**
 * Set a secret's value on an environment. The value is sent once, over this
 * PUT, and never appears in any other route, log, or return value — the
 * runner responds 204 with an empty body on success.
 */
export async function setEnvironmentSecret(name: string, key: string, value: string): Promise<void> {
  const response = await fetch(
    `${BASE}/environments/${encodeURIComponent(name)}/secrets/${encodeURIComponent(key)}`,
    { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to set secret "${key}" for environment "${name}" (HTTP ${response.status})`);
  }
}

/** Delete a secret from an environment. The runner responds 204 with an empty body on success. */
export async function deleteEnvironmentSecret(name: string, key: string): Promise<void> {
  const response = await fetch(
    `${BASE}/environments/${encodeURIComponent(name)}/secrets/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      body.error ?? `Failed to delete secret "${key}" for environment "${name}" (HTTP ${response.status})`,
    );
  }
}

/**
 * Set (or, with `null`, clear) an environment's login-auth config. The
 * runner responds 204 with an empty body on success; secret values are
 * referenced by name only (`secretRef`) and never included here.
 */
export async function setEnvironmentAuth(name: string, auth: EnvAuth | null): Promise<void> {
  const response = await fetch(`${BASE}/environments/${encodeURIComponent(name)}/auth`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(auth),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to set auth for environment "${name}" (HTTP ${response.status})`);
  }
}

/** Mirrors server/testRunner.ts's SkipReason. */
export type ScenarioTestSkipReason = 'no expect' | 'empty expect';

/** Mirrors server/testRunner.ts's ScenarioResult — one scenario's outcome
 *  from POST /workflows/:id/test. */
export interface ScenarioTestResult {
  opId: string;
  scenario: string;
  status: 'passed' | 'failed' | 'skipped';
  /** Present only when status === 'failed' — evaluateExpectation's failure strings. */
  failures?: string[];
  /** Present only when status === 'skipped'. */
  reason?: ScenarioTestSkipReason;
}

/** Mirrors server/testRunner.ts's TestReport. */
export interface ScenarioTestReport {
  results: ScenarioTestResult[];
  passed: number;
  failed: number;
  skipped: number;
}

/**
 * Run an operation's scenario suite on the runner (server/testRunner.ts —
 * the studio never duplicates expectation-evaluation logic). The id is
 * URL-encoded so ids containing a slash (the apis-tree path) match the
 * `/workflows/:id/test` route instead of 404ing.
 */
export async function testWorkflow(id: string, environment?: string): Promise<ScenarioTestReport> {
  const response = await fetch(`${BASE}/workflows/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ environment }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Test run failed for "${id}" (HTTP ${response.status})`);
  }
  return (await response.json()) as ScenarioTestReport;
}

/** Environment/safety options threaded into a server run. */
export interface ServerRunOptions {
  /** Scenario name for the runner to resolve server-side (mock runs merge the
   *  scenario's mocks over the op-level map; harmless on real runs). */
  scenarioName?: string;
  environment?: string;
  safeMode?: boolean;
  /** Required to equal `environment` when disabling safe mode on a protected env. */
  confirm?: string;
}

export async function startServerRun(
  flow: WorkflowDefinition,
  mode: 'run' | 'step',
  pins?: Record<string, unknown>,
  input?: Record<string, unknown>,
  options?: ServerRunOptions,
): Promise<string> {
  const response = await fetch(`${BASE}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flow, mode, pins, input, ...options }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Runner rejected the run (HTTP ${response.status})`);
  }
  const { runId } = (await response.json()) as { runId: string };
  return runId;
}

/** Request to run a single node in isolation on the runner (POST /node-run). */
export interface NodeRunRequest {
  type: string;
  input: Record<string, unknown>;
  config?: Record<string, unknown>;
  environment?: string;
  safeMode?: boolean;
  /** Required to equal `environment` when running unsafe against a protected env. */
  confirm?: string;
}

/** The runner's isolated node-run result (output redacted, logs captured). */
export interface NodeRunResult {
  output?: unknown;
  error?: string;
  logs: LogLine[];
}

/**
 * Run one node in isolation on the runner: the runner resolves the environment's
 * secrets/vars, honours safe mode, executes the node's implementation in-process
 * and redacts the output. Throws on transport failure (runner offline) and on a
 * non-2xx response (unknown type → 404, bad request → 400).
 */
export async function runNodeOnServer(req: NodeRunRequest): Promise<NodeRunResult> {
  const response = await fetch(`${BASE}/node-run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Node run failed (HTTP ${response.status})`);
  }
  return (await response.json()) as NodeRunResult;
}

export async function stepServerRun(runId: string): Promise<boolean> {
  const response = await fetch(`${BASE}/runs/${runId}/step`, { method: 'POST' });
  if (!response.ok) throw new Error(`Step failed (HTTP ${response.status})`);
  const { done } = (await response.json()) as { done: boolean };
  return done;
}

export async function cancelServerRun(runId: string): Promise<void> {
  await fetch(`${BASE}/runs/${runId}/cancel`, { method: 'POST' }).catch(() => undefined);
}

/** Subscribe to a run's SSE stream. Returns an unsubscribe function. */
export function subscribeServerRun(runId: string, handlers: ServerRunHandlers): () => void {
  const source = new EventSource(`${BASE}/runs/${runId}/events`);

  source.addEventListener('nodeState', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as {
      nodeId: string;
      state: NodeRunState;
    };
    handlers.onNodeState(data.nodeId, data.state);
  });
  source.addEventListener('log', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as { line: LogLine };
    handlers.onLog(data.line);
  });
  source.addEventListener('finished', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as {
      run: WorkflowRun;
      errorHandler?: ErrorHandlerTag;
    };
    handlers.onFinished(data.run, data.errorHandler);
    source.close();
  });
  source.onerror = () => {
    // EventSource retries transient errors itself; only report when closed.
    if (source.readyState === EventSource.CLOSED) {
      handlers.onError('Lost connection to the runner event stream');
    }
  };

  return () => source.close();
}
