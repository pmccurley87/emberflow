import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changedFiles, diffSince, isGitRepo, revert as gitRevert, snapshot, type GitSnapshot } from './gitScope';
import { buildPrompt, type AgentIntent, type AvailableNode, type GuidedSetupState } from './prompt';
import type { InfrastructureManifest } from '../infrastructure';
import { spawnCodex, type SpawnedAgent } from './codexAdapter';
import { spawnClaude } from './claudeAdapter';
import { resolveAgentBin } from './detect';
import type { AgentEvent, AgentKind } from './types';
import { isPathWithin } from '../pathSafety';

export interface StartAgentOptions {
  agent?: AgentKind;
  model?: string;
  reasoning?: 'low' | 'medium' | 'high';
}

/** Thrown by `start()`; `status` maps directly onto the HTTP status the endpoint should return. */
export class AgentStartError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentStartError';
  }
}

type Listener = (event: AgentEvent) => void;

/** Max number of terminal (done/error) runs kept around for diff/revert/replay before eviction. */
const MAX_TERMINAL_RUNS = 20;

/**
 * Rejects anything that isn't a safe flow id. Operation ids are path-style
 * (e.g. `"billing/charge"`, the on-disk relative path), so a slash-separated
 * id is legitimate and must be allowed — only traversal (`..` segments),
 * absolute ids, backslashes, and empty segments are rejected, and the file it
 * resolves to must stay inside `apisDir`. Defense in depth — the agent
 * sandbox already confines actual writes — but it keeps a bogus flowId like
 * `"../../etc/passwd"` from ever becoming an existence-probe against paths
 * outside apisDir.
 */
function isSafeFlowId(flowId: string, apisDir: string): boolean {
  if (!flowId) return false;
  return isPathWithin(apisDir, `${flowId}.json`);
}

/**
 * Resolves a `new-operation`/`build-api` intent's user-supplied `location` (a folder path
 * under `apisDir`, e.g. `"billing"` or `"billing/charges"`) to the directory
 * the new operation file should be created in. An empty string or `"default"`
 * both mean "the default API".
 */
function resolveLocationDir(location: string): string {
  const trimmed = location.trim();
  return trimmed === '' ? 'default' : trimmed;
}

/** Same defense-in-depth as `isSafeFlowId`, but for a target *directory* rather than a flow file. */
function isSafeLocationDir(dir: string, apisDir: string): boolean {
  return isPathWithin(apisDir, dir);
}

interface Run {
  id: string;
  snapshot: GitSnapshot;
  adapter: SpawnedAgent;
  buffer: AgentEvent[];
  listeners: Set<Listener>;
  status: 'running' | 'done' | 'error';
  /** History scope this run's transcript persists under on finish (null = not persisted). */
  scope: string | null;
  action: string;
  instruction: string;
  startedAt: string;
  persisted: boolean;
}

/** One persisted agent conversation — the full event transcript plus enough
 *  metadata to render it as a past chat in the studio's Agent panel. */
export interface AgentHistoryRecord {
  id: string;
  action: string;
  instruction: string;
  status: 'done' | 'error';
  startedAt: string;
  finishedAt: string;
  events: AgentEvent[];
}

/** Max persisted conversations kept per scope file — oldest evicted beyond this. */
const MAX_HISTORY_PER_SCOPE = 20;

/**
 * The history scope a run's transcript files under. Operation-targeted runs
 * key on the flow id; surface-building runs key on the API (first location
 * segment) so an operation's history view can also show the build that
 * created it. Project-wide runs (environments, scouting, guided setup) and
 * flow-less asks return null — they belong to no operation.
 */
function historyScopeFor(intent: AgentIntent): string | null {
  switch (intent.action) {
    case 'edit-flow':
    case 'edit-node':
    case 'new-scenario':
    case 'cover-operation':
      return `op:${intent.flowId}`;
    case 'ask':
      return intent.flowId ? `op:${intent.flowId}` : null;
    case 'new-operation':
    case 'build-api':
      return `api:${resolveLocationDir(intent.location).split('/')[0]}`;
    default:
      return null;
  }
}

/**
 * Owns in-flight coding-agent runs for a single project: spawns the adapter,
 * buffers its events for SSE replay + live subscribers, and exposes
 * git-scoped diff/revert against the snapshot taken at run start. One active
 * run per project at a time.
 */
export class AgentRunManager {
  private readonly runs = new Map<string, Run>();
  private activeRunId: string | null = null;

