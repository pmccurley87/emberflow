export type FieldType =
  | 'string' | 'number' | 'boolean' | 'enum'
  | 'datetime' | 'object' | 'array';

export interface FieldDefinition {
  name: string;
  type: FieldType;
  required?: boolean;
  enumValues?: string[];
  description?: string;
}

export interface SchemaDefinition {
  fields: FieldDefinition[];
}

export interface NodeDefinition {
  type: string;
  label: string;
  description?: string;
  /**
   * Plain-language one-liner for non-developers, shown in the simple register
   * (runbook idle text, simple Inspector description) instead of `description`,
   * which may lead with mechanism (PORT NOTE, file paths, implementation
   * detail). Falls back to the first sentence of `description` when absent.
   */
  simpleDescription?: string;
  category?: string;
  inputSchema?: SchemaDefinition;
  outputSchema?: SchemaDefinition;
  configSchema?: SchemaDefinition;
  icon?: string;
  tags?: string[];
  /**
   * Side-effect class. 'mutation' nodes write state someone else can observe
   * (DB writes, emails, external POSTs that create/change resources) and are
   * dry-run under safe mode. Absent = 'read' (default).
   */
  effects?: 'read' | 'mutation';
  /**
   * What kind of work this node does, for the runbook's technical register. Pure
   * documentation — the engine ignores it. 'db' = queries Postgres, 'http' =
   * calls an external service over HTTP, 'llm' = calls a language model,
   * 'compute' = pure in-process logic. Absent when unknown (an absent badge is
   * honest; a wrong one is not).
   */
  traceKind?: 'db' | 'http' | 'llm' | 'compute';
  /**
   * A short, STATIC technical descriptor of the concrete call this node makes,
   * for the runbook's technical register (the trace badge hover card). Pure
   * documentation — the engine ignores it. For 'db' the query shape (e.g.
   * 'SELECT … FROM projects JOIN users … WHERE p.id = $1'); for 'http' the
   * method + endpoint (e.g. 'POST https://oauth2.googleapis.com/token'); for
   * 'llm' the provider + model (e.g. 'openrouter.ai · x-ai/grok-4.3:online').
   * Describes the mechanism, NOT runtime values. Absent on 'compute' nodes and
   * whenever the target is dynamic enough that no honest static shape exists.
   */
  traceDetail?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Outcome of running a child workflow synchronously via a Subflow node. */
export interface SubflowResult {
  status: 'succeeded' | 'failed';
  output?: unknown;
  error?: string;
}

export interface NodeExecutionContext {
  input: Record<string, unknown>;
  config: Record<string, unknown>;
  /** Runner-supplied secrets; empty in browser execution. */
  secrets: Record<string, string>;
  /** Non-secret environment values (API base URLs, seed ids, flags). Empty in browser execution. */
  vars: Record<string, string>;
  /** The environment name this run targets (e.g. 'prod'); undefined in browser/in-tab runs. */
  environment?: string;
  /** When true, mutation nodes must dry-run their side effects instead of executing them. */
  safeMode: boolean;
  /** The payload this run was invoked with (emberflow.run(name, input)). */
  runInput: Record<string, unknown>;
  log: (level: LogLevel, message: string) => void;
  /**
   * Runs a child workflow to completion and returns its collected output.
   * Provided by the host (browser store / server run registry); absent when the
   * run has no way to look up other workflows, in which case a Subflow node
   * fails with a clear message.
   */
  runSubflow?: (workflowId: string, input: Record<string, unknown>) => Promise<SubflowResult>;
}

export type NodeImplementation = (ctx: NodeExecutionContext) => Promise<unknown>;

export interface FieldMapping {
  sourceNodeId: string;
  /** Dot path into the source node's output. '$' means the entire output. */
  sourceField: string;
  transform?: string;
}

export interface WorkflowNode {
  id: string;
  type: string;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  inputMap?: Record<string, FieldMapping>;
  /**
   * Fail-soft flag. When true, this node throwing marks it `failed` but does
   * NOT abort the run: the cursor continues, so independent branches still run
   * and the run can finish `succeeded`. The failed node produces no output, so
   * its downstream consumers become unreachable (dead edges) and skip — exactly
   * like a live "mirror" step whose failure must not break the deterministic
   * path beside it. A non-optional node's failure still aborts the run.
   *
   * Applies to standard node execution. A ForEach region's own setup failure is
   * NOT fail-soft (the flag is ignored there); mark ordinary/Subflow nodes.
   */
  optional?: boolean;
  /**
   * Retry the implementation call on throw. `maxTries` is the total number of
   * attempts including the first (so `maxTries: 3` means up to 2 retries).
   * `waitMs` (default 0) is a fixed delay between attempts. Only the
   * `implementation({...})` call is retried — config/input resolution runs
   * once, and only the final attempt's outcome is recorded (state, trace,
   * fail-soft). A non-object value or `maxTries < 1` is treated as absent.
   */
  retry?: { maxTries: number; waitMs?: number };
  /** Builder-owned extras (e.g. pinnedOutput). The engine never reads this. */
  metadata?: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
}

export interface ScenarioDefinition {
  id: string;
  name: string;
  description?: string;
  /** Run payload, same shape as StartRunOptions.input. For an operation (a flow
   *  with `http`), this is the request shape `{ params?, query?, body?, headers? }`
   *  — an in-studio "Run" of a scenario passes this object as `input` through the
   *  same `RunRegistry.create` path a live HTTP request builds and passes, so the
   *  two are parity-equivalent (see server/httpOperations.test.ts). For a non-HTTP
   *  (internal) flow, `input` is used as-is — unchanged behavior. */
  input: Record<string, unknown>;
  /** Optional assertion the scenario's run must satisfy. Consumed by `emberflow
   *  test` (evaluateExpectation in server/scenarioTest.ts) and mock mode; a
   *  scenario without `expect` is a fixture only (not assertable). */
  expect?: ScenarioExpectation;
  /** nodeId -> canned output (verbatim, same shape the implementation would return).
   *  Consulted only when the run has `mockRun: true`; merges over the operation-level
   *  mocks map (scenario wins per nodeId). Plumbing (reading/merging these into a run)
   *  is a later increment — this is type-only for now. */
  mocks?: Record<string, unknown>;
}

/** Assertion checked against a scenario's run + its flow's response mapping.
 *  `body` is a deep-subset match (see evaluateExpectation): every expected key
 *  must match recursively, arrays compare index-wise on the expected prefix,
 *  extra actual keys are fine, and `null` matches only `null`. */
export interface ScenarioExpectation {
  /** Expected HTTP status of the extracted response (default response is 200). */
  status?: number;
  /** Expected response body, matched as a deep subset of the actual body. */
  body?: unknown;
  /** Node ids expected to have run to `succeeded`. */
  executedNodes?: string[];
}

/** An inheritable auth policy: scheme + secret ref + optional named verifier.
 *  Set at the API/folder level via `_meta.json` (inherited by descendants) or
 *  overridden per-operation via `HttpTrigger.auth`. Lives here (not in
 *  server/auth/types.ts) because src/ must not import from server/; server/auth/types.ts
 *  re-exports this type. */
export interface AuthPolicy {
  scheme: 'bearer' | 'apiKey';
  /** Name of the secret (in the run environment's secrets) holding the expected token/key. */
  secretRef: string;
  /** Optional named custom verifier; when set, overrides the built-in scheme verifier. */
  verify?: string;
  /** Header to read for apiKey (default 'x-api-key'); bearer always reads Authorization. */
  header?: string;
}

/** HTTP trigger metadata for an operation. Routing is a later increment; this
 *  increment only stores/round-trips it. */
export interface HttpTrigger {
  method: string;
  path: string;
  inputSchema?: unknown;
  /** Effective auth policy for this operation. 'none' makes it explicitly
   *  public (overriding any inherited _meta.json policy); 'inherit' (or
   *  absent) defers to the nearest ancestor _meta.json's policy, if any. */
  auth?: AuthPolicy | 'none' | 'inherit';
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: number;
  /** Optional sidebar folder path (single level, e.g. "Anomaly Detection"). */
  folder?: string;
  /** Present → this flow is (or will be) an HTTP endpoint. Absent → internal sub-flow. */
  http?: HttpTrigger;
  /**
   * Preferred environment name. When set and the runner offers a matching
   * environment, opening this flow auto-selects it — so a flow that targets
   * prod infrastructure doesn't silently run against local.
   */
  environment?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Named test inputs ("storybook" scenarios). Dev fixtures — stripped on publish. */
  scenarios?: ScenarioDefinition[];
  /** Op-level nodeId -> canned output (verbatim), consulted only when a run
   *  has `mockRun: true`. Merges under any per-scenario `mocks` (scenario
   *  wins per nodeId — see `ScenarioDefinition.mocks`). Lives in the
   *  `<op>.scenarios.json` sidecar alongside `scenarios`, exposed here by
   *  the store that loads it (e.g. `ApiStore`). Dev fixture — stripped on
   *  publish, same as `scenarios`. */
  mocks?: Record<string, unknown>;
  viewport?: { x: number; y: number; zoom: number };
  createdAt: string;
  updatedAt: string;
}

export type NodeStatus =
  | 'idle' | 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** One execution of a node within a loop region — one entry per iteration. */
export interface ExecutionRecord {
  iteration: { index: number; total: number };
  input?: unknown;
  output?: unknown;
  error?: string;
  status: 'succeeded' | 'failed';
}

export interface NodeRunState {
  status: NodeStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  /** True when this node's output came from a pin instead of execution. */
  pinned?: boolean;
  /** True when a mutation-declared node completed under safe mode (its writes were dry-run). */
  mutationBlocked?: boolean;
  /**
   * Present on a ForEach node and its loop-body nodes while a loop region is
   * iterating (and left at its last value once the loop completes), giving
   * the 0-based position and total iteration count.
   */
  iteration?: { index: number; total: number };
  /**
   * Full per-iteration execution history, present on a ForEach node and its
   * loop-body nodes, ordered by iteration. Absent on non-loop executions.
   */
  executions?: ExecutionRecord[];
  /**
   * Total number of implementation-call attempts (including the first),
   * present only when the node has a `retry` and used more than one attempt
   * to reach its final outcome (success or exhausted failure). Absent
   * whenever a single attempt sufficed — including nodes without `retry` at
   * all — so existing single-try consumers see no shape change.
   */
  attempts?: number;
  /** True when this node's output is a canned mock value from a mock run, not the result of executing its implementation. */
  mocked?: boolean;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  /** The environment this run pointed at (from StartRunOptions.environment). */
  environment?: string;
  /** Whether safe mode was active for this run. */
  safeMode?: boolean;
  nodeStates: Record<string, NodeRunState>;
}

export interface LogLine {
  timestamp: string;
  level: LogLevel;
  runId: string;
  nodeId?: string;
  nodeLabel?: string;
  message: string;
}

export interface NodeExecutionSample {
  id: string;
  workflowId: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  input: unknown;
  output?: unknown;
  status: 'succeeded' | 'failed';
  startedAt: string;
  completedAt?: string;
}
