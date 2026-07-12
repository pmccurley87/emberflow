import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import readline from 'node:readline';
import { parseClaudeLine } from './claudeParse';
import { modelRejectionHint } from './modelRejectionHint';
import type { AgentEvent } from './types';
import type { SpawnedAgent } from './codexAdapter';

const STDERR_TAIL_BYTES = 2048;

export interface ClaudeOptions {
  model?: string;
  bin?: string;
  /** Grace period (ms) between SIGTERM and the SIGKILL escalation in cancel(). Test hook. */
  killGraceMs?: number;
}

export function spawnClaude(prompt: string, projectDir: string, opts: ClaudeOptions = {}): SpawnedAgent {
  const bin = opts.bin ?? 'claude';
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    // Never ask for per-call approval — the studio runs claude non-interactively
    // (-p + SSE panel), so an approval prompt has no one to answer it and the
    // command simply fails ("This command requires approval"), which broke even
    // our own CLI calls (list-environments). Mirrors the codex adapter's
    // never-ask contract; the --add-dir working-directory sandbox still fences
    // file reads/edits to the project.
    '--permission-mode',
    'bypassPermissions',
    '--add-dir',
    projectDir,
    ...(opts.model ? ['--model', opts.model] : []),
  ];

  // detached: give claude its own process group so cancel() can tree-kill any
  // subprocesses it spawns, not just the top-level process.
  // stdio ['ignore','pipe','pipe'] → stdin is null, stdout/stderr are Readable.
  const child: ChildProcessByStdio<null, Readable, Readable> = bin.endsWith('.mjs')
    ? spawn(process.execPath, [bin, ...args], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    : spawn(bin, args, { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], detached: true });

  // Buffer only the last ~2KB of stderr — non-fatal in general, but useful as
  // a diagnostic tail when the process dies without a terminal event (see
  // maybeFinalize below).
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

  // Tracks in-flight Bash commands by their tool_use id, so that when the
  // matching tool_result (a separate 'user' stream-json line) arrives we can
  // recover the original command text — the tool_result line only carries the
  // id + output, not the command. AgentConsole dedups an in_progress command
  // event with a later completed one by matching `command` text, so the
  // completed event we emit here must reuse the same text.
  const pendingCommands = new Map<string, string>();

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    for (const event of parseClaudeLine(line)) {
      if (event.type === 'done' || event.type === 'error') sawTerminal = true;

      if (event.type === 'command' && event.commandStatus === 'in_progress' && event.toolUseId && event.command) {
        pendingCommands.set(event.toolUseId, event.command);
        push(event);
        continue;
      }

      if (event.type === 'command' && event.commandStatus !== 'in_progress' && event.toolUseId) {
        // A tool_result — only surface it if it corresponds to a Bash command
        // we're tracking; skip gracefully otherwise (e.g. a non-Bash tool).
        const command = pendingCommands.get(event.toolUseId);
        if (!command) continue;
        pendingCommands.delete(event.toolUseId);
        push({ ...event, command });
        continue;
      }

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
        // Clean exit but the model never emitted a result event — synthesize a done.
        push({ type: 'done' });
      } else {
        const hint = modelRejectionHint('claude', stderrTail);
        const text = hint ? `claude exited with code ${exitCode} (${hint})` : `claude exited with code ${exitCode}`;
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
    push({ type: 'error', text: `failed to start claude: ${err.message}` });
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

  // Kill the whole process group (negative pid) so claude's own subprocesses die
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
