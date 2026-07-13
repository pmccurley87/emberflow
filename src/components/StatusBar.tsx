import { useEffect, useState } from 'react';
import { CheckIcon, ChevronUpIcon, ListChecksIcon, Loader2Icon, ServerIcon, ShieldIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useBuilderStore } from '../store/builderStore';
import { setupProgress } from '../store/setupClient';
import { fetchInfrastructure, type InfrastructureResponse } from '../store/infraClient';
import { InfrastructureDialog } from './InfrastructureDialog';
import type { EnvironmentSummary } from '../store/serverRunner';
import type { WorkflowRun } from '../engine';

const statusDot: Record<string, string> = {
  succeeded: 'bg-success',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground',
  running: 'bg-highlight animate-pulse',
};

/** Live-ticking elapsed while running, frozen duration once finished. */
function useRunElapsed(run: WorkflowRun | null): string {
  const finished = run !== null && run.status !== 'running';
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (finished) return;
    const t = setInterval(() => setNowTick(Date.now()), 250);
    return () => clearInterval(t);
  }, [finished]);
  const durationMs =
    run?.completedAt && run.startedAt
      ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
      : null;
  const elapsedMs = finished
    ? durationMs
    : run?.startedAt
      ? Math.max(0, nowTick - new Date(run.startedAt).getTime())
      : null;
  return elapsedMs === null
    ? ''
    : elapsedMs < 1000
      ? `${elapsedMs}ms`
      : `${(elapsedMs / 1000).toFixed(1)}s`;
}

const Divider = () => <span className="mx-0.5 h-3 w-px shrink-0 bg-border/70" />;

const segment = 'flex h-full min-w-0 items-center gap-1.5 px-2';
const interactive = 'cursor-pointer transition-colors hover:bg-secondary/50';

/**
 * Login-auth affordance for a runner environment. Hidden entirely unless the
 * environment declares `auth.configured` — no visual change for envs without
 * it. Never renders a secret value, only the authenticated boolean.
 */
