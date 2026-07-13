import { useEffect, useState } from 'react';
import { CheckIcon, ChevronDownIcon, Settings2Icon, ShieldIcon, ShieldOffIcon, TheaterIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { EnvironmentDialog } from './EnvironmentDialog';
import { EnvironmentsDialog } from './EnvironmentsDialog';
import { useBuilderStore } from '../store/builderStore';

/**
 * Environment + mode + safe-mode selector. One dropdown answers "where do
 * runs point": Mock (example responses from scenarios — nothing executes) or
 * a real environment. Picking Mock is instant; picking an environment while
 * in Mock goes live through a confirm dialog (blocked outright when the
 * runner's default environment is protected — served traffic always runs for
 * real against it and ignores the studio's safe mode). Protected environments
 * force safe mode on; disabling it there requires typing the env name back.
 */
export function EnvironmentPicker() {
  const environments = useBuilderStore((s) => s.environments);
  const selected = useBuilderStore((s) => s.selectedEnvironment);
  const safeMode = useBuilderStore((s) => s.safeMode);
  const selectEnvironment = useBuilderStore((s) => s.selectEnvironment);
  const setSafeMode = useBuilderStore((s) => s.setSafeMode);
  const runnerOnline = useBuilderStore((s) => s.runnerOnline);
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [manageEnv, setManageEnv] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const runnerMock = useBuilderStore((s) => s.runnerMock);
  const setServingMode = useBuilderStore((s) => s.setServingMode);
  const environmentsDefault = useBuilderStore((s) => s.environmentsDefault);
  const [liveConfirm, setLiveConfirm] = useState<{ env: string; blocked: boolean } | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [envsOpen, setEnvsOpen] = useState(false);

  const current = environments.find((e) => e.name === selected);
  const protectedEnv = current?.protected ?? false;
  const offline = environments.length === 0;
  // The unmissable state: writes will execute against a protected environment.
  const live = protectedEnv && !safeMode;
  // Runs are always server-side; with the runner down there is no environment
  // to point at, so the picker says so plainly rather than naming a fallback.
  const label = runnerOnline === false ? 'Runner offline' : selected || 'default';

  const toggleSafe = () => {
    if (safeMode) {
      // Turning safe mode OFF on a protected env goes through the typed-confirm.
      if (protectedEnv) {
        setConfirmText('');
        setConfirmOpen(true);
        setOpen(false);
        return;
      }
      setSafeMode(false);
    } else {
      setSafeMode(true);
    }
  };

  const confirmDisable = () => {
    if (setSafeMode(false, confirmText.trim())) {
      setConfirmOpen(false);
    }
  };

  const pickMock = () => {
    setOpen(false);
    if (runnerMock) return;
    // Harmless direction — nothing will execute.
    void setServingMode('mock').catch(() => {});
  };

  const pickEnvironment = (name: string) => {
    setOpen(false);
    if (!runnerMock) {
      selectEnvironment(name);
      return;
    }
    // Leaving Mock: mounted endpoints resume real execution against the
    // runner's DEFAULT environment (not the picked one) — confirm, and block
    // outright when that default is protected.
    const servedEnv = environments.find((e) => e.name === environmentsDefault);
    setLiveError(null);
    setLiveConfirm({ env: name, blocked: !!servedEnv?.protected });
  };

  const openEnvironments = () => {
    setOpen(false);
    setEnvsOpen(true);
  };

  const confirmLive = () => {
    if (!liveConfirm) return;
    setLiveError(null);
    setServingMode('real')
      .then(() => {
        selectEnvironment(liveConfirm.env);
        setLiveConfirm(null);
      })
      .catch((err) =>
        setLiveError(err instanceof Error ? err.message : 'Failed to switch serving mode'),
      );
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className={cn(
              'flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11.5px] transition-colors',
              runnerMock
                ? 'bg-warn/15 font-medium text-warn hover:bg-warn/25'
                : live
                  ? 'bg-destructive/15 font-medium text-destructive-foreground hover:bg-destructive/25'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
            )}
            title={
              runnerMock
                ? 'Mock mode — everything answers with example responses from scenarios. Nothing executes, no auth, no database. Pick an environment to go live.'
                : 'Where runs point — pick Mock or a real environment'
            }
          >
            {runnerMock ? (
              <TheaterIcon className="size-3.5" />
            ) : live ? (
              <ShieldOffIcon className="size-3.5" />
            ) : (
              safeMode && <ShieldIcon className="size-3.5" />
            )}
            <span className={cn(live && !runnerMock && 'uppercase tracking-wide')}>
              {runnerMock ? 'Mock' : live ? `LIVE · ${label}` : label}
            </span>
            <ChevronDownIcon className="size-3 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-1" align="end">
          {runnerOnline === true && (
            <>
              <button
                onClick={pickMock}
                className="flex w-full cursor-pointer items-start gap-2 rounded-sm px-2.5 py-1.5 text-left transition-colors hover:bg-accent"
              >
                <CheckIcon className={cn('mt-0.5 size-3.5', runnerMock ? 'opacity-100' : 'opacity-0')} />
                <TheaterIcon className={cn('mt-0.5 size-3.5', runnerMock ? 'text-warn' : 'text-muted-foreground')} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className={cn('text-[12.5px] font-medium', runnerMock && 'text-warn')}>Mock</span>
                  <span className="text-[10.5px] leading-snug text-muted-foreground/80">
                    Example responses from scenarios — nothing executes.
                  </span>
                </span>
              </button>
              <div className="my-1 h-px bg-border" />
            </>
          )}
          {offline ? (
            runnerOnline === true ? (
              <div className="flex flex-col gap-1.5 px-2.5 py-2">
                <span className="text-[12px] leading-snug text-muted-foreground">
                  No environments yet — you're in Mock, where nothing real is touched. Create
                  environments (dev? prod? test?) to go live.
                </span>
                <Button size="sm" variant="secondary" onClick={openEnvironments}>
                  <Settings2Icon className="size-3.5" />
                  Manage environments…
                </Button>
              </div>
            ) : (
              <div className="px-2.5 py-3 text-[12px] text-muted-foreground">
                {runnerOnline === false
                  ? 'Runner offline — start it with `npx emberflow dev` to run and pick environments.'
                  : 'Loading environments…'}
              </div>
            )
          ) : (
            <div className="flex flex-col">
              {environments.map((env) => (
                <div
                  key={env.name}
                  className="group flex items-center gap-2 rounded-sm transition-colors hover:bg-accent"
                >
                  <button
                    onClick={() => pickEnvironment(env.name)}
                    title={runnerMock ? `Go live against ${env.name}` : undefined}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left"
                  >
                    <CheckIcon
                      className={cn(
                        'size-3.5',
                        env.name === selected && !runnerMock ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    {env.protected && <span className="size-1.5 rounded-full bg-destructive" />}
                    <span className="text-[12.5px] font-medium">{env.name}</span>
                    {env.protected && (
                      <span className="ml-auto text-[10.5px] uppercase tracking-wide text-destructive-foreground/80">
                        protected
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => {
                      setManageEnv(env.name);
                      setOpen(false);
                    }}
                    title={`Manage ${env.name} — secrets & auth`}
                    className="mr-1.5 cursor-pointer rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                  >
                    <Settings2Icon className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="my-1 h-px bg-border" />
          <button
            onClick={toggleSafe}
            className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-left transition-colors hover:bg-accent"
          >
            {safeMode ? (
              <ShieldIcon className="size-3.5 text-success" />
            ) : (
              <ShieldOffIcon className="size-3.5 text-destructive-foreground" />
            )}
            <span className="text-[12.5px] font-medium">Safe mode</span>
            <span
              className={cn(
                'ml-auto text-[11px] font-medium',
                safeMode ? 'text-success' : 'text-destructive-foreground',
              )}
            >
              {safeMode ? 'on' : 'off'}
            </span>
          </button>
          {runnerOnline === true && !offline && (
            <>
              <div className="my-1 h-px bg-border" />
              <button
                onClick={openEnvironments}
                title="See every environment, its secrets and auth — or describe changes to the agent."
                className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Settings2Icon className="size-3.5" />
                Manage environments…
              </button>
            </>
          )}
        </PopoverContent>
      </Popover>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>Disable safe mode on {selected}?</DialogTitle>
          <DialogDescription>
            Writes will execute for real against <span className="font-medium text-foreground">{selected}</span> —
            database mutations, emails and other side effects. Type{' '}
            <span className="font-mono text-foreground">{selected}</span> to confirm.
          </DialogDescription>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={selected}
            autoFocus
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && confirmText.trim() === selected) confirmDisable();
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={confirmText.trim() !== selected}
              onClick={confirmDisable}
            >
              Disable safe mode
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={liveConfirm !== null} onOpenChange={(o) => !o && setLiveConfirm(null)}>
        <DialogContent className="max-w-md">
          {liveConfirm?.blocked ? (
            <>
              <DialogTitle>The served environment is protected</DialogTitle>
              <DialogDescription>
                Mounted endpoints execute against the runner's default environment
                (<span className="font-medium text-foreground">{environmentsDefault}</span>),
                which is protected — and served traffic always runs for real, with no dry-run.
                The studio's safe mode does not apply to it. Change the default environment in{' '}
                <span className="font-mono text-foreground">emberflow.environments.json</span>{' '}
                before leaving Mock.
              </DialogDescription>
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => setLiveConfirm(null)}>
                  Close
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogTitle>Go live?</DialogTitle>
              <DialogDescription>
                Runs will execute real nodes against{' '}
                <span className="font-medium text-foreground">{liveConfirm?.env}</span>, and
                mounted endpoints will stop answering from scenario examples and execute for
                real against the{' '}
                <span className="font-medium text-foreground">{environmentsDefault}</span>{' '}
                environment — real side effects included. Served traffic ignores the studio's
                safe mode.
              </DialogDescription>
              {liveError && <div className="text-[12px] text-destructive">{liveError}</div>}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setLiveConfirm(null)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={confirmLive}>
                  Go live
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

      <EnvironmentsDialog open={envsOpen} onOpenChange={setEnvsOpen} />
    </>
  );
}

/** Poll the runner health + environments on an interval. Mounted once (in the toolbar). */
export function useRunnerPolling(): void {
  const checkRunner = useBuilderStore((s) => s.checkRunner);
  useEffect(() => {
    void checkRunner();
    const interval = setInterval(() => void checkRunner(), 10_000);
    return () => clearInterval(interval);
  }, [checkRunner]);
}
