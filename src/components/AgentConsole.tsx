import { useEffect, useMemo, useState } from 'react';
import { ArrowUpIcon, ChevronRightIcon, SparklesIcon, TerminalIcon, XIcon, ZapIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useBuilderStore } from '../store/builderStore';
import type { AgentEvent } from '../store/agentClient';
import { renderAgentMarkdown } from './agentMarkdown';


const statusDot: Record<string, string> = {
  running: 'bg-highlight animate-pulse',
  done: 'bg-success',
  error: 'bg-destructive',
};

/** A command's status → a small glyph colour. */
const cmdDot: Record<string, string> = {
  in_progress: 'bg-highlight animate-pulse',
  completed: 'bg-success/70',
  failed: 'bg-destructive',
};

/** The `emberflow` CLI operation commands the agent uses (run/inspect/delete). */
const EMBERFLOW_OPS = [
  'run', 'get-workflow', 'list-workflows', 'list-nodes', 'node-schema', 'list-environments',
  'create', 'delete', 'rename', 'validate', 'publish', 'save',
];

/** If a shell command invokes the emberflow CLI bin with an operation command,
 *  pull out the operation + its target id so it can render as a distinct step. */
function parseEmberflowOp(command?: string): { op: string; target?: string } | null {
  if (!command || !/emberflow\.mjs\b/.test(command)) return null;
  const after = command.split(/emberflow\.mjs\b/)[1] ?? '';
  const toks = after.trim().split(/\s+/).filter(Boolean);
  const op = toks.find((t) => EMBERFLOW_OPS.includes(t));
  if (!op) return null;
  const target = toks.slice(toks.indexOf(op) + 1).find((t) => !t.startsWith('-'));
  return { op, target };
}

/**
 * A run of consecutive shell commands, collapsed to a single quiet line
 * ("Ran N commands") that expands to the individual commands + their output.
 * A failed command in the group forces it open and tints it. This is the big
 * de-noiser: a single edit can run 30 inspection commands — nobody wants 30
 * rows, they want the reasoning with the mechanics tucked underneath.
 */
