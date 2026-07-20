import { useEffect, useState } from 'react';
import { CheckIcon, ChevronUpIcon, DownloadIcon, ListChecksIcon, Loader2Icon, ServerIcon, ShieldIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useBuilderStore } from '../store/builderStore';
import { buildFocus } from '../lib/buildFocus';
import { setupProgress } from '../store/setupClient';
import { fetchInfrastructure, type InfrastructureResponse } from '../store/infraClient';
import { fetchUpdateStatus, postUpdate, type UpdateStatus } from '../store/updateClient';
import { InfrastructureDialog } from './InfrastructureDialog';
import { CopyCommand } from './WelcomeDialog';
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
 * Package update chip: rendered only when the runner reports a newer published
 * version. Highlight/ember tint (not warn) — an update is good news, not a
 * problem. The popover walks the whole one-click flow: install → restart
 * command on success, manual npm command on failure. Props-driven (the bar
 * owns the fetch) so the component test can render it directly.
 */
export function UpdateChip({ status }: { status: UpdateStatus | null }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'installing' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  if (!status?.updateAvailable || !status.latest) return null;

  const onInstall = async () => {
    setPhase('installing');
    setError(null);
    const result = await postUpdate();
    if (result.ok) {
      setPhase('done');
    } else {
      setError(result.error ?? 'Install failed');
      setPhase('error');
    }
  };

  return (
    <>
      <Divider />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={`Update available — ${status.current} → ${status.latest}`}
            className={cn(segment, interactive, 'bg-highlight/15 font-medium text-highlight')}
          >
            <DownloadIcon className="size-3 shrink-0" />
            update
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-72 p-3">
          <div className="flex items-center gap-2">
            <span className="size-1.5 shrink-0 rounded-full bg-highlight" />
            <span className="text-[12px] font-medium">
              Update available — {status.current} → {status.latest}
            </span>
          </div>
          {phase === 'done' ? (
            <>
              <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
                Installed — restart the runner to finish:
              </p>
              <CopyCommand command="npx emberflow dev" />
            </>
          ) : (
            <>
              <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
                New features and fixes for the studio and runner.
              </p>
              {phase === 'error' && error && (
                <>
                  <p className="mt-1.5 truncate text-[11.5px] leading-snug text-destructive" title={error}>
                    {error}
                  </p>
                  <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
                    Install manually instead:
                  </p>
                  <CopyCommand command="npm install @xdelivered/emberflow@latest" />
                </>
              )}
              <button
                type="button"
                onClick={() => void onInstall()}
                disabled={phase === 'installing'}
                className="mt-2.5 flex items-center gap-1.5 rounded-md bg-highlight px-2.5 py-1 text-[11.5px] font-medium text-highlight-foreground transition-colors hover:bg-highlight/90 disabled:cursor-wait disabled:opacity-60"
              >
                {phase === 'installing' ? (
                  <>
                    <Loader2Icon className="size-3 shrink-0 animate-spin" />
                    Installing…
                  </>
                ) : phase === 'error' ? (
                  'Retry install'
                ) : (
                  'Install update'
                )}
              </button>
            </>
          )}
        </PopoverContent>
      </Popover>
    </>
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
  const buildLedger = useBuilderStore((s) => s.buildLedger);
  const agentPlan = useBuilderStore((s) => s.agentPlan);
  const workflows = useBuilderStore((s) => s.workflows);
  const openAgentPanel = useBuilderStore((s) => s.openAgentPanel);
  const buildFocusNow =
    agentRun?.status === 'running' ? buildFocus(buildLedger, agentPlan, workflows) : null;

  // Infrastructure chip: fetch on mount and whenever an agent run finishes (a
  // completed scout writes the manifest) — mirroring InfraTab's refetch. Shown
  // only once scouted; the welcome checklist owns the not-scouted path.
  const [infraData, setInfraData] = useState<InfrastructureResponse | null>(null);
  const [infraOpen, setInfraOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [mockOpen, setMockOpen] = useState(false);
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

  // Update notifier: one check per studio load — the runner caches the
  // registry answer for an hour anyway, so polling would add nothing.
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchUpdateStatus().then((s) => {
      if (!cancelled) setUpdateStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
          {/* Discrete explainer: mock is the mode every new project starts in,
              so the chip opens a small card saying what it means and how to
              leave it — a tooltip alone was too easy to never discover. */}
          <Popover open={mockOpen} onOpenChange={setMockOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(segment, interactive, 'bg-warn/15 font-medium uppercase tracking-wide text-warn')}
              >
                <span className="size-1.5 shrink-0 rounded-full bg-warn" />
                mock
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-72 p-3">
              <div className="flex items-center gap-2">
                <span className="size-1.5 shrink-0 rounded-full bg-warn" />
                <span className="text-[12px] font-medium">Mock mode</span>
              </div>
              <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
                Runs answer with the example responses from your scenarios. Nothing real executes —
                no databases, no external calls, no auth.
              </p>
              <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
                That makes it safe to run anything while you build. When you're ready, point runs at
                a real environment.
              </p>
              <button
                type="button"
                onClick={() => {
                  setMockOpen(false);
                  onEnvClick();
                }}
                className="mt-2.5 text-[11.5px] font-medium text-highlight underline-offset-2 hover:underline"
              >
                Go live — pick an environment
              </button>
            </PopoverContent>
          </Popover>
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
      {/* What the agent is building, for when the Agent panel is closed —
          clicking opens the panel where the full stream lives. */}
      {buildFocusNow?.id && (
        <>
          <Divider />
          <button
            type="button"
            onClick={openAgentPanel}
            title={`The agent is building ${buildFocusNow.name} — open the Agent panel`}
            className={cn(segment, interactive)}
          >
            <Loader2Icon className="size-3 shrink-0 animate-spin text-highlight motion-reduce:animate-none" />
            <span className="max-w-[180px] truncate text-foreground/80">{buildFocusNow.name}</span>
            {buildFocusNow.total > 1 && (
              <span className="shrink-0 font-mono tabular-nums text-muted-foreground/70">
                {buildFocusNow.done}/{buildFocusNow.total}
              </span>
            )}
          </button>
        </>
      )}
      <UpdateChip status={updateStatus} />
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
            title="Detail level — Simple shows outcomes; Technical adds types and traces"
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
        {updateStatus && (
          <>
            <Divider />
            <span className={segment} title="Emberflow version">
              <span className="shrink-0 font-mono text-muted-foreground/70">v{updateStatus.current}</span>
            </span>
          </>
        )}
      </div>
      <InfrastructureDialog open={infraOpen} onOpenChange={setInfraOpen} data={infraData} />
    </footer>
  );
}
