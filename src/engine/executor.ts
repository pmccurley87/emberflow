import type {
  ExecutionRecord, LogLevel, LogLine, NodeRunState, SubflowResult,
  WorkflowDefinition, WorkflowNode, WorkflowRun,
} from './types';
import type { NodeRegistry } from './registry';
import type { TraceSink } from './trace';
import { computeLoopRegions, topoSort, validateFlow } from './validation';
import type { LoopRegion } from './validation';

export function getByPath(obj: unknown, path: string): unknown {
  if (path === '$') return obj;
  return path.split('.').reduce<unknown>(
    (acc, key) =>
      acc !== null && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
    obj,
  );
}

// Matches the V8 shapes ("Cannot read properties of undefined/null (reading 'x')")
// and the older/Safari-style shape ("undefined is not an object (evaluating 'a.x')")
// for reading a property off undefined or null.
const UNDEFINED_READ_PATTERN =
  /^(Cannot read properties of (?:undefined|null) \(reading '[^']*'\)|undefined is not an object \(evaluating '[^']*'\))$/;

/**
 * Enriches a "reading property of undefined/null" TypeError message with the
 * node's resolved input keys, so the recorded error points at what the node
 * actually received instead of just the raw JS engine message. Every other
 * message passes through byte-identical.
 */
export function explainUndefinedRead(message: string, input: Record<string, unknown>): string {
  if (!UNDEFINED_READ_PATTERN.test(message)) return message;
  // A field mapped in `inputMap` whose source produced nothing still appears as
  // a key, holding `undefined` — and that is almost always the culprit here.
  // Listing it alongside the fields that actually carry a value is what turns
  // this from a raw JS message into a pointer at the broken mapping.
  const present = Object.keys(input).filter((k) => input[k] !== undefined).sort();
  const undef = Object.keys(input).filter((k) => input[k] === undefined).sort();
  const got = present.length > 0 ? `[${present.join(', ')}]` : '(none)';
  const missing =
    undef.length > 0
      ? ` These mapped fields resolved to undefined: ${undef.join(', ')}.`
      : '';
  return `${message} — this node received ${got}.${missing} Check the node's inputMap and the run input.`;
}

/** A `{"$env": "NAME"}` reference resolves to `vars["NAME"]`. */
function envRefName(value: unknown): string | undefined {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).$env === 'string'
  ) {
    return (value as { $env: string }).$env;
  }
  return undefined;
}

function resolveEnvRef(name: string, vars: Record<string, string>): string {
  if (!(name in vars)) {
    // The most common cause is not a missing key but a run with NO environment
    // at all: an environment-less run (e.g. a scenario test) has no vars, so
    // flows seeded with $env refs need a real environment. Say so, instead of a
    // bare "missing".
    const hint =
      Object.keys(vars).length === 0
        ? ' — this run has no environment variables; run it against an environment that defines them'
        : '';
    throw new Error(`Missing environment variable: ${name}${hint}`);
  }
  return vars[name];
}

/**
 * Recursively replaces every `{"$env": "NAME"}` reference in a value (objects
 * and arrays walked) with its resolved var. A missing var throws
 * `Missing environment variable: NAME`. Non-ref values pass through untouched.
 */
function resolveEnvDeep(value: unknown, vars: Record<string, string>): unknown {
  const name = envRefName(value);
  if (name !== undefined) return resolveEnvRef(name, vars);
  if (Array.isArray(value)) return value.map((v) => resolveEnvDeep(v, vars));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveEnvDeep(v, vars);
    }
    return out;
  }
  return value;
}

/**
 * Appends one ExecutionRecord to a loop-body (or ForEach) node's
 * accumulated per-iteration history. Pure — callers must read the prior
 * array themselves, from whatever point in the node's state lifecycle it is
 * still intact (setNodeState replaces the state object wholesale on every
 * call, so an intermediate 'running'/'skipped' write can otherwise wipe it
 * out before the caller gets a chance to read it back).
 */
function appendExecution(
  prior: ExecutionRecord[] | undefined,
  record: ExecutionRecord,
): ExecutionRecord[] {
  return [...(prior ?? []), record];
}