  constructor(
    private readonly projectDir: string,
    private readonly apisDir: string,
    private readonly pathOf: (id: string) => string | undefined,
    /**
     * Getter (not a static list) so the prompt always reflects the
     * currently-registered node types, even if the registry is populated or
     * changes after this manager is constructed.
     */
    private readonly availableNodes: () => AvailableNode[] = () => [],
    /** The loaded project's authored language (`ProjectConfig.language`,
     *  explicit-or-inferred), threaded into every prompt this manager builds.
     *  Defaults to 'typescript' — the Emberflow repo itself, when constructed
     *  without a loaded consumer project. */
    private readonly projectLanguage: 'javascript' | 'typescript' = 'typescript',
    /**
     * Getter (not a static value) for the loaded `emberflow/infrastructure.json`
     * manifest, so every prompt reflects the manifest currently on disk — a scout
     * run mid-session updates what later runs see. Returns null when the project
     * hasn't been scouted or the file is malformed. Injected as a prompt preamble
     * so agents REUSE known infrastructure instead of inventing parallel config.
     */
    private readonly infrastructure: () => InfrastructureManifest | null = () => null,
    /**
     * Getter for the runner-verified setup snapshot injected into guided-setup
     * prompts as KNOWN state — so the agent doesn't burn its first turn
     * re-deriving facts (git? skills? envs? ops?) the server already computed.
     */
    private readonly guidedState: () => GuidedSetupState | null = () => null,
  ) {}

  /** Validates the project + flow, snapshots git, spawns the adapter, and returns the new run's id. */
  start(intent: AgentIntent, opts: StartAgentOptions = {}): string {
    if (this.activeRunId) {
      throw new AgentStartError('An agent run is already active for this project', 409);
    }
    if (!isGitRepo(this.projectDir)) {
      throw new AgentStartError(
        `${this.projectDir} is not a git repository — Emberflow snapshots agent changes with git so you can review and revert them. Run: git init && git add -A && git commit -m "initial" — then retry.`,
        400,
      );
    }

    // `new-operation` and `build-api` create brand-new flows, so there's no
    // existing flowId to validate against pathOf — both validate `location`
    // instead. `setup-auth` targets an environment, not a flow file, and
    // `setup-environments` targets the environments file itself, so
    // neither has a relPath to resolve.
    let relPath: string;
    if (intent.action === 'new-operation' || intent.action === 'build-api') {
      const dir = resolveLocationDir(intent.location);
      if (!isSafeLocationDir(dir, this.apisDir)) {
        throw new AgentStartError('Invalid location', 400);
      }
      relPath = dir;
    } else if (
      intent.action === 'setup-auth' ||
      intent.action === 'setup-environments' ||
      intent.action === 'scout-infrastructure' ||
      intent.action === 'guided-setup'
    ) {
      // No flow file: setup-auth targets an environment, setup-environments the
      // environments file, scout-infrastructure reads the whole project and
      // writes emberflow/infrastructure.json, and guided-setup orchestrates all
      // of setup across project-root files — none has a relPath to resolve.
      relPath = '';
    } else if (intent.action === 'ask') {
      // `ask`'s flowId is optional: with one, resolve the op's relPath like
      // edit-flow does; without, resolve to the apis root (empty relPath) —
      // there's no specific operation file to point the prompt at.
      if (intent.flowId) {
        if (!isSafeFlowId(intent.flowId, this.apisDir)) {
          throw new AgentStartError('Invalid flowId', 400);
        }
        const found = this.pathOf(intent.flowId);
        if (!found) {
          throw new AgentStartError(`Unknown flow: ${intent.flowId}`, 400);
        }
        relPath = found;
      } else {
        relPath = '';
      }
    } else {
      if (!isSafeFlowId(intent.flowId, this.apisDir)) {
        throw new AgentStartError('Invalid flowId', 400);
      }
      const found = this.pathOf(intent.flowId);
      if (!found) {
        throw new AgentStartError(`Unknown flow: ${intent.flowId}`, 400);
      }
      relPath = found;
    }

    this.pruneTerminalRuns();

    const snap = snapshot(this.projectDir);
    const prompt = buildPrompt(
      intent,
      this.apisDir,
      relPath,
      this.availableNodes(),
      this.projectLanguage,
      this.infrastructure(),
      intent.action === 'guided-setup' ? this.guidedState() : null,
    );
    // Env override wins (tests stub agents this way); otherwise use the NEWEST
    // binary detection found across PATH + known install locations — a PATH
    // shim pinned to a stale release must not shadow a newer install elsewhere.
    const adapter =
      opts.agent === 'claude'
        ? spawnClaude(prompt, this.projectDir, {
            model: opts.model,
            bin: process.env.EMBERFLOW_CLAUDE_BIN ?? resolveAgentBin('claude'),
          })
        : spawnCodex(prompt, this.projectDir, {
            model: opts.model,
            reasoning: opts.reasoning ?? 'medium',
            bin: process.env.EMBERFLOW_CODEX_BIN ?? resolveAgentBin('codex'),
          });

    const id = randomUUID();
    const run: Run = {
      id,
      snapshot: snap,
      adapter,
      buffer: [],
      listeners: new Set(),
      status: 'running',
      scope: historyScopeFor(intent),
      action: intent.action,
      instruction: 'instruction' in intent ? intent.instruction : '',
      startedAt: new Date().toISOString(),
      persisted: false,
    };
    this.runs.set(id, run);
    this.activeRunId = id;

    void this.consume(run);

    return id;
  }

