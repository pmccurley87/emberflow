import type {
  LogLine,
  NodeExecutionSample,
  NodeRunState,
  PublishedArtifact,
  WorkflowDefinition,
  WorkflowRun,
} from '../src/engine';
import type { ApiTree, FolderNode, ApiNode, OpSummary } from './apiStore';

export type { ApiTree, FolderNode, ApiNode, OpSummary } from './apiStore';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8092';

function baseUrl(): string {
  return process.env.EMBERFLOW_RUNNER_URL ?? DEFAULT_BASE_URL;
}

/** SSE-shaped events emitted on GET /runs/:id/events — mirrors server/runRegistry.ts RunEvent. */
export type RunEvent =
  | { type: 'nodeState'; nodeId: string; state: NodeRunState }
  | { type: 'log'; line: LogLine }
  | { type: 'finished'; run: WorkflowRun };

/** Thrown when the runner cannot be reached at all (connection refused, DNS, etc). */
export class RunnerUnreachableError extends Error {
  constructor(cause?: unknown) {
    super(`runner unreachable at ${baseUrl()} — is \`npm run server\` running?`);
    this.name = 'RunnerUnreachableError';
    this.cause = cause;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, init);
  } catch (err) {
    throw new RunnerUnreachableError(err);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      /* body wasn't JSON — keep the status text */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function health(): Promise<{ status: string }> {
  return request('/healthz');
}

export async function listWorkflows(): Promise<WorkflowDefinition[]> {
  const { flows } = await request<{ flows: WorkflowDefinition[] }>('/workflows');
  return flows;
}

/** Fetches a single flow by id from the full workflow list (no single-flow GET endpoint). */
export async function getWorkflow(id: string): Promise<WorkflowDefinition | undefined> {
  const flows = await listWorkflows();
  return flows.find((f) => f.id === id);
}

export interface NodeMeta {
  type: string;
  label?: string;
  description?: string;
  category?: string;
  traceKind?: string;
  effects?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  source?: string;
}

/** The runner's LIVE node registry (built-ins + the project's registerNodes),
 *  so the CLI sees the same nodes execution does — not a project-blind local
 *  createDefaultRegistry(). */
export async function listNodes(): Promise<NodeMeta[]> {
  const { nodes } = await request<{ nodes: NodeMeta[] }>('/nodes');
  return nodes;
}

/** Validate a flow against the runner's live registry (built-ins + project nodes). */
export async function validateOperation(
  flow: WorkflowDefinition,
): Promise<{ valid: boolean; issues: unknown[] }> {
  return request('/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flow }),
  });
}