export interface ExecutorEvents {
  onNodeStateChange?: (nodeId: string, state: NodeRunState) => void;
  onLog?: (line: LogLine) => void;
  onRunFinished?: (run: WorkflowRun) => void;
}

/** Mutable state for the loop region currently being driven by the cursor. */
interface ActiveLoopState {
  region: LoopRegion;
  forEachNode: WorkflowNode;
  collectNode: WorkflowNode;
  /** Body node ids in region topo order (main topo order filtered to the region). */
  bodyOrder: string[];
  /** The full `items` array resolved once, at loop start. */
  items: unknown[];
  /** One entry per iteration: the element (batchSize 1) or the chunk array. */
  chunks: unknown[];
  /** Iteration currently in flight (or about to start once the body position resets). */
  iterIndex: number;
  /** Position within bodyOrder for the current iteration. */
  bodyCursor: number;
  /** Collect's mapped value, one per completed iteration. */
  results: unknown[];
}

export interface StartRunOptions {
  flow: WorkflowDefinition;
  registry: NodeRegistry;
  trace?: TraceSink;
  events?: ExecutorEvents;
  now?: () => string;
  newId?: () => string;
  secrets?: Record<string, string>;
  /** Non-secret environment values, exposed as ctx.vars and used to resolve {"$env": NAME}. */
  vars?: Record<string, string>;
  /** When true, mutation nodes dry-run their side effects; recorded on the run. */
  safeMode?: boolean;
  /** The environment name this run points at; recorded on the run. */
  environment?: string;
  /** nodeId -> pinned output. Pinned nodes skip execution and tracing. */
  pins?: Record<string, unknown>;
  /**
   * When true, runs in Mock mode: nodes with a canned output in `mocks` return
   * it verbatim without invoking their implementation or the retry loop; nodes
   * that would touch infrastructure (`traceKind` 'db'/'http'/'llm') and have no
   * mock fail loud (a normal node failure — respects `optional`, halts like any
   * error). Pure/compute nodes (`traceKind` 'compute' or absent) always execute
   * their real implementation, mocked or not. Defaults false; when false,
   * `mocks` is ignored entirely (Live behavior is byte-identical to today).
   */
  mockRun?: boolean;
  /** nodeId -> canned output, consulted only when `mockRun` is true. See `mockRun`. */
  mocks?: Record<string, unknown>;
  /** The invocation payload, exposed to nodes as ctx.runInput. */
  input?: Record<string, unknown>;
  /**
   * Host-provided runner for Subflow nodes: given a workflow id + input, runs
   * that child flow to completion and returns its collected output. The
   * executor injects the calling node's id (for log prefixing / cycle context);
   * the host owns workflow lookup and the recursion/cycle guard. Absent when
   * the host can't resolve other workflows.
   */
  subflowRunner?: (
    workflowId: string,
    input: Record<string, unknown>,
    callerNodeId: string,
  ) => Promise<SubflowResult>;
}

export class FlowRun {
  readonly run: WorkflowRun;
  private readonly flow: WorkflowDefinition;
  private readonly registry: NodeRegistry;
  private readonly trace?: TraceSink;
  private readonly events: ExecutorEvents;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly secrets: Record<string, string>;
  private readonly vars: Record<string, string>;
  private readonly environment?: string;
  private readonly safeMode: boolean;
  private readonly runInput: Record<string, unknown>;
  private readonly pins: Record<string, unknown>;
  private readonly mockRun: boolean;
  private readonly mocks: Record<string, unknown>;
  private readonly subflowRunner?: StartRunOptions['subflowRunner'];
  private readonly order: string[];
  private readonly outputs = new Map<string, unknown>();
  private readonly skippedNodes = new Set<string>();
  private readonly branchTaken = new Map<string, string>();
  private readonly regionByForEach: Map<string, LoopRegion>;
  /** Nodes a completed loop region already executed; the main cursor consumes them silently. */
  private readonly loopExecuted = new Set<string>();
  private activeLoop?: ActiveLoopState;
  private cursor = 0;
  /** Run-wide execution counter — numbers every node execution in the log. */
  private execSeq = 0;