  /** Drains the adapter's events into the run's buffer, fanning each out to live subscribers. */
  private async consume(run: Run): Promise<void> {
    const emit = (event: AgentEvent): void => {
      run.buffer.push(event);
      for (const listener of run.listeners) listener(event);
    };

    try {
      for await (const event of run.adapter.events) {
        // Clear the busy slot as soon as a terminal event is *observed*, not
        // once the adapter's generator fully drains — a subscriber reacting
        // synchronously to `done`/`error` (e.g. by starting a new run) must
        // not race against this loop's own bookkeeping.
        if (event.type === 'done') {
          run.status = 'done';
          this.clearActive(run.id);
        } else if (event.type === 'error') {
          run.status = 'error';
          this.clearActive(run.id);
        }
        emit(event);
        // Persist AFTER the terminal event is in the buffer, so the stored
        // transcript replays identically to the live stream.
        if (event.type === 'done' || event.type === 'error') this.persistHistory(run);
      }
    } catch (err) {
      run.status = 'error';
      this.clearActive(run.id);
      emit({ type: 'error', text: err instanceof Error ? err.message : String(err) });
      this.persistHistory(run);
    } finally {
      this.clearActive(run.id);
    }
  }

  /** `emberflow/agent-history` beside `apis`, self-gitignored (`.gitignore` with
   *  `*`) so transcripts never show up in the run's own git-scoped diff. */
  private historyDir(): string {
    const dir = join(this.apisDir, '..', 'agent-history');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const keep = join(dir, '.gitignore');
    if (!existsSync(keep)) writeFileSync(keep, '*\n');
    return dir;
  }

  private historyFile(scope: string): string {
    return join(this.historyDir(), `${scope.replace(/[^a-zA-Z0-9_-]/g, '__')}.json`);
  }

  private readHistoryFile(scope: string): AgentHistoryRecord[] {
    const file = this.historyFile(scope);
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as AgentHistoryRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return []; // corrupt file: start the scope fresh rather than fail runs
    }
  }

  /** Appends the finished run's transcript to its scope file. Best-effort —
   *  a disk failure must never take the run (or its live stream) down. */
  private persistHistory(run: Run): void {
    if (run.persisted || !run.scope || run.status === 'running') return;
    run.persisted = true;
    try {
      const records = this.readHistoryFile(run.scope).filter((r) => r.id !== run.id);
      records.push({
        id: run.id,
        action: run.action,
        instruction: run.instruction,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: new Date().toISOString(),
        events: run.buffer,
      });
      writeFileSync(this.historyFile(run.scope), JSON.stringify(records.slice(-MAX_HISTORY_PER_SCOPE)));
    } catch (err) {
      console.error('[emberflow] failed to persist agent history:', err);
    }
  }

  /**
   * Every persisted conversation relevant to one operation, oldest first: runs
   * scoped to the flow itself plus the surface-building runs of its API.
   */
  history(flowId: string): AgentHistoryRecord[] {
    if (!isSafeFlowId(flowId, this.apisDir)) return [];
    const records = [
      ...this.readHistoryFile(`op:${flowId}`),
      ...this.readHistoryFile(`api:${flowId.split('/')[0]}`),
    ];
    return records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  private clearActive(id: string): void {
    if (this.activeRunId === id) this.activeRunId = null;
  }

  /** Replay the buffer to the listener, then stream live events. Returns an unsubscribe fn. */
  subscribe(id: string, listener: Listener): (() => void) | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    for (const event of run.buffer) listener(event);
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  has(id: string): boolean {
    return this.runs.has(id);
  }

  diff(id: string): { diff: string; files: string[] } | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    return {
      diff: diffSince(this.projectDir, run.snapshot),
      files: changedFiles(this.projectDir, run.snapshot),
    };
  }

  revert(id: string): { reverted: string[] } | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const files = changedFiles(this.projectDir, run.snapshot);
    gitRevert(this.projectDir, run.snapshot, files);
    return { reverted: files };
  }

  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run) return false;
    run.adapter.cancel();
    return true;
  }

  /**
   * Kills the active agent run's process tree, if any. Agent CLIs are spawned
   * DETACHED (their own process group, so cancel can tree-kill their
   * subprocesses) — which also means they survive the runner dying unless the
   * shutdown path explicitly cancels them. An orphaned agent keeps editing the
   * project long after the studio is gone; call this from the server's
   * SIGINT/SIGTERM handlers.
   */
  shutdown(): void {
    if (!this.activeRunId) return;
    const run = this.runs.get(this.activeRunId);
    run?.adapter.cancel();
  }

  /**
   * Evicts oldest terminal (done|error) runs beyond MAX_TERMINAL_RUNS so the
   * `runs` map — and each run's full event buffer — doesn't grow unbounded
   * over a long-lived server process. The active run (if any) is never
   * evicted; insertion order on the Map gives us oldest-first for free.
   */
  private pruneTerminalRuns(): void {
    const terminalIds: string[] = [];
    for (const [id, run] of this.runs) {
      if (run.status === 'done' || run.status === 'error') terminalIds.push(id);
    }
    const excess = terminalIds.length - MAX_TERMINAL_RUNS;
    if (excess <= 0) return;
    for (const id of terminalIds.slice(0, excess)) {
      this.runs.delete(id);
    }
  }
}