function EnvAuthBadge({ env }: { env: EnvironmentSummary }) {
  const loginEnvironment = useBuilderStore((s) => s.loginEnvironment);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authed = env.auth?.authenticated ?? false;

  const onLogin = async () => {
    setError(null);
    setPending(true);
    try {
      await loginEnvironment(env.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setPending(false);
    }
  };

  if (authed) {
    // Authenticated: calm filled dot. The whole segment is a quiet re-login
    // control — hovering swaps the label so the affordance is discoverable
    // without adding noise to the resting bar.
    return (
      <button
        type="button"
        onClick={() => void onLogin()}
        disabled={pending}
        title={error ?? 'Authenticated — click to log in again'}
        className={cn(segment, 'group', interactive, 'disabled:cursor-wait disabled:opacity-60')}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-success" />
        {pending ? (
          <span className="flex items-center gap-1 truncate">
            <Loader2Icon className="size-3 shrink-0 animate-spin" />
            Logging in…
          </span>
        ) : (
          <>
            <span className="truncate group-hover:hidden">authenticated</span>
            <span className="hidden truncate text-foreground/80 group-hover:inline">Re-log in</span>
          </>
        )}
        {error && <span className="truncate text-destructive">{error}</span>}
      </button>
    );
  }

  return (
    <span className={segment} title={error ?? 'Not authenticated'}>
      <span className="size-1.5 shrink-0 rounded-full border border-muted-foreground" />
      <button
        type="button"
        onClick={() => void onLogin()}
        disabled={pending}
        className={cn(
          'flex items-center gap-1 truncate text-foreground/80 transition-colors hover:text-foreground disabled:cursor-wait disabled:opacity-60',
        )}
      >
        {pending && <Loader2Icon className="size-3 shrink-0 animate-spin" />}
        {pending ? 'Logging in…' : 'Log in'}
      </button>
      {error && <span className="truncate text-destructive">{error}</span>}
    </span>
  );
}

/**
 * Bottom status bar: a calm, always-present readout of where a run points and
 * what's happening. Left = environment / runner / workspace source (interactive
 * where it's safe to be); right = selection, flow shape and the live run.
 */
export function StatusBar() {
  const environments = useBuilderStore((s) => s.environments);
  const selectedEnvironment = useBuilderStore((s) => s.selectedEnvironment);
  const safeMode = useBuilderStore((s) => s.safeMode);
  const setSafeMode = useBuilderStore((s) => s.setSafeMode);
  const runnerOnline = useBuilderStore((s) => s.runnerOnline);
  const runnerMock = useBuilderStore((s) => s.runnerMock);
  const checkRunner = useBuilderStore((s) => s.checkRunner);
  const workspaceSource = useBuilderStore((s) => s.workspaceSource);
  const register = useBuilderStore((s) => s.viewRegister);
  const setRegister = useBuilderStore((s) => s.setViewRegister);
  const selectedNodeId = useBuilderStore((s) => s.selectedNodeId);
  const flow = useBuilderStore((s) => s.flow);
  const run = useBuilderStore((s) => s.run);
  const setupStatus = useBuilderStore((s) => s.setupStatus);
  const setWelcomeOpen = useBuilderStore((s) => s.setWelcomeOpen);
  const agentRun = useBuilderStore((s) => s.agentRun);

  // Infrastructure chip: fetch on mount and whenever an agent run finishes (a
  // completed scout writes the manifest) — mirroring InfraTab's refetch. Shown
  // only once scouted; the welcome checklist owns the not-scouted path.
  const [infraData, setInfraData] = useState<InfrastructureResponse | null>(null);
  const [infraOpen, setInfraOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const agentRunStatus = agentRun?.status;
  useEffect(() => {
    if (agentRunStatus === 'running') return;
    let cancelled = false;
    void fetchInfrastructure().then((d) => {
      if (!cancelled) setInfraData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [agentRunStatus]);
  // Scouted (present:true) → show the chip, even for a greenfield 0-item
  // manifest; only the not-scouted path is hidden (owned by the checklist).
  const infraCount = infraData && infraData.present ? infraData.manifest.items.length : null;

  // Setup entry point: a quiet progress chip while onboarding is unfinished.
  // Complete setups drop the chip — the checklist auto-open and this chip are
  // the only entry points, and a finished checklist has nothing left to do.
  const progress = setupStatus ? setupProgress(setupStatus) : null;
  const setupPending = progress !== null && progress.done < progress.total;

  const current = environments.find((e) => e.name === selectedEnvironment);
  const protectedEnv = current?.protected ?? false;
  const envLabel = selectedEnvironment || (runnerOnline === false ? 'offline' : 'default');

  const onEnvClick = () => {
    if (!safeMode) {
      // Off → always allowed back on.
      setSafeMode(true);
      return;
    }
    // Safe on: an unprotected env may be flipped off inline; protected must go
    // through the environment picker's typed confirmation.
    if (!protectedEnv) setSafeMode(false);
  };
  const envTitle = !safeMode
    ? 'Safe mode off — click to re-enable'
    : protectedEnv
      ? 'Protected environment — use the environment picker to go live'
      : 'Safe mode on — click to turn off';

  const runnerDot =
    runnerOnline === true ? 'bg-success' : runnerOnline === false ? 'bg-destructive' : 'bg-muted-foreground';
  const runnerTitle =
    runnerOnline === true
      ? 'Runner online — click to re-check'
      : runnerOnline === false
        ? 'Runner offline — click to re-check'
        : 'Runner status unknown — click to check';

  const selectedNode = selectedNodeId
    ? flow.nodes.find((n) => n.id === selectedNodeId)
    : undefined;

  const elapsed = useRunElapsed(run);

  return (
    <footer className="flex h-[24px] shrink-0 items-center overflow-hidden border-t border-border bg-tertiary text-[11px] text-muted-foreground select-none">
      <button type="button" onClick={onEnvClick} title={envTitle} className={cn(segment, interactive)}>
        <span
          className={cn('size-1.5 shrink-0 rounded-full', protectedEnv ? 'bg-destructive' : 'bg-muted-foreground')}
        />
        <span className="truncate text-foreground/80">{envLabel}</span>
        {safeMode && <ShieldIcon className="size-3 shrink-0" />}
      </button>
      {current?.auth?.configured && (
        <>
          <Divider />
          <EnvAuthBadge key={current.name} env={current} />
        </>
      )}
      {runnerMock && (
        <>
          <Divider />
          <span
            className={cn(segment, 'bg-warn/15 font-medium uppercase tracking-wide text-warn')}
            title="The studio is in Mock mode — mounted endpoints answer with example responses from scenarios; nothing executes, no auth. Pick an environment in the toolbar dropdown to go live."
          >
            <span className="size-1.5 shrink-0 rounded-full bg-warn" />
            mock
          </span>
        </>
      )}
      <Divider />
      <button
        type="button"
        onClick={() => void checkRunner()}
        title={runnerTitle}
        className={cn(segment, interactive)}
      >
        <span className={cn('size-1.5 shrink-0 rounded-full', runnerDot)} />
        <span className="truncate">runner</span>
      </button>
      {/* Workspace source only matters in the exception state: a browser-local
          workspace means edits are NOT landing in the project's files. The
          normal case (editing the runner's files) needs no chip. */}
      {workspaceSource !== 'server' && (
        <>
          <Divider />
          <span
            className={cn(segment, 'bg-warn/15 font-medium text-warn')}
            title="Editing a browser-local workspace — the runner is offline, so changes are not written to your project's files. They adopt into the project when the runner comes back."
          >
            local only
          </span>
        </>
      )}
      {setupPending && progress && (
        <>
          <Divider />
          <button
            type="button"
            onClick={() => setWelcomeOpen(true)}
            title="Setup — first-run checklist for this project"
            className={cn(segment, interactive)}
          >
            <ListChecksIcon className="size-3 shrink-0" />
            <span className="truncate text-foreground/80">setup</span>
            <span className="shrink-0 font-mono tabular-nums text-muted-foreground/70">
              {progress.done}/{progress.total}
            </span>
          </button>
        </>
      )}
      {infraCount !== null && (
        <>
          <Divider />
          <button
            type="button"
            onClick={() => setInfraOpen(true)}
            title="Project infrastructure — what the scout found that agents reuse"
            className={cn(segment, interactive)}
          >
            <ServerIcon className="size-3 shrink-0" />
            <span className="truncate text-foreground/80">infra</span>
            <span className="shrink-0 font-mono tabular-nums text-muted-foreground/70">{infraCount}</span>
          </button>
        </>
      )}
      <Divider />
      <Popover open={registerOpen} onOpenChange={setRegisterOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Runbook register — Simple reads outcomes; Technical adds type names + trace badges"
            className={cn(segment, interactive)}
          >
            <span className="truncate capitalize text-foreground/80">{register}</span>
            <ChevronUpIcon className="size-3 shrink-0 text-muted-foreground/70" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-40 p-1"
          role="radiogroup"
          aria-label="Runbook register"
        >
          {(['simple', 'technical'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={register === v}
              onClick={() => {
                setRegister(v);
                setRegisterOpen(false);
              }}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-[4px] px-2 py-1 text-left text-[11px] capitalize transition-colors',
                register === v ? 'text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
              )}
            >
              <span>{v}</span>
              {register === v && <CheckIcon className="size-3 shrink-0 text-highlight" />}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <div className="ml-auto flex h-full min-w-0 items-center">
        {selectedNode && (
          <>
            <span className={segment} title="Selected node">
              <span className="truncate font-mono text-foreground/75">{selectedNode.label}</span>
            </span>
            <Divider />
          </>
        )}
        <span className={segment} title="Active flow">
          <span className="truncate">{flow.name}</span>
          <span className="shrink-0 text-muted-foreground/70">
            · {flow.nodes.length} {flow.nodes.length === 1 ? 'node' : 'nodes'}
          </span>
        </span>
        {run && (
          <>
            <Divider />
            <span className={segment} title="Latest run">
              <span className={cn('size-1.5 shrink-0 rounded-full', statusDot[run.status] ?? 'bg-muted-foreground')} />
              <span className="shrink-0 capitalize text-foreground/80">{run.status}</span>
              {elapsed && (
                <span className="shrink-0 font-mono tabular-nums text-muted-foreground/70">{elapsed}</span>
              )}
            </span>
          </>
        )}
      </div>
      <InfrastructureDialog open={infraOpen} onOpenChange={setInfraOpen} data={infraData} />
    </footer>
  );
}