  constructor(opts: StartRunOptions) {
    this.flow = opts.flow;
    this.registry = opts.registry;
    this.trace = opts.trace;
    this.events = opts.events ?? {};
    this.now = opts.now ?? (() => new Date().toISOString());
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.secrets = opts.secrets ?? {};
    this.vars = opts.vars ?? {};
    this.environment = opts.environment;
    this.safeMode = opts.safeMode ?? false;
    // Resolve {"$env": NAME} anywhere in the run-input payload up front, so
    // nodes read concrete values from ctx.runInput and a missing var fails the
    // run at start rather than deep inside a node.
    this.runInput = resolveEnvDeep(opts.input ?? {}, this.vars) as Record<string, unknown>;
    this.pins = opts.pins ?? {};
    this.mockRun = opts.mockRun ?? false;
    this.mocks = opts.mocks ?? {};
    this.subflowRunner = opts.subflowRunner;
    this.order = topoSort(this.flow);
    this.regionByForEach = new Map(computeLoopRegions(this.flow).map((r) => [r.forEachId, r]));
    this.run = {
      id: this.newId(),
      workflowId: this.flow.id,
      status: 'running',
      startedAt: this.now(),
      ...(opts.environment !== undefined ? { environment: opts.environment } : {}),
      ...(opts.safeMode !== undefined ? { safeMode: opts.safeMode } : {}),
      nodeStates: {},
    };
    // No events from the constructor: subscribers' closures may not be
    // initialized yet. Initial states are readable via handle.run.
    for (const node of this.flow.nodes) {
      this.run.nodeStates[node.id] = { status: 'queued' };
    }
  }

  async step(): Promise<boolean> {
    if (this.run.status !== 'running' || this.cursor >= this.order.length) return false;

    if (this.activeLoop) return this.stepLoop();

    // Consume nodes a finished loop region already executed (topo order may
    // interleave them with parallel non-region nodes), and nodes whose every
    // incoming edge is dead (untaken route branch or skipped ancestor) —
    // the latter are marked skipped, not executed.
    while (this.cursor < this.order.length) {
      const id = this.order[this.cursor];
      if (this.loopExecuted.has(id)) {
        this.cursor += 1;
        continue;
      }
      if (!this.isReachable(id)) {
        this.cursor += 1;
        this.skippedNodes.add(id);
        this.setNodeState(id, { status: 'skipped' });
        continue;
      }
      break;
    }
    if (this.cursor >= this.order.length) {
      this.finish('succeeded');
      return false;
    }

    const nodeId = this.order[this.cursor];
    this.cursor += 1;

    // A reachable ForEach hands execution to the loop machinery, which owns
    // the whole region (ForEach + body + Collect) until the Collect
    // completes; the main cursor then resumes right after it.
    const region = this.regionByForEach.get(nodeId);
    if (region) return this.startLoop(region);

    const ok = await this.executeNode(nodeId);
    if (!ok) return false;
    return this.epilogue();
  }