function CommandGroup({ commands }: { commands: AgentEvent[] }) {
  const anyFailed = commands.some((c) => c.commandStatus === 'failed');
  const [open, setOpen] = useState(anyFailed);
  const running = commands.some((c) => c.commandStatus === 'in_progress');
  const label = commands.length === 1 ? '1 command' : `${commands.length} commands`;
  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-secondary/50"
      >
        <ChevronRightIcon
          className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')}
        />
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            running ? cmdDot.in_progress : anyFailed ? cmdDot.failed : cmdDot.completed,
          )}
        />
        <span className={cn('text-[11px]', anyFailed ? 'text-destructive/90' : 'text-muted-foreground/70')}>
          {running ? 'Running' : 'Ran'} {label}
        </span>
      </button>
      {open && (
        <div className="ml-[18px] mt-0.5 space-y-0.5 border-l border-border/50 pl-2">
          {commands.map((c, k) => (
            <div key={k}>
              <div className="flex items-center gap-1.5">
                <span className={cn('size-1 shrink-0 rounded-full', cmdDot[c.commandStatus ?? 'in_progress'])} />
                <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground/80">{c.command}</span>
                {c.commandStatus === 'failed' && c.exitCode != null && (
                  <span className="ml-auto shrink-0 font-mono text-[9px] text-destructive">exit {c.exitCode}</span>
                )}
              </div>
              {(c.commandStatus === 'failed' || open) && c.output && c.output.trim() && (
                <pre className="mt-0.5 ml-3 max-h-32 overflow-auto rounded border border-border/50 bg-background/40 p-1.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground/70">
                  {c.output}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** An MCP tool call the agent made against the runner (run/list/delete/etc.) —
 *  visually distinct from a shell command (MCP-blue, a "MCP" chip), expandable
 *  to its result. This is the operational channel: files for edits, MCP for
 *  actions like running the operation or deleting it. */
function McpCall({ e }: { e: AgentEvent }) {
  const [open, setOpen] = useState(false);
  const status = e.mcpStatus ?? 'completed';
  const failed = status === 'failed';
  const running = status === 'in_progress';
  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-secondary/50"
      >
        <ChevronRightIcon
          className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')}
        />
        <span className={cn('size-1.5 shrink-0 rounded-full', running ? 'animate-pulse bg-highlight' : failed ? 'bg-destructive' : 'bg-[#8fb8d8]')} />
        <ZapIcon className="size-3 shrink-0 text-[#8fb8d8]" />
        <span className="shrink-0 rounded border border-[#8fb8d8]/40 px-1 font-mono text-[8.5px] uppercase tracking-wide text-[#8fb8d8]">
          MCP
        </span>
        <span className={cn('min-w-0 truncate font-mono text-[11px]', failed ? 'text-destructive/90' : 'text-foreground/85')}>
          {e.mcpServer}·{e.mcpTool}
        </span>
        <span className="ml-auto shrink-0 text-[9.5px] text-muted-foreground/60">{running ? '…' : status}</span>
      </button>
      {open && e.output && e.output.trim() && (
        <pre className="ml-[18px] mt-0.5 max-h-40 overflow-auto rounded border border-border/50 bg-background/40 p-1.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground/75">
          {e.output}
        </pre>
      )}
    </div>
  );
}

/** An `emberflow` CLI operation the agent ran (run/inspect/delete against the
 *  live runner) — surfaced as a distinct operation step, expandable to its
 *  output. This is the agent's operational channel: files for edits, CLI ops
 *  for running/inspecting/removing. */
function OpCall({ op, target, e }: { op: string; target?: string; e: AgentEvent }) {
  const [open, setOpen] = useState(false);
  const status = e.commandStatus ?? 'completed';
  const failed = status === 'failed' || (e.exitCode != null && e.exitCode !== 0);
  const running = status === 'in_progress';
  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-secondary/50"
      >
        <ChevronRightIcon className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
        <span className={cn('size-1.5 shrink-0 rounded-full', running ? 'animate-pulse bg-highlight' : failed ? 'bg-destructive' : 'bg-[#8fb8d8]')} />
        <ZapIcon className="size-3 shrink-0 text-[#8fb8d8]" />
        <span className="shrink-0 rounded border border-[#8fb8d8]/40 px-1 font-mono text-[8.5px] uppercase tracking-wide text-[#8fb8d8]">
          OP
        </span>
        <span className={cn('min-w-0 truncate font-mono text-[11px]', failed ? 'text-destructive/90' : 'text-foreground/85')}>
          {op}{target ? ` · ${target}` : ''}
        </span>
        <span className="ml-auto shrink-0 text-[9.5px] text-muted-foreground/60">{running ? '…' : failed ? 'failed' : 'ok'}</span>
      </button>
      {open && e.output && e.output.trim() && (
        <pre className="ml-[18px] mt-0.5 max-h-40 overflow-auto rounded border border-border/50 bg-background/40 p-1.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground/75">
          {e.output}
        </pre>
      )}
    </div>
  );
}

/**
 * Docked panel that streams a studio-triggered coding-agent run. Presents it
 * the way Codex/Claude present their own work: the agent's reasoning is the
 * content (comfortable prose), commands collapse to quiet one-liners you can
 * expand, and background diagnostics (MCP/hook noise) are tucked into a count.
 * Then the diff with a Revert button once the run finishes.
 */
export function AgentConsole({ onDismiss }: { onDismiss: () => void }) {
  const agentRun = useBuilderStore((s) => s.agentRun);
  const revertAgentRun = useBuilderStore((s) => s.revertAgentRun);
  const runAgent = useBuilderStore((s) => s.runAgent);
  const flowId = useBuilderStore((s) => s.flow.id);
  const flowName = useBuilderStore((s) => s.flow.name);
  const envSetup = useBuilderStore((s) => s.agentEnvSetup);
  const [instruction, setInstruction] = useState('');
  const running = agentRun?.status === 'running';

  // Slide in from the right on mount: start translated off-screen, then flip to
  // 0 on the next frame so the transition runs. (A CSS keyframe races the
  // resizable panel's JS-driven width and often no-ops; this is reliable.)
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, []);

  const send = () => {
    const text = instruction.trim();
    if (!text || running) return;
    // Chat drives the OPEN operation — unless the panel was opened from the
    // Environments dialog, in which case it drives environment setup and
    // follow-ups keep refining the environments file.
    if (envSetup) {
      void runAgent({ action: 'setup-environments', instruction: text });
    } else {
      // One input, no modes: the edit-flow prompt classifies the message —
      // questions get answered read-only, change requests get edited. The
      // explicit `ask` intent still exists for programmatic callers.
      void runAgent({ action: 'edit-flow', flowId, instruction: text });
    }
    setInstruction('');
  };

  // Partition the raw stream into what's worth showing vs. noise. The agent's
  // ⚠ diagnostics (an MCP server failing to auth, a hook firing) are real but
  // not what the user is watching for — collapse them to a count.
  const { blocks, noiseCount } = useMemo(() => {
    // Fold the raw stream into display blocks: reasoning prose and error lines
    // stand alone; consecutive commands collapse into one CommandGroup. Started/
    // done are structural; ⚠ diagnostics are noise → a count.
    type Block =
      | { kind: 'message' | 'error' | 'approval' | 'mcp'; e: AgentEvent }
      | { kind: 'op'; e: AgentEvent; op: string; target?: string }
      | { kind: 'commands'; commands: AgentEvent[] };
    const blocks: Block[] = [];
    let noiseCount = 0;
    let group: AgentEvent[] | null = null;
    const flush = (): void => {
      if (group && group.length) blocks.push({ kind: 'commands', commands: group });
      group = null;
    };
    for (const e of agentRun?.events ?? []) {
      // An `emberflow` CLI operation (run/inspect/delete) — surface it as a
      // distinct "operation" step, not a generic shell command.
      const opInfo = e.type === 'command' ? parseEmberflowOp(e.command) : null;
      if (e.type === 'command' && opInfo) {
        flush();
        const last = blocks[blocks.length - 1];
        if (last && last.kind === 'op' && last.e.command === e.command && last.e.commandStatus === 'in_progress') {
          last.e = e;
        } else {
          blocks.push({ kind: 'op', e, op: opInfo.op, target: opInfo.target });
        }
        continue;
      }
      if (e.type === 'command') {
        group ??= [];
        // Each command streams as a start (in_progress) then a complete
        // (completed/failed) event with the same text — collapse the pair into
        // one entry carrying the final status + output, so counts are accurate.
        const last = group[group.length - 1];
        if (last && last.command === e.command && last.commandStatus === 'in_progress') {
          group[group.length - 1] = e;
        } else {
          group.push(e);
        }
        continue;
      }
      flush();
      if (e.type === 'mcp') {
        // MCP calls stream in_progress → completed for the same tool; collapse
        // the pair so the completed status/result replaces the pending one.
        const last = blocks[blocks.length - 1];
        if (last && last.kind === 'mcp' && last.e.mcpTool === e.mcpTool && last.e.mcpStatus === 'in_progress') {
          last.e = e;
        } else {
          blocks.push({ kind: 'mcp', e });
        }
        continue;
      }
      if (e.type === 'started' || e.type === 'done') continue;
      if (e.type === 'message' && e.text?.startsWith('⚠')) {
        noiseCount += 1;
        continue;
      }
      if (e.type === 'message') blocks.push({ kind: 'message', e });
      else if (e.type === 'error') blocks.push({ kind: 'error', e });
      else if (e.type === 'approval-request') blocks.push({ kind: 'approval', e });
    }
    flush();
    return { blocks, noiseCount };
  }, [agentRun?.events]);

  const finished = agentRun != null && agentRun.status !== 'running';

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden border-l border-border bg-card transition-transform duration-200 ease-out motion-reduce:transition-none',
        entered ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border/70 px-3.5">
        <span className={cn('size-2 rounded-full', agentRun ? statusDot[agentRun.status] : 'bg-muted-foreground/40')} />
        <span className="min-w-0 truncate text-[12.5px] font-medium">
          {envSetup ? 'Agent — environments' : 'Agent'}
        </span>
        {agentRun && (
          <Badge variant="outline" className="shrink-0 text-[9px] uppercase">
            {agentRun.status}
          </Badge>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
          aria-label="Dismiss agent console"
        >
          <XIcon className="size-3.5" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3.5 py-3">
        {/* Your message — the instruction you sent, shown first like a chat. */}
        {agentRun?.instruction && (
          <div className="mb-1 flex justify-end">
            <div className="max-w-[90%] rounded-lg rounded-br-sm bg-highlight/15 px-2.5 py-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground">
              {agentRun.instruction}
            </div>
          </div>
        )}
        {!agentRun && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <span className="flex size-9 items-center justify-center rounded-full bg-highlight/12 text-highlight">
              <SparklesIcon className="size-4" />
            </span>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              {envSetup ? (
                <>
                  Describe the environments this project should have — dev? prod? test? Base URLs
                  and which ones are protected. The agent writes the config; secret values stay
                  yours to add afterwards.
                </>
              ) : (
                <>
                  Ask the agent to change <span className="text-foreground/80">{flowName}</span>. It edits the
                  operation — adding nodes, wiring, or a new registered node — and the canvas updates live when it’s done.
                </>
              )}
            </p>
          </div>
        )}
        {agentRun && blocks.length === 0 && !finished && (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground/70">
            <span className="size-1.5 animate-pulse rounded-full bg-highlight" />
            Thinking…
          </div>
        )}
        {blocks.map((b, i) => {
          if (b.kind === 'commands') return <CommandGroup key={i} commands={b.commands} />;
          if (b.kind === 'op') return <OpCall key={i} op={b.op} target={b.target} e={b.e} />;
          if (b.kind === 'mcp') return <McpCall key={i} e={b.e} />;
          if (b.kind === 'message') {
            // The reasoning: the star of the panel — comfortable, readable prose.
            // Render the markdown subset (bold/code/lists/headings). The renderer
            // owns block structure, so whitespace-pre-wrap stays OFF here.
            return (
              <div key={i} className="space-y-1.5">
                {renderAgentMarkdown(b.e.text ?? '')}
              </div>
            );
          }
          if (b.kind === 'error') {
            return (
              <p key={i} className="text-[12px] leading-relaxed text-destructive">
                {b.e.text ?? 'The agent run failed.'}
              </p>
            );
          }
          return (
            <p key={i} className="text-[12px] text-yellow-500">
              Approval requested{b.e.text ? `: ${b.e.text}` : ''}
            </p>
          );
        })}

        {/* Live working indicator once there's content but the run's still going. */}
        {!finished && blocks.length > 0 && (
          <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/60">
            <span className="size-1.5 animate-pulse rounded-full bg-highlight" />
            Working…
          </div>
        )}

        {/* Background diagnostics, tucked away — acknowledged, not shouting. */}
        {noiseCount > 0 && (
          <div className="flex items-center gap-1.5 pt-1 text-[10.5px] text-muted-foreground/45">
            <TerminalIcon className="size-3" />
            {noiseCount} background {noiseCount === 1 ? 'diagnostic' : 'diagnostics'} hidden
          </div>
        )}
      </div>

      {finished && agentRun && (agentRun.diff !== undefined || agentRun.status === 'error') && (
        <div className="min-h-0 shrink-0 border-t border-border/70">
          <div className="max-h-64 overflow-auto p-3">
            {agentRun.diff ? (
              <>
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                  Changes{agentRun.files && agentRun.files.length > 0 ? ` · ${agentRun.files.join(', ')}` : ''}
                </div>
                <pre className="overflow-auto rounded-md border border-border bg-background/40 p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap">
                  {agentRun.diff}
                </pre>
              </>
            ) : (
              <div className="text-[12px] text-muted-foreground/70">No changes were made.</div>
            )}
          </div>
        </div>
      )}

      {/* Revert stays available after a completed change. */}
      {finished && agentRun && agentRun.status === 'done' && agentRun.diff && (
        <div className="flex shrink-0 items-center border-t border-border/70 px-3.5 py-1.5">
          <Button variant="destructive" size="sm" onClick={() => void revertAgentRun()}>
            Revert last change
          </Button>
        </div>
      )}

      {/* Persistent chat input — the way to drive the open operation. */}
      <footer className="shrink-0 border-t border-border/70 p-2.5">
        <div className="flex items-end gap-2">
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                send();
              }
            }}
            disabled={running}
            placeholder={
              running
                ? 'Agent is working…'
                : envSetup
                  ? 'e.g. dev on localhost:3001, prod at api.example.com (protected)'
                  : `Ask about ${flowName}, or tell the agent what to change…`
            }
            rows={2}
            className="min-h-0 flex-1 resize-none rounded-md border border-input bg-input/30 px-2.5 py-1.5 text-[12.5px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
          />
          <Button
            size="icon"
            className="size-8 shrink-0"
            onClick={send}
            disabled={running || !instruction.trim()}
            aria-label="Send to agent"
            title="Send (⌘⏎)"
          >
            <ArrowUpIcon className="size-4" />
          </Button>
        </div>
      </footer>
    </div>
  );
}
