import { useEffect, useMemo, useState } from 'react';
import { SparklesIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useBuilderStore } from '../store/builderStore';
import { routeCommand, type RouteContext, type RoutedIntent } from '../lib/commandRouting';

/** Presentational: input + routed option rows. Pure props for tests. */
export function CommandBarPanel({
  text,
  ctx,
  highlighted,
  running,
  onText,
  onPick,
}: {
  text: string;
  ctx: RouteContext;
  highlighted: number;
  /** True while an agent run is in flight — steers the picker to a quiet
   *  hint instead of silently launching a second, conflicting run. */
  running?: boolean;
  onText: (t: string) => void;
  onPick: (intent: RoutedIntent) => void;
}) {
  const routed = useMemo(() => routeCommand(text, ctx), [text, ctx]);
  return (
    <div className="space-y-2">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => onText(e.target.value)}
        placeholder="Tell Emberflow what you want — build, change, test, or ask…"
        rows={2}
        className="w-full resize-none rounded-md border border-input bg-background/60 px-3 py-2 text-[13px] leading-relaxed text-foreground shadow-inner outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <div className="space-y-0.5" role="listbox" aria-label="What to do with this">
        {routed.map((r, i) => (
          <button
            key={r.kind}
            type="button"
            role="option"
            aria-selected={i === highlighted}
            onClick={() => onPick(r)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
              i === highlighted
                ? 'bg-highlight/[0.08] text-foreground'
                : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
            )}
          >
            <SparklesIcon className={cn('size-3.5 shrink-0', i === highlighted ? 'text-highlight' : 'text-muted-foreground/50')} />
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            {i === highlighted && <kbd className="shrink-0 font-mono text-[10px] text-muted-foreground">↵</kbd>}
          </button>
        ))}
      </div>
      {running && (
        <p className="px-0.5 text-[11px] text-muted-foreground">
          An agent run is in progress — steer it from the Agent panel.
        </p>
      )}
    </div>
  );
}

/** Connected ⌘K dialog. Mounted once in App. */
export function CommandBar() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const flow = useBuilderStore((s) => s.flow);
  const workflows = useBuilderStore((s) => s.workflows);
  const runAgent = useBuilderStore((s) => s.runAgent);
  const buildApi = useBuilderStore((s) => s.buildApi);
  const openAgentPanel = useBuilderStore((s) => s.openAgentPanel);
  const agentRunning = useBuilderStore((s) => s.agentRun?.status === 'running');
  // An empty workspace carries a placeholder flow (see emptyWorkspaceFlow in
  // the store) — treat it as "no current flow" so edit/scenario routes never
  // target it.
  const currentFlow = workflows.length > 0 ? flow : null;
  const ctx: RouteContext = {
    currentFlowId: currentFlow?.id ?? null,
    currentFlowName: currentFlow?.name ?? null,
    hasOps: workflows.length > 0,
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (intent: RoutedIntent) => {
    const t = text.trim();
    if (!t) return;
    // An agent run is already live — launching another here would either
    // clobber the run slot or fire a second run behind its back (see
    // runAgent's startAgent-catch guard). Keep the dialog open with the
    // hint visible instead; the user steers from the Agent panel.
    if (agentRunning) return;
    setOpen(false);
    setText('');
    openAgentPanel();
    if (intent.kind === 'build') void buildApi({ location: 'default', goal: t });
    else if (intent.kind === 'ask') void runAgent({ action: 'ask', flowId: currentFlow?.id, instruction: t });
    else if (intent.kind === 'scenario' && currentFlow) void runAgent({ action: 'new-scenario', flowId: currentFlow.id, instruction: t });
    else if (currentFlow) void runAgent({ action: 'edit-flow', flowId: currentFlow.id, instruction: t });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-w-xl p-3"
        onKeyDown={(e) => {
          const count = routeCommand(text, ctx).length;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlighted((h) => (h + 1) % count);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlighted((h) => (h - 1 + count) % count);
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            pick(routeCommand(text, ctx)[highlighted]);
          }
        }}
      >
        <DialogTitle className="sr-only">Tell Emberflow what you want</DialogTitle>
        <CommandBarPanel
          text={text}
          ctx={ctx}
          highlighted={highlighted}
          running={agentRunning}
          onText={(t) => {
            setText(t);
            setHighlighted(0);
          }}
          onPick={pick}
        />
      </DialogContent>
    </Dialog>
  );
}
