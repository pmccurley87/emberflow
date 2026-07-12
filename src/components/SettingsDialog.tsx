import { useEffect, useState } from 'react';
import { GlobeIcon, RotateCcwIcon, ServerIcon, SettingsIcon } from 'lucide-react';
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

const ENGINE_OPTIONS: Array<{
  value: 'auto' | 'server' | 'browser';
  label: string;
  hint: string;
}> = [
  { value: 'auto', label: 'Auto', hint: 'runner when available (recommended)' },
  { value: 'server', label: 'Server', hint: 'always the local runner' },
  { value: 'browser', label: 'Browser', hint: 'in-tab engine, no secrets/CORS-free APIs' },
];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Settings dialog behind the toolbar gear. Absorbs the old EngineChip (execution
 * engine + runner status) and the Reset button, keeping the toolbar itself to
 * authoring + running.
 */
export function SettingsDialog() {
  const mode = useBuilderStore((s) => s.executionMode);
  const setMode = useBuilderStore((s) => s.setExecutionMode);
  const runnerOnline = useBuilderStore((s) => s.runnerOnline);
  const resetRun = useBuilderStore((s) => s.resetRun);
  const agentChoice = useBuilderStore((s) => s.agentChoice);
  const setAgentChoice = useBuilderStore((s) => s.setAgentChoice);
  // Open state lives in the store so the Welcome checklist can deep-link here.
  const open = useBuilderStore((s) => s.settingsOpen);
  const setOpen = useBuilderStore((s) => s.setSettingsOpen);
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

  const effective = mode === 'auto' ? (runnerOnline ? 'server' : 'browser') : mode;
  const offline = effective === 'server' && runnerOnline === false;

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
        <DialogTitle>Settings</DialogTitle>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <SectionTitle>Execution engine</SectionTitle>
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {effective === 'server' ? (
                <ServerIcon className="size-3" />
              ) : (
                <GlobeIcon className="size-3" />
              )}
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  offline
                    ? 'bg-destructive'
                    : effective === 'server'
                      ? 'bg-success'
                      : 'bg-muted-foreground',
                )}
              />
              {effective === 'server' ? 'runner online' : offline ? 'runner offline' : 'browser'}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {ENGINE_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => setMode(option.value)}
                className={cn(
                  'flex cursor-pointer flex-col items-start rounded-md border px-2.5 py-1.5 text-left transition-colors hover:bg-accent',
                  mode === option.value ? 'border-ring bg-secondary/60' : 'border-border',
                )}
              >
                <span className="text-[12.5px] font-medium">{option.label}</span>
                <span className="text-[11px] text-muted-foreground">{option.hint}</span>
              </button>
            ))}
          </div>
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