export async function saveWorkflow(flow: WorkflowDefinition): Promise<void> {
  await request(`/workflows/${encodeURIComponent(flow.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(flow),
  });
}

/** One summary per operation with its on-disk `path` (id === path) and `http`
 *  trigger metadata (undefined for internal sub-flows). Sourced from the
 *  `operations[]` array of `GET /workflows`. */
export async function listOperations(): Promise<OpSummary[]> {
  const { operations } = await request<{ operations: OpSummary[] }>('/workflows');
  return operations;
}

/** Builds the API tree (apis → folders → operations) client-side from the flat
 *  `operations[]` summaries, splitting each op's `path` into [api, …folders, op].
 *  Mirrors the server's `ApiStore.tree()` so no extra runner route is needed. */
export async function apiTree(): Promise<ApiTree> {
  const ops = await listOperations();
  const apis = new Map<string, ApiNode>();
  const folderAt = (parent: { folders: FolderNode[] }, name: string): FolderNode => {
    let f = parent.folders.find((x) => x.name === name);
    if (!f) { f = { name, folders: [], operations: [] }; parent.folders.push(f); }
    return f;
  };
  for (const op of ops) {
    const parts = op.path.split('/'); // [api, ...folders, opName]
    const apiName = parts[0];
    let api = apis.get(apiName);
    if (!api) { api = { name: apiName, folders: [], operations: [] }; apis.set(apiName, api); }
    let container: { folders: FolderNode[]; operations: OpSummary[] } = api;
    for (const fp of parts.slice(1, -1)) container = folderAt(container, fp);
    container.operations.push(op);
  }
  return { apis: [...apis.values()] };
}

/** Result of a create-operation attempt: `ok: false` always carries a message
 *  (e.g. a 409 collision) so a creation failure is never silent. */
export interface CreateOperationResult { ok: boolean; error?: string }

/**
 * Creates a brand-new operation at an explicit `apis/` path via
 * `POST /operations { flow, path }`. The runner enforces `flow.id === path` and
 * 409s if an operation already exists at that path (never overwrites — that's
 * `saveWorkflow`/PUT). Mirrors `src/store/serverRunner.ts createOperationOnServer`.
 */
/** Delete an operation by id (its apis-tree path). id is URL-encoded so slash
 *  ids match the /workflows/:id route. Returns ok:false with a message on 404. */
export async function deleteOperation(id: string): Promise<CreateOperationResult> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (err) {
    throw new RunnerUnreachableError(err);
  }
  if (res.status === 204 || res.ok) return { ok: true };
  const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
  return { ok: false, error: body?.error ?? `Delete failed with status ${res.status}` };
}

export async function createOperation(
  flow: WorkflowDefinition,
  path: string,
): Promise<CreateOperationResult> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/operations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow, path }),
    });
  } catch (err) {
    throw new RunnerUnreachableError(err);
  }
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
  return { ok: false, error: body?.error ?? `Request failed with status ${res.status}` };
}

export interface StartRunOptions {
  /** A flow to run under dev semantics (mutually exclusive with `artifact`). */
  flow?: WorkflowDefinition;
  /** A sealed artifact to run under production semantics (mutually exclusive with `flow`). */
  artifact?: PublishedArtifact;
  /** Pinned node outputs; ignored/rejected by the runner in production. */
  pins?: Record<string, unknown>;
  /** The invocation payload, exposed to nodes as ctx.runInput. */
  input?: Record<string, unknown>;
  /** Explicit env override; artifact runs always force 'production' regardless. */
  env?: 'dev' | 'production';
  /** Named environment to run against (from emberflow.environments.json); omitted → runner default. */
  environment?: string;
  /** Explicit safe-mode override; omitted → environment's default (protected ⇒ true). */
  safeMode?: boolean;
  /** Required to equal `environment` when explicitly disabling safe mode on a protected environment. */
  confirm?: string;
}

export async function startRun(opts: StartRunOptions): Promise<string> {
  const { flow, artifact, pins, input, env, environment, safeMode, confirm } = opts;
  const { runId } = await request<{ runId: string }>('/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flow, artifact, mode: 'run', pins, input, env, environment, safeMode, confirm }),
  });
  return runId;
}

export interface EnvironmentSummary {
  name: string;
  protected: boolean;
  varKeys: string[];
  secretKeys: string[];
  auth?: { configured: boolean; authenticated: boolean; secretRef?: string };
}

export async function listEnvironments(): Promise<{ defaultEnvironment: string; environments: EnvironmentSummary[] }> {
  return request('/environments');
}

/** Performs the named environment's configured login, storing the captured
 *  credential runner-side. Never returns the secret value — only whether the
 *  login succeeded and which secret it landed in. */
export async function loginEnvironment(name: string): Promise<{ authenticated: boolean; secretRef: string }> {
  return request(`/environments/${encodeURIComponent(name)}/login`, { method: 'POST' });
}

/** Sets (or, when `auth` is `null`, clears) an environment's auth config via
 *  `PUT /environments/:name/auth`. Never sends secret values — `auth` carries
 *  only refs/names (attach.secretRef, login.request.bodyRef). 204 on success. */
export async function setEnvironmentAuth(name: string, auth: unknown): Promise<void> {
  await request(`/environments/${encodeURIComponent(name)}/auth`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(auth),
  });
}

/** Flips whether mounted HTTP endpoints execute for real or answer from
 *  scenario expectations (mock), via `POST /serving`. 204 on success; a
 *  bogus mode is rejected by the runner (surfaced via request()'s error path). */
export async function setServingMode(mode: 'real' | 'mock'): Promise<void> {
  await request('/serving', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
}

export async function samples(nodeId: string): Promise<NodeExecutionSample[]> {
  const { samples: results } = await request<{ samples: NodeExecutionSample[] }>(
    `/samples?nodeId=${encodeURIComponent(nodeId)}`,
  );
  return results;
}

/**
 * Opens the run's SSE stream and collects events until `finished`.
 * Parses the stream by hand: messages are separated by a blank line, each
 * made of `event:`/`data:` lines; lines starting with `:` are heartbeat
 * comments and are ignored.
 */
export async function waitForRun(runId: string): Promise<{ run: WorkflowRun; logs: LogLine[] }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/runs/${encodeURIComponent(runId)}/events`);
  } catch (err) {
    throw new RunnerUnreachableError(err);
  }
  if (!res.ok || !res.body) {
    throw new Error(`Failed to open event stream for run ${runId}: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const logs: LogLine[] = [];
  let finalRun: WorkflowRun | undefined;

  const processMessage = (raw: string): void => {
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.length === 0 || line.startsWith(':')) continue;
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const event = JSON.parse(dataLines.join('\n')) as RunEvent;
    if (event.type === 'log') logs.push(event.line);
    else if (event.type === 'finished') finalRun = event.run;
  };

  try {
    while (!finalRun) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sepIndex: number;
      while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        processMessage(raw);
        if (finalRun) break;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!finalRun) throw new Error(`Run ${runId} stream ended before a "finished" event was received`);
  return { run: finalRun, logs };
}
