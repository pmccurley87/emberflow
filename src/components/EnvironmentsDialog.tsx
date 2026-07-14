import { useState } from 'react';
import { ArrowLeftIcon, KeyRoundIcon, Settings2Icon, SparklesIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { EnvironmentDialog } from './EnvironmentDialog';
import { useBuilderStore } from '../store/builderStore';

/**
 * The Environments overview modal — one place to SEE what exists. Each row
 * opens the per-environment Manage dialog (secrets + auth); creating or
 * reshaping environments is agent work: the call-to-action hands off to the
 * agent panel in environment-setup mode, where the user describes what they
 * want in prose and can keep refining it conversationally.
 */
export function EnvironmentsDialog({
  open,
  onOpenChange,
  onBack,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set (opened from the Welcome checklist), a back arrow beside the
   *  title returns there instead of just closing. */
  onBack?: () => void;
}) {
  const environments = useBuilderStore((s) => s.environments);
  const environmentsDefault = useBuilderStore((s) => s.environmentsDefault);
  const beginEnvironmentSetup = useBuilderStore((s) => s.beginEnvironmentSetup);
  const agentRunning = useBuilderStore((s) => s.agentRun?.status === 'running');
  const [manageEnv, setManageEnv] = useState<string | null>(null);

  const setupWithAi = () => {
    onOpenChange(false);
    beginEnvironmentSetup();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <div className="flex items-center gap-2">
            {onBack && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onBack}
                aria-label="Back to setup checklist"
                className="-ml-1.5 size-6 text-muted-foreground hover:text-foreground"
              >
                <ArrowLeftIcon className="size-4" />
              </Button>
            )}
            <DialogTitle>Environments</DialogTitle>
          </div>
          {environments.length === 0 ? (
            <>
              <DialogDescription>
                No environments yet — you're in Mock, where nothing real is touched. Environments
                are the real places runs can point at (dev? prod? test?); create them to go live.
              </DialogDescription>
              <div className="flex justify-end">
                <Button onClick={setupWithAi} disabled={agentRunning}>
                  <SparklesIcon className="size-3.5" />
                  Set up with AI
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogDescription>
                Where runs can point. Secrets and auth live per environment — open one to manage
                them. To add or reshape environments, describe the change to the agent.
              </DialogDescription>
              <div className="flex flex-col gap-1">
                {environments.map((env) => (
                  <button
                    key={env.name}
                    onClick={() => setManageEnv(env.name)}
                    title={`Manage ${env.name} — secrets & auth`}
                    className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-border/70 px-3 py-2 text-left transition-colors hover:bg-accent"
                  >
                    <span
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        env.protected ? 'bg-destructive' : 'bg-success/70',
                      )}
                    />
                    <span className="text-[13px] font-medium">{env.name}</span>
                    {env.name === environmentsDefault && (
                      <span className="rounded bg-secondary px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-muted-foreground">
                        default
                      </span>
                    )}
                    {env.protected && (
                      <span
                        title="Protected — runs ask for confirmation before touching this environment."
                        className="text-[10px] uppercase tracking-wide text-destructive-foreground/80"
                      >
                        protected
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
                      {env.varKeys.length > 0 && <span>{env.varKeys.length} vars</span>}
                      {env.auth?.configured && (
                        <span
                          className="flex items-center gap-1"
                          title={env.auth.authenticated ? 'Auth configured — logged in' : 'Auth configured — not logged in'}
                        >
                          <KeyRoundIcon className="size-3" />
                          {env.auth.authenticated ? 'auth ✓' : 'auth'}
                        </span>
                      )}
                      <Settings2Icon className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
                    </span>
                  </button>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
                <Button variant="secondary" size="sm" onClick={setupWithAi} disabled={agentRunning}>
                  <SparklesIcon className="size-3.5" />
                  Change with AI
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <EnvironmentDialog
        env={environments.find((e) => e.name === manageEnv) ?? null}
        open={manageEnv !== null}
        onOpenChange={(o) => {
          if (!o) setManageEnv(null);
        }}
      />
    </>
  );
}
