import { useEffect, useRef, useState } from 'react';
import {
  ArrowRightIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  FileTextIcon,
  LoaderCircleIcon,
  SparklesIcon,
  XIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { buildFocus, type BuildFocus } from '../lib/buildFocus';
import { operationIdFromFile } from '../lib/operationFiles';
import { useBuilderStore } from '../store/builderStore';
import type { AgentHistoryRun } from '../store/agentClient';
import type { ScenarioTestReport } from '../store/serverRunner';
import { AgentStream } from './AgentStream';

/**
 * "Working on" bar: while a build run is live, names the operation the agent
 * is writing THIS tick, where it lives, and how far through the declared
 * surface it is. Pinned under the panel header so it stays legible no matter
 * how far the stream has scrolled — the stream says what the agent is
 * thinking; this says what it is touching. Prop-driven for tests.
 */
export function BuildFocusBar({ focus, onOpen }: { focus: BuildFocus | null; onOpen: (id: string) => void }) {
  if (!focus) return null;
  const pct = focus.total > 0 ? Math.round((focus.done / focus.total) * 100) : 0;
  return (
    <div className="shrink-0 border-b border-border/70 bg-highlight/[0.04] px-3.5 py-2">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {focus.id ? 'Building' : 'Between operations'}
        </span>
        {focus.total > 0 && (
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {focus.done}/{focus.total} built
          </span>
        )}
      </div>
      {focus.id && (
        <button
          type="button"
          onClick={() => onOpen(focus.id!)}
          title="Open this operation"
          className="mt-0.5 flex w-full items-center gap-2 text-left"
        >
          <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-highlight motion-reduce:animate-none" />
          <span className="truncate text-[12.5px] font-medium text-foreground">{focus.name}</span>
          {focus.location && (
            <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-muted-foreground/60">
              {focus.location}
            </span>
          )}
        </button>
      )}
      {/* Surface progress: quiet, and only once the plan has a real denominator. */}
      {focus.total > 1 && (
        <div className="mt-1.5 h-0.5 w-full overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-highlight/70 transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

/** Fallback chat label for a persisted run whose intent carried no free text. */
const ACTION_LABELS: Record<string, string> = {
  'build-api': 'Build this API',
  'new-scenario': 'Add a scenario',
  'cover-operation': 'Cover this operation with scenarios',
  ask: 'Question',
};

/**
 * One persisted past conversation: the user message plus a quiet meta row
 * (when, how it ended), with the full transcript behind a click — the history
 * is context, and must not bury the live conversation under old streams.
 */
export function HistoryConversation({ run }: { run: AgentHistoryRun }) {
  const [expanded, setExpanded] = useState(false);
  const when = new Date(run.startedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <div className="mb-2">
      <div className="mb-1 flex justify-end">
        <div className="max-w-[90%] rounded-lg rounded-br-sm bg-highlight/15 px-2.5 py-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground">
          {run.instruction || ACTION_LABELS[run.action] || run.action}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRightIcon className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-90')} />
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            run.status === 'done' ? 'bg-success' : 'bg-destructive',
          )}
        />
        <span className="truncate">
          {when} · {run.status === 'done' ? 'completed' : 'failed'}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 border-l-[1.5px] border-border pl-2.5">
          <AgentStream events={run.events} running={false} />
        </div>
      )}
    </div>
  );
}

// Moved to src/lib/operationFiles.ts (the store needs it too, and a store
// must not import from a component) — re-exported so existing imports keep
// working.
export { operationIdFromFile };

/**
 * The finished-run footer. Leads with the ACTION (open the operation the
 * agent created/edited — the UI moves forward with the work), then a compact
 * changed-files list; the raw diff sits behind a "View diff" disclosure and
 * revert is a quiet destructive link, not the loudest thing on screen.
 */
export function RunOutcome({
  diff,
  files,
  done,
  verdicts,
  onOpenOperation,
  onRevert,
}: {
  diff?: string;
  files: string[];
  done: boolean;
  /** Per-touched-operation scenario-suite result, fetched by the store at run
   *  finish. Absent while the fetch is in flight or when no operation was
   *  touched. */
  verdicts?: Record<string, ScenarioTestReport | { error: string }>;
  onOpenOperation: (opId: string) => void;
  onRevert: () => void;
}) {
  const [diffOpen, setDiffOpen] = useState(false);
  const ops = [...new Set(files.map(operationIdFromFile).filter((x): x is string => x !== null))];
  if (!diff) {
    return (
      <div className="shrink-0 border-t border-border/70 px-3.5 py-2 text-[12px] text-muted-foreground/70">
        No changes were made.
      </div>
    );
  }
  return (
    <div className="min-h-0 shrink-0 space-y-2 overflow-y-auto border-t border-border/70 p-3">
      {done && ops.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {ops.slice(0, 3).map((op) => (
            <Button key={op} size="sm" onClick={() => onOpenOperation(op)}>
              Open {op.split('/').pop()}
              <ArrowRightIcon className="size-3.5" />
            </Button>
          ))}
        </div>
      )}
      {done && verdicts && Object.entries(verdicts).map(([op, v]) => (
        <div key={op} className="space-y-0.5">
          <div className="flex items-center gap-2 text-[11.5px]">
            <span className="font-mono text-muted-foreground">{op}</span>
            {'error' in v ? (
              <span className="text-destructive/90">verdict unavailable — {v.error}</span>
            ) : (
              <>
                {v.passed > 0 && <span className="text-success">{v.passed} passed</span>}
                {v.failed > 0 && <span className="text-destructive">{v.failed} failed</span>}
                {v.passed + v.failed === 0 && <span className="text-muted-foreground/70">no scenarios yet</span>}
              </>
            )}
          </div>
          {!('error' in v) && v.results.filter((r) => r.status === 'failed').map((r) => (
            <div key={r.scenario} className="ml-2 font-mono text-[10.5px] text-destructive/80">
              {r.scenario}: {(r.failures ?? []).join('; ')}
            </div>
          ))}
        </div>
      ))}
      {files.length > 0 && (
        <div className="space-y-0.5">
          {files.map((f) => (
            <div key={f} className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
              <FileTextIcon className="size-3 shrink-0 text-muted-foreground/60" />
              <span className="truncate">{f}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setDiffOpen((o) => !o)}
          aria-expanded={diffOpen}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ChevronRightIcon className={cn('size-3 transition-transform', diffOpen && 'rotate-90')} />
          View diff
        </button>
        {done && (
          <button
            type="button"
            onClick={onRevert}
            className="text-[11px] text-destructive/80 underline underline-offset-2 hover:text-destructive"
          >
            Revert these changes
          </button>
        )}
      </div>
      {diffOpen && (
        <pre className="max-h-56 overflow-auto rounded-md border border-border bg-background/40 p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap">
          {diff}
        </pre>
      )}
    </div>
  );
}

const statusDot: Record<string, string> = {
  running: 'bg-highlight animate-pulse',
  done: 'bg-success',
  error: 'bg-destructive',
};

/**
 * Docked panel that streams a studio-triggered coding-agent run. Presents it
 * the way Codex/Claude present their own work: the agent's reasoning is the
 * content (comfortable prose), commands collapse to quiet one-liners you can
 * expand, and background diagnostics (MCP/hook noise) are tucked into a count
 * (all via the shared <AgentStream>). Then the diff with a Revert button once
 * the run finishes.
 */
export function AgentConsole({ onDismiss }: { onDismiss: () => void }) {
  // Guided-setup runs are OWNED by the WelcomeDialog's embedded stream — this
  // panel must not show their remnants (raw question blocks, and a Revert
  // button aimed at the user's own setup files).
  const agentRun = useBuilderStore((s) => (s.agentRun?.guided ? null : s.agentRun));
  const revertAgentRun = useBuilderStore((s) => s.revertAgentRun);
  const runAgent = useBuilderStore((s) => s.runAgent);
  const flowId = useBuilderStore((s) => s.flow.id);
  const flowName = useBuilderStore((s) => s.flow.name);
  const envSetup = useBuilderStore((s) => s.agentEnvSetup);
  const steerQueue = useBuilderStore((s) => s.steerQueue);
  const queueSteer = useBuilderStore((s) => s.queueSteer);
  const agentHistory = useBuilderStore((s) => s.agentHistory);
  const buildLedger = useBuilderStore((s) => s.buildLedger);
  const agentPlan = useBuilderStore((s) => s.agentPlan);
  const workflows = useBuilderStore((s) => s.workflows);
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

  // Follow the stream: while the run is live, keep the newest event in view by
  // scrolling to the bottom as content arrives — but only while the user is
  // already at (or near) the bottom. Scrolling up to reread pins the view
  // there; returning to the bottom re-engages the follow.
  const streamRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const eventCount = agentRun?.events.length ?? 0;
  // A fresh run always starts followed, wherever the last one left the scroll.
  useEffect(() => {
    stickToBottom.current = true;
  }, [agentRun?.id]);
  useEffect(() => {
    const el = streamRef.current;
    if (!el || !stickToBottom.current) return;
    const reduceMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [eventCount, agentRun?.status, agentRun?.verdicts, agentHistory]);

  const send = () => {
    const text = instruction.trim();
    if (!text) return;
    // Queue whenever a run is live OR a steer is already queued — not just
    // `running`. The run flips to 'done'/'error' at the top of finish(), but
    // the queued follow-up dispatch happens after several awaits; a manual
    // send in that gap must still queue (queueSteer appends) rather than race
    // the auto-dispatch as a second concurrent run the server would 409.
    if (running || steerQueue !== null) {
      // Agent CLIs run detached with stdin ignored — there's no live process
      // to inject into. Queue it; the store auto-dispatches it as the next
      // run the moment this one finishes.
      queueSteer(text);
      setInstruction('');
      return;
    }
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

  const finished = agentRun != null && agentRun.status !== 'running';
  const switchWorkflow = useBuilderStore((s) => s.switchWorkflow);
  // Only while a run is live — a finished run's ledger is a record, not a
  // "currently working on".
  const focus = running ? buildFocus(buildLedger, agentPlan, workflows) : null;

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

      <BuildFocusBar focus={focus} onOpen={(id) => switchWorkflow(id)} />

      <div
        ref={streamRef}
        onScroll={() => {
          const el = streamRef.current;
          if (!el) return;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3.5 py-3"
      >
        {/* Past conversations for the OPEN operation (its runs + its API's
            build runs), persisted server-side and re-shown whenever the
            operation is reopened. Collapsed to the user message + one summary
            line each; a click expands the full transcript. The live/latest
            run below is excluded to avoid doubling it. */}
        {!envSetup &&
          agentHistory
            .filter((h) => h.id !== agentRun?.id)
            .map((h) => <HistoryConversation key={h.id} run={h} />)}
        {/* Your message — the instruction you sent, shown first like a chat. */}
        {agentRun?.instruction && (
          <div className="mb-1 flex justify-end">
            <div className="max-w-[90%] rounded-lg rounded-br-sm bg-highlight/15 px-2.5 py-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground">
              {agentRun.instruction}
            </div>
          </div>
        )}
        {!agentRun && agentHistory.length === 0 && (
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
        {agentRun && <AgentStream events={agentRun.events} running={running} />}
      </div>

      {/* End of run = an OUTCOME, not a forensic dump: what changed as a file
          list, the next action as the primary affordance (open the operation
          the agent touched), raw diff behind a disclosure, revert demoted to a
          quiet link. */}
      {finished && agentRun && (agentRun.diff !== undefined || agentRun.status === 'error') && (
        <RunOutcome
          diff={agentRun.diff}
          files={agentRun.files ?? []}
          done={agentRun.status === 'done'}
          verdicts={agentRun.verdicts}
          onOpenOperation={(opId) => {
            switchWorkflow(opId);
            onDismiss();
          }}
          onRevert={() => void revertAgentRun()}
        />
      )}

      {/* Persistent chat input — the way to drive the open operation. Stays
          enabled while a run is live: typing here queues steering text
          rather than sending it (agent CLIs are detached with stdin
          ignored — there's no live process to inject into). */}
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
            placeholder={
              running
                ? 'The agent is working — type here to steer it (sent when this step finishes)…'
                : envSetup
                  ? 'e.g. dev on localhost:3001, prod at api.example.com (protected)'
                  : `Ask about ${flowName}, or tell the agent what to change…`
            }
            rows={2}
            className="min-h-0 flex-1 resize-none rounded-md border border-input bg-input/30 px-2.5 py-1.5 text-[12.5px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <Button
            size="icon"
            className="size-8 shrink-0"
            onClick={send}
            disabled={!instruction.trim()}
            aria-label="Send to agent"
            title="Send (⌘⏎)"
          >
            <ArrowUpIcon className="size-4" />
          </Button>
        </div>
        {steerQueue && (
          <div className="mt-1.5 flex items-center gap-1.5">
            <div className="text-[11px] text-highlight/90">Queued for the agent: “{steerQueue}”</div>
            <button
              type="button"
              onClick={() => queueSteer('')}
              aria-label="Clear queued message"
              className="text-muted-foreground/70 hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        )}
      </footer>
    </div>
  );
}
