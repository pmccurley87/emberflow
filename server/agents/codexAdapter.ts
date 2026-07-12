import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import readline from 'node:readline';
import { parseCodexLine } from './codexParse';
import { modelRejectionHint } from './modelRejectionHint';
import type { AgentEvent } from './types';

const STDERR_TAIL_BYTES = 2048;

export interface SpawnedAgent {
  events: AsyncIterable<AgentEvent>;
  cancel(): void;
}

export interface CodexOptions {
  model?: string;
  reasoning?: 'low' | 'medium' | 'high';
  bin?: string;
  /** Grace period (ms) between SIGTERM and the SIGKILL escalation in cancel(). Test hook. */
  killGraceMs?: number;
}

export function spawnCodex(prompt: string, projectDir: string, opts: CodexOptions = {}): SpawnedAgent {
  const bin = opts.bin ?? 'codex';
  const args = [
    // Never ask for per-call approval — the studio runs codex non-interactively,
    // so an approval prompt has no one to answer it and codex cancels the call
    // ("user cancelled MCP tool call"). This is a top-level flag (before `exec`).
    // The sandbox (-s workspace-write, below) still constrains what can run.
    '-a',
    'never',
    'exec',
    '-C',
    projectDir,
    '-s',
    'workspace-write',
    // Keep the workspace-write FILE sandbox, but allow network — the agent's CLI
    // ops (node bin/emberflow.mjs run/get-workflow/…) must reach the runner on
    // 127.0.0.1; workspace-write blocks all network by default (curl → 000).
    '-c',
    'sandbox_workspace_write.network_access=true',
    '-c',
    `model_reasoning_effort=${opts.reasoning ?? 'low'}`,
    '--json',
    ...(opts.model ? ['-m', opts.model] : []),
    prompt,
  ];

  // detached: give codex its own process group so cancel() can tree-kill any
  // subprocesses it spawns (workspace-write), not just the top-level process.
  // stdio ['ignore','pipe','pipe'] → stdin is null, stdout/stderr are Readable.
  const child: ChildProcessByStdio<null, Readable, Readable> = bin.endsWith('.mjs')
    ? spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    : spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

  // Buffer only the last ~2KB of stderr — non-fatal in general (e.g. the user's
  // global MCP servers spew auth errors there), but useful as a diagnostic tail
  // when the process dies without a terminal event (see maybeFinalize below).
  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });

  const queue: AgentEvent[] = [];
  const resolvers: Array<() => void> = [];
  let done = false;
  let sawTerminal = false;

  function push(event: AgentEvent) {
    queue.push(event);
    const resolve = resolvers.shift();
    if (resolve) resolve();
  }

  function finish() {
    done = true;
    while (resolvers.length) {
      const resolve = resolvers.shift();
      if (resolve) resolve();
    }
  }

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const event = parseCodexLine(line);
    if (event) {
      if (event.type === 'done' || event.type === 'error') sawTerminal = true;
      push(event);
    }
  });

  // Finalize only once BOTH the stdout stream is fully drained (readline 'close')
  // AND the process has exited ('close', which fires after all stdio is flushed —
  // unlike 'exit', which can fire while trailing stdout lines are still buffered).
  let rlClosed = false;
  let procClosed = false;
  let exitCode: number | null = null;
  let escalateTimer: NodeJS.Timeout | undefined;

  function clearEscalation() {
    if (escalateTimer) {
      clearTimeout(escalateTimer);
      escalateTimer = undefined;
    }
  }

  function maybeFinalize() {
    if (!rlClosed || !procClosed) return;
    clearEscalation();
    if (!sawTerminal) {
      if (exitCode === 0) {
        // Clean exit but the model never emitted turn.completed — synthesize a done.
        push({ type: 'done' });
      } else {
        const hint = modelRejectionHint('codex', stderrTail);
        const text = hint ? `codex exited with code ${exitCode} (${hint})` : `codex exited with code ${exitCode}`;
        push({ type: 'error', text });
      }
      sawTerminal = true;
    }
    finish();
  }

  rl.on('close', () => {
    rlClosed = true;
    maybeFinalize();
  });

  child.on('close', (code) => {
    procClosed = true;
    exitCode = code;
    maybeFinalize();
  });

  // A failed spawn (missing binary, bad EMBERFLOW_*_BIN, permissions, ...) emits
  // an 'error' event on the child instead of ever exiting/closing normally. Left
  // unhandled, Node rethrows it and crashes the whole runner process — so we
  // must handle it and finalize the stream ourselves. 'close' still fires after
  // a spawn error (with code null), so guard against double-finalizing there.
  let spawnFailed = false;
  child.on('error', (err) => {
    if (spawnFailed) return;
    spawnFailed = true;
    clearEscalation();
    push({ type: 'error', text: `failed to start codex: ${err.message}` });
    sawTerminal = true;
    rlClosed = true;
    procClosed = true;
    finish();
  });

  async function* generate(): AsyncGenerator<AgentEvent> {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) return;
      await new Promise<void>((resolve) => resolvers.push(resolve));
    }
  }

  // Kill the whole process group (negative pid) so codex's own subprocesses die
  // too; fall back to a plain kill if the group signal fails (e.g. already gone
  // or no group). Used by both the initial SIGTERM and the SIGKILL escalation.
  function killGroup(signal: NodeJS.Signals) {
    try {
      if (child.pid != null) {
        process.kill(-child.pid, signal);
        return;
      }
    } catch {
      // group kill failed — fall through to a direct kill
    }
    try {
      child.kill(signal);
    } catch {
      // process already gone — nothing to do
    }
  }

  return {
    events: { [Symbol.asyncIterator]: generate },
    cancel() {
      killGroup('SIGTERM');

      // If the process (or a stubborn grandchild/MCP server) ignores SIGTERM,
      // escalate to SIGKILL after a grace period so a hung agent can't
      // permanently lock the run slot. Cleared once close/error finalizes.
      clearEscalation();
      escalateTimer = setTimeout(() => {
        escalateTimer = undefined;
        killGroup('SIGKILL');
      }, opts.killGraceMs ?? 3000);
      escalateTimer.unref?.();
    },
  };
}
