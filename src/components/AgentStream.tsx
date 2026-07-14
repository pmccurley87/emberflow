import { useMemo, useState } from 'react';
import { ChevronRightIcon, TerminalIcon, ZapIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentEvent } from '../store/agentClient';
import { renderAgentMarkdown } from './agentMarkdown';

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
 * A failed command in the group tints the header destructive but stays
 * COLLAPSED — the failure signal is visible, the raw output dump is a click
 * away. This is the big de-noiser: a single edit can run 30 inspection
 * commands — nobody wants 30 rows, they want the reasoning with the
 * mechanics tucked underneath.
 */
function CommandGroup({ commands }: { commands: AgentEvent[] }) {
  const anyFailed = commands.some((c) => c.commandStatus === 'failed');
  const [open, setOpen] = useState(false);
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

type Block =
  | { kind: 'message' | 'error' | 'approval' | 'mcp'; e: AgentEvent }
  | { kind: 'op'; e: AgentEvent; op: string; target?: string }
  | { kind: 'commands'; commands: AgentEvent[] };

/**
 * Fold a raw agent event stream into display blocks. Reasoning prose and error
 * lines stand alone; consecutive shell commands collapse into one CommandGroup;
 * emberflow CLI ops + MCP calls render as their own steps; `started`/`done` are
 * structural and `⚠` diagnostics are folded into a noise count. Exported so both
 * the console and the component test can assert the partitioning directly.
 */
export function partitionAgentEvents(events: AgentEvent[]): { blocks: Block[]; noiseCount: number } {
  const blocks: Block[] = [];
  let noiseCount = 0;
  let group: AgentEvent[] | null = null;
  const flush = (): void => {
    if (group && group.length) blocks.push({ kind: 'commands', commands: group });
    group = null;
  };
  for (const e of events) {
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
}

/**
 * Presentational render of a coding-agent event stream: the agent's reasoning
 * as comfortable markdown prose, shell commands collapsed to quiet expandable
 * one-liners, emberflow CLI ops + MCP calls as their own steps, error/approval
 * rows, and background `⚠` diagnostics tucked into a count. Pure over its props
 * — the AgentConsole (docked panel) and the WelcomeDialog (guided setup) both
 * embed it. `running` drives the "Thinking…"/"Working…" live indicators.
 */
export function AgentStream({ events, running }: { events: AgentEvent[]; running: boolean }) {
  // Partition the raw stream into what's worth showing vs. noise. The agent's
  // ⚠ diagnostics (an MCP server failing to auth, a hook firing) are real but
  // not what the user is watching for — collapse them to a count.
  const { blocks, noiseCount } = useMemo(() => partitionAgentEvents(events), [events]);

  return (
    <>
      {blocks.length === 0 && running && (
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
      {running && blocks.length > 0 && (
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
    </>
  );
}