  /**
   * Runs one node's implementation (or reuses its pin) end to end: resolve
   * config/input, execute, record state + trace, handle failure. Shared by
   * the main cursor and by loop-body execution, which additionally tags the
   * resulting NodeRunState with the current iteration.
   */
  private async executeNode(
    nodeId: string,
    iteration?: { index: number; total: number },
  ): Promise<boolean> {
    const node = this.flow.nodes.find((n) => n.id === nodeId)!;
    const iterationState = iteration ? { iteration } : {};
    // Ordered execution receipt: every execution gets a run-wide sequence
    // number, so the log is proof of exactly what ran, in what order — and
    // that non-loop nodes run once (only loop iterations repeat a label).
    this.execSeq += 1;
    this.emitLog(
      'debug',
      `#${this.execSeq} ▶ execute${iteration ? ` (iteration ${iteration.index + 1}/${iteration.total})` : ''}`,
      node,
    );
    // Captured up front: the 'running' state set below replaces the node's
    // state object wholesale, which would otherwise wipe out `executions`
    // before the completion branch gets a chance to read it back out.
    const priorExecutions = iteration ? this.run.nodeStates[nodeId]?.executions : undefined;

    if (Object.prototype.hasOwnProperty.call(this.pins, nodeId)) {
      const output = this.pins[nodeId];
      const at = this.now();
      this.outputs.set(nodeId, output);
      this.captureBranch(nodeId, output);
      const executions = iteration
        ? appendExecution(priorExecutions, { iteration, output, status: 'succeeded' })
        : undefined;
      this.setNodeState(nodeId, {
        status: 'succeeded', output, pinned: true, startedAt: at, completedAt: at, ...iterationState,
        ...(executions ? { executions } : {}),
      });
      this.emitLog('info', `${node.label}: using pinned output`, node);
      return true;
    }

    const { definition, implementation } = this.registry.get(node.type);
    const startedAt = this.now();
    let input: Record<string, unknown> = {};
    // Hoisted above the try so both the success path and the shared catch
    // below can read the final attempt count. Stays at 1 (so `attempts` is
    // never stamped) unless the retry loop actually runs more than once —
    // config/input-resolution failures above the loop never touch it.
    let attempt = 1;

    // In a mock run, a mocked node's canned output and an infra-no-mock
    // failure both apply BEFORE config resolution: the node's real
    // implementation never runs either way, so a config value it would
    // otherwise need (e.g. a `$secret` ref with no secret configured) must
    // never fail the node first. Only the inputMap-derived fields (other
    // nodes' outputs — never secrets) are resolved for `state.input` here;
    // config-sourced input fields are skipped (lenient), since resolving them
    // is exactly the thing that could throw.
    const isMocked = this.mockRun && Object.prototype.hasOwnProperty.call(this.mocks, nodeId);
    const isInfraNoMock =
      this.mockRun &&
      !isMocked &&
      (definition.traceKind === 'db' || definition.traceKind === 'http' || definition.traceKind === 'llm');

    try {
      if (isMocked) {
        // Canned output: short-circuits before config resolution and the
        // retry loop — the implementation is never invoked, so no retry
        // machinery applies and a `$secret` config ref never throws.
        input = this.resolveInputLenient(node);
        this.setNodeState(nodeId, { status: 'running', input, startedAt, ...iterationState });
        const output = this.mocks[nodeId];
        const completedAt = this.now();
        this.outputs.set(nodeId, output);
        this.captureBranch(nodeId, output);
        const executions = iteration
          ? appendExecution(priorExecutions, { iteration, input, output, status: 'succeeded' })
          : undefined;
        this.setNodeState(nodeId, {
          status: 'succeeded', input, output, startedAt, completedAt, mocked: true, ...iterationState,
          ...(executions ? { executions } : {}),
        });
        this.recordSample(node, input, startedAt, completedAt, 'succeeded', output);
        return true;
      }
      if (isInfraNoMock) {
        // Fail-loud infrastructure boundary: thrown before config resolution
        // (a `$secret` ref must not out-race this with "Missing secret"), as
        // a normal implementation error (caught below), so `optional`
        // fail-soft, halting semantics, and the error-workflow path all apply
        // unchanged.
        input = this.resolveInputLenient(node);
        this.setNodeState(nodeId, { status: 'running', input, startedAt, ...iterationState });
        throw new Error(
          `"${node.label}" would touch real infrastructure (${definition.traceKind}) and has no mock — ` +
            `in Mock, infrastructure nodes need a canned output. Add one under this scenario's mocks ` +
            `(Cover with AI writes them), or go Live to run it for real.`,
        );
      }

      const config = this.resolveConfig(node);
      input = this.resolveInput(node, config);
      this.setNodeState(nodeId, { status: 'running', input, startedAt, ...iterationState });

      const rawRetry = node.retry;
      const maxTries =
        rawRetry && typeof rawRetry === 'object' && Number.isFinite(rawRetry.maxTries) && rawRetry.maxTries >= 1
          ? rawRetry.maxTries
          : 1;
      const waitMs = rawRetry?.waitMs ?? 0;
      const callImplementation = () =>
        implementation({
          input,
          config,
          secrets: this.secrets,
          vars: this.vars,
          environment: this.environment,
          safeMode: this.safeMode,
          runInput: this.runInput,
          log: (level: LogLevel, message: string) => this.emitLog(level, message, node),
          // Inject the calling node's id so the host can prefix child logs and
          // report cycle context; the node's ctx.runSubflow stays (id, input).
          ...(this.subflowRunner
            ? {
                runSubflow: (workflowId: string, subInput: Record<string, unknown>) =>
                  this.subflowRunner!(workflowId, subInput, node.id),
              }
            : {}),
        });
      let output: unknown;
      for (attempt = 1; ; attempt++) {
        try {
          output = await callImplementation();
          break;
        } catch (err) {
          if (attempt >= maxTries) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          this.emitLog('warn', `retry ${attempt}/${maxTries} after error: ${msg}`, node);
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      const completedAt = this.now();
      this.outputs.set(nodeId, output);
      this.captureBranch(nodeId, output);
      const executions = iteration
        ? appendExecution(priorExecutions, { iteration, input, output, status: 'succeeded' })
        : undefined;
      const mutationBlocked = this.safeMode && definition.effects === 'mutation';
      this.setNodeState(nodeId, {
        status: 'succeeded', input, output, startedAt, completedAt, ...iterationState,
        ...(mutationBlocked ? { mutationBlocked: true } : {}),
        ...(executions ? { executions } : {}),
        ...(attempt > 1 ? { attempts: attempt } : {}),
      });
      this.recordSample(node, input, startedAt, completedAt, 'succeeded', output);
      return true;
    } catch (err) {
      const completedAt = this.now();
      const rawMessage = err instanceof Error ? err.message : String(err);
      const error =
        err instanceof TypeError ? explainUndefinedRead(rawMessage, input) : rawMessage;
      const executions = iteration
        ? appendExecution(priorExecutions, { iteration, input, error, status: 'failed' })
        : undefined;
      this.setNodeState(nodeId, {
        status: 'failed', input, error, startedAt, completedAt, ...iterationState,
        ...(executions ? { executions } : {}),
        ...(attempt > 1 ? { attempts: attempt } : {}),
      });
      this.recordSample(node, input, startedAt, completedAt, 'failed');
      this.emitLog('error', error, node);
      // Fail-soft: an `optional` node's failure is recorded (state stays
      // 'failed', visible in the runbook) but does not abort the run. It set no
      // output, so its downstream edges are dead (isReachable) and dependent
      // nodes skip, while independent branches keep running. The cursor was
      // already advanced past this node (step()), so returning true resumes at
      // the next node instead of finishing the run.
      if (node.optional) {
        return true;
      }
      this.finish('failed');
      return false;
    }
  }

  // ── ForEach/Collect loop region execution ───────────────────────────
  //
  // A region is driven across many step() calls, one node-execution each:
  // the ForEach "executes" once per iteration (producing {item, index,
  // total}), then each body node runs once per iteration in region topo
  // order (with branch-skip state reset per iteration), then once all
  // iterations are done the Collect executes exactly once. The main cursor
  // is parked at the position right after the Collect for the duration.

  /** First step on a reachable ForEach: resolve items, chunk, and start (or short-circuit) the region. */
  private async startLoop(region: LoopRegion): Promise<boolean> {
    const forEachNode = this.flow.nodes.find((n) => n.id === region.forEachId)!;
    const collectNode = this.flow.nodes.find((n) => n.id === region.collectId)!;
    const bodySet = new Set(region.bodyIds);
    const bodyOrder = this.order.filter((id) => bodySet.has(id));

    const startedAt = this.now();
    let input: Record<string, unknown> = {};
    try {
      const config = this.resolveConfig(forEachNode);
      input = this.resolveInput(forEachNode, config);
      const items = input.items;
      if (!Array.isArray(items)) {
        throw new Error(`ForEach "${forEachNode.label}": "items" input is not an array`);
      }

      const rawBatchSize = Number(config.batchSize);
      const batchSize = Number.isFinite(rawBatchSize) && rawBatchSize > 0 ? Math.floor(rawBatchSize) : 1;
      let chunks: unknown[] = [];
      for (let i = 0; i < items.length; i += batchSize) {
        chunks.push(batchSize === 1 ? items[i] : items.slice(i, i + batchSize));
      }

      const rawMax = config.maxIterations;
      const maxIterations =
        rawMax === undefined || rawMax === null || rawMax === '' ? undefined : Number(rawMax);
      if (maxIterations !== undefined && Number.isFinite(maxIterations) && chunks.length > maxIterations) {
        const truncated = chunks.length - maxIterations;
        this.emitLog(
          'warn',
          `maxIterations ${maxIterations} reached, truncating ${truncated} iterations`,
          forEachNode,
        );
        chunks = chunks.slice(0, maxIterations);
      }

      this.activeLoop = {
        region, forEachNode, collectNode, bodyOrder,
        items, chunks, iterIndex: 0, bodyCursor: 0, results: [],
      };

      if (chunks.length === 0) {
        const completedAt = this.now();
        const output = { item: undefined, index: 0, total: 0 };
        this.outputs.set(forEachNode.id, output);
        this.setNodeState(forEachNode.id, {
          status: 'succeeded', input, output, startedAt, completedAt, iteration: { index: 0, total: 0 },
        });
        this.recordSample(forEachNode, output, startedAt, completedAt, 'succeeded', output);
        for (const id of bodyOrder) {
          this.skippedNodes.add(id);
          this.setNodeState(id, { status: 'skipped', iteration: { index: 0, total: 0 } });
        }
        return true;
      }

      this.beginIteration(this.activeLoop);
      return true;
    } catch (err) {
      const completedAt = this.now();
      const error = err instanceof Error ? err.message : String(err);
      this.setNodeState(forEachNode.id, { status: 'failed', input, error, startedAt, completedAt });
      this.recordSample(forEachNode, input, startedAt, completedAt, 'failed');
      this.emitLog('error', error, forEachNode);
      this.finish('failed');
      return false;
    }
  }

  /**
   * Sets the ForEach's per-iteration output and resets body branch-skip
   * state. Also clears each body id's prior-iteration output: without this,
   * a body node that a branch skips this iteration would still resolve
   * downstream inputMap reads to whatever it produced last iteration, since
   * `outputs` is otherwise only ever overwritten (never cleared) by execution.
   */
  private beginIteration(loop: ActiveLoopState): void {
    const total = loop.chunks.length;
    const chunk = loop.chunks[loop.iterIndex];
    const output = { item: chunk, index: loop.iterIndex, total };
    const at = this.now();
    const iteration = { index: loop.iterIndex, total };
    this.outputs.set(loop.forEachNode.id, output);
    const executions = appendExecution(
      this.run.nodeStates[loop.forEachNode.id]?.executions,
      { iteration, output, status: 'succeeded' },
    );
    this.setNodeState(loop.forEachNode.id, {
      status: 'succeeded',
      input: { items: loop.items },
      output,
      startedAt: at,
      completedAt: at,
      iteration,
      executions,
    });
    this.recordSample(loop.forEachNode, chunk, at, at, 'succeeded', output);

    for (const id of loop.bodyOrder) {
      this.skippedNodes.delete(id);
      this.branchTaken.delete(id);
      this.outputs.delete(id);
    }
    loop.bodyCursor = 0;
  }

  /** One step of an in-progress region: a body node, an iteration advance, or the final Collect. */
  private async stepLoop(): Promise<boolean> {
    const loop = this.activeLoop!;

    if (loop.chunks.length === 0) {
      this.finishLoop(loop);
      return this.epilogue();
    }

    while (
      loop.bodyCursor < loop.bodyOrder.length &&
      !this.isReachable(loop.bodyOrder[loop.bodyCursor])
    ) {
      const deadId = loop.bodyOrder[loop.bodyCursor];
      loop.bodyCursor += 1;
      this.skippedNodes.add(deadId);
      // A skip is a status, not an execution: no ExecutionRecord is appended
      // for this iteration. But setNodeState replaces the state object
      // wholesale, so any executions accumulated in earlier iterations (this
      // branch may have been taken before, or will be again) must be carried
      // forward explicitly or they'd be lost.
      const priorExecutions = this.run.nodeStates[deadId]?.executions;
      this.setNodeState(deadId, {
        status: 'skipped',
        iteration: { index: loop.iterIndex, total: loop.chunks.length },
        ...(priorExecutions ? { executions: priorExecutions } : {}),
      });
    }

    if (loop.bodyCursor < loop.bodyOrder.length) {
      const nodeId = loop.bodyOrder[loop.bodyCursor];
      loop.bodyCursor += 1;
      const ok = await this.executeNode(nodeId, { index: loop.iterIndex, total: loop.chunks.length });
      return ok;
    }

    // This iteration's body is exhausted: gather Collect's mapped value and advance.
    loop.results.push(this.resolveCollectValue(loop.collectNode));
    loop.iterIndex += 1;

    if (loop.iterIndex < loop.chunks.length) {
      this.beginIteration(loop);
      return true;
    }

    this.finishLoop(loop);
    return this.epilogue();
  }

  /** Resolves Collect's `value` input against the current iteration's body outputs. */
  private resolveCollectValue(collectNode: WorkflowNode): unknown {
    const config = this.resolveConfig(collectNode);
    const input = this.resolveInput(collectNode, config);
    return input.value;
  }

  /**
   * Executes Collect once with the accumulated results and hands the region's
   * nodes to `loopExecuted` so the main cursor consumes them silently — it
   * must NOT jump past the Collect, because topo order can interleave
   * parallel non-region nodes between the ForEach and the Collect.
   */
  private finishLoop(loop: ActiveLoopState): void {
    const at = this.now();
    const output = { items: loop.results, count: loop.results.length };
    const lastValue = loop.results.length > 0 ? loop.results[loop.results.length - 1] : undefined;
    this.outputs.set(loop.collectNode.id, output);
    this.setNodeState(loop.collectNode.id, {
      status: 'succeeded', input: { value: lastValue }, output, startedAt: at, completedAt: at,
    });
    this.recordSample(loop.collectNode, { value: lastValue }, at, at, 'succeeded', output);
    for (const id of [...loop.region.bodyIds, loop.region.collectId]) {
      this.loopExecuted.add(id);
    }
    this.activeLoop = undefined;
  }

  /** Remember a node's taken branch when its output carries `$branch`. */
  private captureBranch(nodeId: string, output: unknown): void {
    if (output !== null && typeof output === 'object') {
      const branch = (output as Record<string, unknown>).$branch;
      if (typeof branch === 'string') this.branchTaken.set(nodeId, branch);
    }
  }

  /**
   * A node is reachable if it has no incoming edges, or at least one incoming
   * edge from a non-skipped, executed source whose branch (if the edge names
   * one via sourceHandle) was taken.
   */
  private isReachable(nodeId: string): boolean {
    const incoming = this.flow.edges.filter((e) => e.target === nodeId);
    if (incoming.length === 0) return true;
    const live = (edge: (typeof incoming)[number]): boolean => {
      if (this.skippedNodes.has(edge.source)) return false;
      if (!this.outputs.has(edge.source)) return false;
      if (!edge.sourceHandle) return true;
      return this.branchTaken.get(edge.source) === edge.sourceHandle;
    };
    // Branch edges are guards: when a node sits on named branches, only those
    // edges decide reachability — a plain data edge from an always-executed
    // ancestor must not smuggle the node past a dead gate. Nodes with no
    // branch edges keep join semantics (any live data edge suffices).
    const branchEdges = incoming.filter((e) => e.sourceHandle);
    if (branchEdges.length > 0) return branchEdges.some(live);
    return incoming.some(live);
  }

  private epilogue(): boolean {
    if (this.cursor >= this.order.length) {
      this.finish('succeeded');
      return false;
    }
    return true;
  }

  async runToEnd(): Promise<WorkflowRun> {
    while (await this.step()) {
      // step until done
    }
    return this.run;
  }

  cancel(): void {
    if (this.run.status !== 'running') return;
    this.finish('cancelled');
  }

  /**
   * Resolve {"$secret": NAME} and {"$env": NAME} config values; a missing
   * secret/var fails the node. `$secret` is only recognized at a config
   * value's top level (matching today's behavior — secrets are never nested
   * inside larger config structures). `$env` is resolved deeply, the same
   * walk used for the run-input payload, so refs nested in objects/arrays
   * (e.g. an Input node's `config.defaults`) resolve too.
   */
  private resolveConfig(node: WorkflowNode): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.config)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).$secret === 'string'
      ) {
        const name = (value as { $secret: string }).$secret;
        if (!(name in this.secrets)) throw new Error(`Missing secret: ${name}`);
        config[key] = this.secrets[name];
      } else {
        config[key] = resolveEnvDeep(value, this.vars);
      }
    }
    return config;
  }

  private resolveInput(
    node: WorkflowNode,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    const inputSchema = this.registry.get(node.type).definition.inputSchema;
    for (const field of inputSchema?.fields ?? []) {
      if (config[field.name] !== undefined) input[field.name] = config[field.name];
    }
    for (const [field, mapping] of Object.entries(node.inputMap ?? {})) {
      input[field] = getByPath(this.outputs.get(mapping.sourceNodeId), mapping.sourceField);
    }
    return input;
  }

  /**
   * A lenient variant of `resolveInput` for nodes whose implementation never
   * runs (mocked, or an infra node with no mock, in a mock run): resolves
   * only `inputMap`-sourced fields (other nodes' already-computed outputs,
   * which can never carry a `$secret`/`$env` ref). Skips the config-sourced
   * fields `resolveInput` also merges in — those come from `resolveConfig`,
   * which this path deliberately never calls, since that is exactly what
   * could throw (e.g. `Missing secret`) for a node this run will never
   * actually execute.
   */
  private resolveInputLenient(node: WorkflowNode): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    for (const [field, mapping] of Object.entries(node.inputMap ?? {})) {
      input[field] = getByPath(this.outputs.get(mapping.sourceNodeId), mapping.sourceField);
    }
    return input;
  }

  private finish(status: WorkflowRun['status']): void {
    // Only nodes that never got a chance to run are swept to 'skipped' here.
    // While a loop region is active, `this.cursor` stays parked at the
    // region's entry for the whole loop lifetime (body/collect execution is
    // driven by the loop's own bodyCursor, not the main cursor), so this
    // range can include body nodes that already reached a terminal state in
    // an earlier iteration — or, on failure, the very node whose 'failed'
    // state we must not clobber back to 'skipped'.
    for (; this.cursor < this.order.length; this.cursor += 1) {
      const id = this.order[this.cursor];
      if (this.run.nodeStates[id]?.status === 'queued') {
        this.setNodeState(id, { status: 'skipped' });
      }
    }
    this.run.status = status;
    this.run.completedAt = this.now();
    this.events.onRunFinished?.(this.run);
  }

  private setNodeState(nodeId: string, state: NodeRunState): void {
    this.run.nodeStates[nodeId] = state;
    this.events.onNodeStateChange?.(nodeId, state);
  }

  private emitLog(level: LogLevel, message: string, node: WorkflowNode): void {
    this.events.onLog?.({
      timestamp: this.now(),
      level,
      runId: this.run.id,
      nodeId: node.id,
      nodeLabel: node.label,
      message,
    });
  }

  private recordSample(
    node: WorkflowNode,
    input: unknown,
    startedAt: string,
    completedAt: string,
    status: 'succeeded' | 'failed',
    output?: unknown,
  ): void {
    this.trace?.record({
      id: this.newId(),
      workflowId: this.flow.id,
      runId: this.run.id,
      nodeId: node.id,
      nodeType: node.type,
      nodeLabel: node.label,
      input,
      output,
      status,
      startedAt,
      completedAt,
    });
  }
}

export function startRun(opts: StartRunOptions): FlowRun {
  const errors = validateFlow(opts.flow, opts.registry).filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`Invalid flow: ${errors.map((i) => i.message).join('; ')}`);
  }
  return new FlowRun(opts);
}
