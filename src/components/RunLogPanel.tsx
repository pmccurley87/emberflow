import { useEffect, useRef, useState } from 'react';
import { Maximize2Icon, PanelBottomIcon, PanelRightIcon, ShieldIcon, XIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { effectiveConsolePosition, useBuilderStore } from '../store/builderStore';
import { useTailAnchor } from '../lib/useTailAnchor';
import { Json } from './Json';
import { LogMessage } from './LogMessage';
import { JsonModal } from './JsonModal';
import { cn } from '@/lib/utils';
import { filterLogs, formatDuration, payloadOpenByDefault } from '@/lib/registerLens';
import type { ViewRegister } from '@/lib/registerLens';
import type { NodeRunState } from '../engine';

const statusDot: Record<string, string> = {
  succeeded: 'bg-success',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground',
  running: 'bg-highlight animate-pulse',
};

const levelColor: Record<string, string> = {
  info: 'text-success',
  debug: 'text-muted-foreground/60',
  warn: 'text-yellow-500',
  error: 'text-destructive',
};

/**
 * Whether the run console panel should be docked into the layout. Owned at
 * the App level so the panel can join the resizable panel group like any
 * other IDE panel. Only runs that actually executed while this session
 * watched summon it — browsing run history never does — and it stays after
 * the run finishes until dismissed.
 *
 * In the simple register, starting a run never auto-opens the console — it
 * only opens once the user explicitly asks (the toolbar toggle), which is
 * tracked per-run in `runConsoleOpenedIds`; from then on that run's console
 * behaves exactly like the technical register's (dismiss/reopen). The
 * technical register ignores that tracking and stays open as it always has.
 */
export function useRunConsole(): { available: boolean; open: boolean; running: boolean } {
  const run = useBuilderStore((s) => s.run);
  const dismissedId = useBuilderStore((s) => s.runConsoleDismissedId);
  const register = useBuilderStore((s) => s.viewRegister);
  const openedIds = useBuilderStore((s) => s.runConsoleOpenedIds);
  const liveRunIds = useRef(new Set<string>());
  if (run?.status === 'running') liveRunIds.current.add(run.id);
  const available = run !== null && liveRunIds.current.has(run.id);
  const userOpenedForThisRun = run !== null && openedIds.has(run.id);
  const open = available && run!.id !== dismissedId && (register === 'technical' || userOpenedForThisRun);
  const running = run?.status === 'running';
  return { available, open, running };
}

/**
 * Node detail: the lower half of the console's master-detail split. Shows the
 * clicked node's LATEST input/output (or error), live as you step,
 * iteration-aware for loop bodies.
 */
function NodeDetail({
  label,
  typeName,
  state,
  onClose,
  register,
}: {
  label: string;
  typeName?: string;
  state: NodeRunState | undefined;
  onClose: () => void;
  register: ViewRegister;
}) {
  const [modal, setModal] = useState<{ title: string; value: unknown } | null>(null);
  const latestExec = state?.executions?.[state.executions.length - 1];
  const input = latestExec ? latestExec.input : state?.input;
  const output = latestExec ? latestExec.output : state?.output;
  const error = latestExec ? latestExec.error : state?.error;
  const durationMs =
    state?.startedAt && state?.completedAt
      ? new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime()
      : null;

  const pane = (title: string, value: unknown) => (
    <div className="group relative min-w-0 flex-1">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
        {title}
      </div>
      {value !== undefined ? (
        <>
          <Json value={value} />
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-6 right-1.5 size-6 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
            onClick={() => setModal({ title: `${label} · ${title.toLowerCase()}`, value })}
            aria-label={`View full ${title.toLowerCase()}`}
          >
            <Maximize2Icon className="size-3.5" />
          </Button>
        </>
      ) : (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[11.5px] text-muted-foreground/60">
          nothing captured
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background/40">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <span className={cn('size-1.5 rounded-full', statusDot[state?.status ?? 'running'] ?? 'bg-muted-foreground')} />
        <span className="min-w-0 truncate text-[12px] font-medium">{label}</span>
        {typeName && (
          <span className="hidden truncate font-mono text-[9.5px] text-muted-foreground sm:inline">{typeName}</span>
        )}
        {state?.iteration && (
          <Badge variant="mono" className="shrink-0 text-[9px]">
            {state.iteration.index + 1}/{state.iteration.total}
          </Badge>
        )}
        <span className="ml-auto shrink-0 text-[9.5px] text-muted-foreground/70">
          latest{durationMs !== null ? ` · ${formatDuration(durationMs, register)}` : ''}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onClose}
          aria-label="Close node detail"
        >
          <XIcon className="size-3" />
        </Button>
      </div>
      {state ? (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {pane('Input', input)}
          {error !== undefined ? (
            <div className="min-w-0">
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-destructive">Error</div>
              <pre className="overflow-auto rounded-md border border-destructive/50 bg-card p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-destructive-foreground">
                {error}
              </pre>
            </div>
          ) : (
            pane('Output', output)
          )}
        </div>
      ) : (
        <div className="p-4 text-[12px] text-muted-foreground/70">Not executed yet.</div>
      )}
      {modal && (
        <JsonModal
          title={modal.title}
          value={modal.value}
          open
          onOpenChange={(open) => {
            if (!open) setModal(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Run console: a docked IDE-style panel — either the rightmost column of the
 * layout or a panel below the dock (position-agnostic, chosen by the user via
 * the header's dock-side toggle) — that streams a run's logs live. Clicking a
 * node in the log opens a master-detail split with that node's latest
 * input/output.
 */
export function RunConsole({ onDismiss }: { onDismiss: () => void }) {
  const run = useBuilderStore((s) => s.run);
  const rawLogs = useBuilderStore((s) => s.logs);
  const register = useBuilderStore((s) => s.viewRegister);
  const flowName = useBuilderStore((s) => s.flow.name);
  const flowNodes = useBuilderStore((s) => s.flow.nodes);
  const selectNode = useBuilderStore((s) => s.selectNode);
  const consolePositionChoice = useBuilderStore((s) => s.consolePosition);
  const consolePosition = effectiveConsolePosition(consolePositionChoice, register);
  const setConsolePosition = useBuilderStore((s) => s.setConsolePosition);
  const [peek, setPeek] = useState<{ line: number; nodeId: string } | null>(null);

  const logs = filterLogs(rawLogs, register);
  const openByDefault = payloadOpenByDefault(register);

  // Follow the tail only while the reader is at the bottom (and no peek is
  // open) — scrolling up detaches; the pill jumps back.
  const { scrollerRef, endRef: logEndRef, detached, jumpToLatest } = useTailAnchor(logs.length, { suspended: !!peek });

  // Log indices reset with a new run's log stream — drop any open peek.
  const peekRunRef = useRef<string | null>(null);
  if ((run?.id ?? null) !== peekRunRef.current) {
    peekRunRef.current = run?.id ?? null;
    if (peek) setPeek(null);
  }

  // Filtering changes which line index maps to which log entry — a peek
  // anchored in one register can point at the wrong line (or nothing) in the
  // other, so drop it on register flips just like a new run does.
  const peekRegisterRef = useRef<ViewRegister>(register);
  if (register !== peekRegisterRef.current) {
    peekRegisterRef.current = register;
    if (peek) setPeek(null);
  }

  const finished = run !== null && run.status !== 'running';
  const durationMs =
    run?.completedAt && run.startedAt
      ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
      : null;

  // Live elapsed while running — a static "running…" undersells real work.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (finished) return;
    const t = setInterval(() => setNowTick(Date.now()), 250);
    return () => clearInterval(t);
  }, [finished]);
  const elapsedMs = finished
    ? durationMs
    : run?.startedAt
      ? Math.max(0, nowTick - new Date(run.startedAt).getTime())
      : null;
  const elapsedText = elapsedMs === null ? '' : formatDuration(elapsedMs, register);

  // Coarse progress: settled nodes over the flow's node count.
  const states = Object.values(run?.nodeStates ?? {});
  const settled = states.filter((s) => s.status === 'succeeded' || s.status === 'failed' || s.status === 'skipped').length;
  const total = Math.max(states.length, 1);
  const errorCount = states.filter((s) => s.status === 'failed').length;

  const peekNode = peek ? flowNodes.find((n) => n.id === peek.nodeId) : undefined;

  const logList = (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollerRef as unknown as React.Ref<HTMLDivElement>} className="relative min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {detached && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="sticky top-0 left-1/2 z-10 -translate-x-1/2 rounded-full border border-highlight/40 bg-card px-3 py-0.5 text-[10.5px] text-highlight shadow-md hover:bg-secondary"
          >
            ↓ latest
          </button>
        )}
        {logs.length === 0 && (
          <div className="px-1 py-2 text-[12px] text-muted-foreground/70">Waiting for logs…</div>
        )}
        {logs.map((line, i) => (
          <div
            key={i}
            className={cn(
              'flex items-baseline gap-2.5 py-0.5 font-mono text-[11px]',
              line.level === 'debug' && 'opacity-60',
            )}
          >
            <span className="shrink-0 text-muted-foreground/50">{line.timestamp.slice(11, 19)}</span>
            <span
              className={cn('w-9 shrink-0 text-[9.5px] uppercase tracking-wider', levelColor[line.level] ?? '')}
            >
              {line.level}
            </span>
            {line.nodeId ? (
              <button
                type="button"
                onClick={() => {
                  const already = peek?.line === i;
                  setPeek(already ? null : { line: i, nodeId: line.nodeId! });
                  if (!already) selectNode(line.nodeId!);
                }}
                title="Inspect latest input/output"
                className={cn(
                  'w-36 shrink-0 cursor-pointer truncate text-left underline-offset-2 transition-colors',
                  peek?.line === i
                    ? 'text-highlight underline'
                    : 'text-foreground/85 hover:text-highlight hover:underline',
                )}
              >
                {line.nodeLabel ?? line.nodeId}
              </button>
            ) : (
              <span className="w-36 shrink-0 truncate text-foreground/85">{line.nodeLabel ?? '—'}</span>
            )}
            <LogMessage message={line.message} defaultOpen={openByDefault} />
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  );

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col bg-card/60',
        consolePosition === 'bottom' ? 'border-t border-border' : 'border-l border-border',
      )}
    >
      <header className="relative flex h-11 shrink-0 items-center gap-2.5 border-b border-border/70 px-3.5">
        <span className={cn('size-2 rounded-full', statusDot[run?.status ?? 'running'])} />
        <span className="min-w-0 truncate text-[12.5px] font-medium">{flowName}</span>
        {run?.environment && (
          <Badge variant="outline" className="shrink-0 text-[9px] uppercase">
            {run.environment}
          </Badge>
        )}
        {run?.safeMode && <ShieldIcon className="size-3 shrink-0 text-muted-foreground" />}
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{elapsedText}</span>
        <div className="flex shrink-0 items-center gap-0.5 border-l border-border/70 pl-1.5">
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'size-6 text-muted-foreground hover:text-foreground',
              consolePosition === 'right' && 'bg-secondary/60 text-foreground',
            )}
            onClick={() => setConsolePosition('right')}
            aria-label="Dock right"
            aria-pressed={consolePosition === 'right'}
            title="Dock right"
          >
            <PanelRightIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'size-6 text-muted-foreground hover:text-foreground',
              consolePosition === 'bottom' && 'bg-secondary/60 text-foreground',
            )}
            onClick={() => setConsolePosition('bottom')}
            aria-label="Dock bottom"
            aria-pressed={consolePosition === 'bottom'}
            title="Dock bottom"
          >
            <PanelBottomIcon className="size-3.5" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
          aria-label="Dismiss run console"
        >
          <XIcon className="size-3.5" />
        </Button>
        {/* Run progress underlining the header — completes and quietly fades. */}
        <div className="absolute inset-x-0 bottom-0 h-px overflow-visible">
          <div
            className={cn(
              'h-[2px] rounded-full transition-[width,opacity] duration-500 ease-out',
              run?.status === 'failed' ? 'bg-destructive/80' : 'bg-highlight/80',
              finished && run?.status !== 'failed' && 'opacity-0',
            )}
            style={{ width: `${Math.round((settled / total) * 100)}%` }}
          />
        </div>
      </header>
      {peek ? (
        <ResizablePanelGroup direction="vertical" className="min-h-0 flex-1" autoSaveId="emberflow-run-detail">
          <ResizablePanel id="run-logs" order={1} defaultSize={55} minSize={25}>
            {logList}
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="run-node" order={2} defaultSize={45} minSize={25}>
            <NodeDetail
              label={peekNode?.label ?? peek.nodeId}
              typeName={peekNode?.type}
              state={run?.nodeStates[peek.nodeId]}
              onClose={() => setPeek(null)}
              register={register}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        logList
      )}
      {finished && (
        <footer className="flex shrink-0 items-center gap-2 border-t border-border/70 px-3.5 py-2">
          <span className={cn('size-1.5 rounded-full', statusDot[run.status])} />
          <span className="text-[12px] capitalize text-foreground/90">{run.status}</span>
          <span className="text-[11px] text-muted-foreground">
            · {settled}/{total} nodes{errorCount > 0 ? ` · ${errorCount} failed` : ''}
          </span>
          <Button variant="secondary" size="sm" className="ml-auto" onClick={onDismiss}>
            Dismiss
          </Button>
        </footer>
      )}
    </div>
  );
}
