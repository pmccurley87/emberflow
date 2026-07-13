import { useEffect, useState } from 'react';
import { ArrowLeftIcon, RotateCcwIcon, SettingsIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useBuilderStore } from '../store/builderStore';
import { fetchAvailableAgents } from '../store/agentClient';
import type { AgentKind, DetectedAgent } from '../store/agentClient';

const AGENT_LABELS: Record<AgentKind, string> = {
  codex: 'Codex',
  claude: 'Claude',
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Settings dialog behind the toolbar gear. Holds the coding-agent picker and
 * the Reset button; runner status lives in the StatusBar. Execution is always
 * server-side, so there is no engine choice here.
 */
export function SettingsDialog() {
  const resetRun = useBuilderStore((s) => s.resetRun);
  const agentChoice = useBuilderStore((s) => s.agentChoice);
  const setAgentChoice = useBuilderStore((s) => s.setAgentChoice);
  // Open state lives in the store so the Welcome checklist can deep-link here.
  const open = useBuilderStore((s) => s.settingsOpen);
  const setOpen = useBuilderStore((s) => s.setSettingsOpen);
  const fromWelcome = useBuilderStore((s) => s.settingsFromWelcome);
  const setWelcomeOpen = useBuilderStore((s) => s.setWelcomeOpen);
  const [availableAgents, setAvailableAgents] = useState<DetectedAgent[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchAvailableAgents().then((agents) => {
      if (!cancelled) setAvailableAgents(agents);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Settings"
          className="text-muted-foreground hover:text-foreground"
        >
          <SettingsIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <div className="flex items-center gap-2">
          {fromWelcome && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setOpen(false);
                setWelcomeOpen(true);
              }}
              aria-label="Back to setup checklist"
              className="-ml-1.5 size-6 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
          )}
          <DialogTitle>Settings</DialogTitle>
        </div>

        <div className="space-y-2">
          <SectionTitle>Coding agent</SectionTitle>
          {availableAgents.length === 0 ? (
            <span className="text-[12px] text-muted-foreground">
              No agent CLIs detected on PATH (looked for codex, claude).
            </span>
          ) : (
            <div className="flex flex-col gap-1">
              {availableAgents.map(({ kind, version }) => (
                <button
                  key={kind}
                  onClick={() => setAgentChoice({ ...agentChoice, agent: kind })}
                  className={cn(
                    'flex cursor-pointer items-center rounded-md border px-2.5 py-1.5 text-left transition-colors hover:bg-accent',
                    (agentChoice.agent ?? availableAgents[0]?.kind) === kind
                      ? 'border-ring bg-secondary/60'
                      : 'border-border',
                  )}
                >
                  <span className="text-[12.5px] font-medium">
                    {AGENT_LABELS[kind]}
                    {version ? <span className="ml-1.5 font-normal text-muted-foreground">— {version}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Model (blank = default)</span>
            <input
              type="text"
              value={agentChoice.model ?? ''}
              onChange={(e) => setAgentChoice({ ...agentChoice, model: e.target.value.trim() || undefined })}
              placeholder="default"
              className="rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] outline-none focus:border-ring"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Reasoning effort</span>
            <div className="flex gap-1">
              {(['low', 'medium', 'high'] as const).map((level) => {
                const active = (agentChoice.reasoning ?? 'medium') === level;
                return (
                  <button
                    key={level}
                    type="button"
                    onClick={() => setAgentChoice({ ...agentChoice, reasoning: level })}
                    className={cn(
                      'flex-1 rounded-md border px-2 py-1.5 text-[12px] capitalize transition-colors',
                      active
                        ? 'border-highlight bg-highlight/15 text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {level}
                  </button>
                );
              })}
            </div>
            <span className="text-[10.5px] text-muted-foreground/70">
              Higher = smarter but slower. Default medium; the agent builds better at medium/high.
            </span>
          </label>
        </div>

        <div className="space-y-2">
          <SectionTitle>Run state</SectionTitle>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-muted-foreground">
              Clear the current run, its logs and any live execution.
            </span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={() => {
                resetRun();
                setOpen(false);
              }}
            >
              <RotateCcwIcon className="size-3.5" />
              Reset run state
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
