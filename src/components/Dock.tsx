import { useEffect, useState } from 'react';
import { CheckIcon, ChevronDownIcon, HistoryIcon, Loader2Icon, Maximize2Icon, ShieldIcon, TheaterIcon, XIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useBuilderStore } from '../store/builderStore';
import { useTailAnchor } from '../lib/useTailAnchor';
import { ExecutionPager } from './ExecutionPager';
import { Json } from './Json';
import { LogMessage } from './LogMessage';
import { JsonModal } from './JsonModal';
import { cn } from '@/lib/utils';
import { filterLogs, formatDuration, payloadOpenByDefault } from '@/lib/registerLens';
import type { ViewRegister } from '@/lib/registerLens';
import type { WorkflowRun } from '../engine';
import { InfraPanel } from './InfraPanel';
import { fetchInfrastructure, type InfrastructureResponse } from '../store/infraClient';
import { fetchAvailableAgents } from '../store/agentClient';

const statusDot: Record<string, string> = {
  succeeded: 'bg-success',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground',
  running: 'bg-highlight animate-pulse',
};

function runDuration(run: WorkflowRun, register: ViewRegister): string {
  if (!run.completedAt) return '…';
  const ms = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
  return formatDuration(ms, register);
}

function runTime(run: WorkflowRun): string {
  return new Date(run.startedAt).toLocaleTimeString();
}

/** Environment badge + safe-mode shield for a recorded run. Absent on legacy runs. */
function EnvChip({ run }: { run: WorkflowRun }) {
  const environments = useBuilderStore((s) => s.environments);
  if (!run.environment) return null;
  const isProtected = environments.find((e) => e.name === run.environment)?.protected ?? false;
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Badge
        variant="outline"
        className={cn(
          'text-[9px]',
          isProtected && 'border-destructive/50 text-destructive-foreground',
        )}
      >
        {run.environment}
      </Badge>
      {run.safeMode && <ShieldIcon className="size-3 text-success" />}
    </span>
  );
}

/** Shows the viewed run (latest by default) and lets the user step back in history. */
function RunPicker() {
  const flowId = useBuilderStore((s) => s.flow.id);
  const register = useBuilderStore((s) => s.viewRegister);
  const run = useBuilderStore((s) => s.run);
  const runHistory = useBuilderStore((s) => s.runHistory);
  const viewRun = useBuilderStore((s) => s.viewRun);
  const [open, setOpen] = useState(false);

  const runs = runHistory.filter((r) => r.workflowId === flowId);
  if (!run && runs.length === 0) return null;

  const latestId = runs[0]?.id;
  const viewingLive = run !== null && run.id !== undefined && !runs.some((r) => r.id === run.id);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="ml-auto gap-2 font-normal text-muted-foreground hover:text-foreground">
          {run && (
            <>
              <span className={cn('size-1.5 rounded-full', statusDot[run.status])} />
              <span className="font-mono text-[11px]">
                {runTime(run)} · {runDuration(run, register)}
              </span>
              <EnvChip run={run} />
              {(run.id === latestId || viewingLive) && (
                <Badge variant="outline" className="text-[9px]">latest</Badge>
              )}
            </>
          )}
          {!run && <HistoryIcon className="size-3.5" />}
          <ChevronDownIcon className="size-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        <Command>
          <CommandInput placeholder="Search runs…" />
          <CommandList>
            <CommandEmpty>No runs yet.</CommandEmpty>
            <CommandGroup heading={`${runs.length} run${runs.length === 1 ? '' : 's'}`}>
              {runs.map((r, i) => (
                <CommandItem
                  key={r.id}
                  value={`${runTime(r)} ${r.status} ${r.id}`}
                  onSelect={() => {
                    viewRun(r.id);
                    setOpen(false);
                  }}
                >
                  <CheckIcon
                    className={cn('size-3.5', run?.id === r.id ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className={cn('size-1.5 shrink-0 rounded-full', statusDot[r.status])} />
                  <span className="font-mono text-[11px]">{runTime(r)}</span>
                  {r.scenarioName && (
                    <Badge variant="outline" className="max-w-28 truncate text-[9px]">
                      {r.scenarioName}
                    </Badge>
                  )}
                  {r.errorHandler && (
                    <Badge
                      variant="outline"
                      className="max-w-36 truncate border-warn/40 text-[9px] text-warn"
                      title={`Error handler — fired by a failed run of ${r.errorHandler.firedBy}`}
                    >
                      ⚡ handler · {r.errorHandler.firedBy}
                    </Badge>
                  )}
                  {r.mock && (
                    <Badge
                      variant="outline"
                      className="border-warn/40 text-[9px] uppercase text-warn"
                      title="This run executed against scenario mocks — nothing real was touched."
                    >
                      <TheaterIcon className="size-2.5" /> mock
                    </Badge>
                  )}
                  <EnvChip run={r} />
                  <span className="ml-auto flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
                    {runDuration(r, register)}
                    {i === 0 && <span className="text-highlight">latest</span>}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}


function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-1 py-2.5 text-[12.5px] text-muted-foreground/70">{children}</div>;
}

function OutputTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
      {children}
    </div>
  );
}

/** A <Json> pane with a hover-revealed "view fullscreen" button — dock panes
 * run small by design, and that's exactly when a full-size look is wanted. */
function ExpandableJson({ value, onExpand }: { value: unknown; onExpand: () => void }) {
  return (
    <div className="group relative">
      <Json value={value} />
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-1.5 right-1.5 size-6 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        onClick={onExpand}
        aria-label="View full JSON"
      >
        <Maximize2Icon className="size-3.5" />
      </Button>
    </div>
  );
}

/** The input/output pane pair for a node, given a specific input/output/error triple. */
function NodeIoPanes({
  label,
  input,
  output,
  error,
}: {
  label: string;
  input: unknown;
  output: unknown;
  error: string | undefined;
}) {
  const [modal, setModal] = useState<{ title: string; value: unknown } | null>(null);

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3.5">
      <div>
        <OutputTitle>{label} · input</OutputTitle>
        {input !== undefined ? (
          <ExpandableJson value={input} onExpand={() => setModal({ title: `${label} · input`, value: input })} />
        ) : (
          <Empty>No input captured.</Empty>
        )}
      </div>
      <div>
        <OutputTitle>
          {label} · {error ? 'error' : 'output'}
        </OutputTitle>
        {error ? (
          <pre className="overflow-x-auto rounded-md border border-destructive/50 bg-card p-2.5 font-mono text-[11.5px] text-destructive-foreground">
            {error}
          </pre>
        ) : output !== undefined ? (
          <ExpandableJson value={output} onExpand={() => setModal({ title: `${label} · output`, value: output })} />
        ) : (
          <Empty>No output captured.</Empty>
        )}
      </div>
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

const levelColor: Record<string, string> = {
  info: 'text-success',
  debug: 'text-muted-foreground/60',
  warn: 'text-yellow-500',
  error: 'text-destructive',
};

/**
 * One-line recovery hint shown in the Output tab when a finished run's
 * Response came back 401 on an environment with login auth configured —
 * the likeliest cause is an expired stored session. Offers an inline
 * re-login; after success the user still needs to re-run (the shown run
 * already happened), so we say exactly that instead of pretending.
 */
function SessionExpiredHint() {
  const environments = useBuilderStore((s) => s.environments);
  const selectedEnvironment = useBuilderStore((s) => s.selectedEnvironment);
  const loginEnvironment = useBuilderStore((s) => s.loginEnvironment);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const env = environments.find((e) => e.name === selectedEnvironment);
  if (!env?.auth?.configured) return null;

  const onLogin = async () => {
    setError(null);
    setPending(true);
    try {
      await loginEnvironment(env.name);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-1.5 text-[11.5px] text-foreground/80">
      <span className="size-1.5 shrink-0 rounded-full border border-muted-foreground" />
      {done ? (
        <span className="text-success">Logged in — run again to retry.</span>
      ) : (
        <>
          <span>Got a 401 — the stored session may have expired.</span>
          <button
            type="button"
            onClick={() => void onLogin()}
            disabled={pending}
            className="flex items-center gap-1 font-medium text-highlight transition-colors hover:underline disabled:cursor-wait disabled:opacity-60"
          >
            {pending && <Loader2Icon className="size-3 animate-spin" />}
            {pending ? 'Logging in…' : 'Re-log in'}
          </button>
        </>
      )}
      {error && <span className="truncate text-destructive">{error}</span>}
    </div>
  );
}

/** Same disabled-state tooltip as the Welcome checklist's Scout row. */
const NO_AGENT_REASON = 'Detect a coding agent first';

/**
 * Fetch + scout wiring around the presentational InfraPanel. Loads
 * GET /infrastructure when the Infra tab mounts, and re-fetches whenever the
 * active agent run finishes (a completed scout writes the manifest). The scout
 * button shares the Welcome checklist's dispatch (`beginInfrastructureScout`)
 * and its no-agent-CLI gating (fetched once on mount, mirroring WelcomeDialog).
 */
export function InfraTab() {
  const beginInfrastructureScout = useBuilderStore((s) => s.beginInfrastructureScout);
  const agentRun = useBuilderStore((s) => s.agentRun);
  const [data, setData] = useState<InfrastructureResponse | null>(null);
  // Disabled until the fetch resolves — same caution as WelcomeDialog, which
  // shows nothing actionable until /setup-status returns rather than
  // optimistically enabling an action that needs an agent CLI.
  const [hasAgent, setHasAgent] = useState(false);
  const agentRunStatus = agentRun?.status;

  useEffect(() => {
    // Skip refetching mid-run — only the terminal transition matters, and a
    // running scout hasn't written the manifest yet.
    if (agentRunStatus === 'running') return;
    let cancelled = false;
    void fetchInfrastructure().then((d) => {
      if (!cancelled) setData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [agentRunStatus]);

  useEffect(() => {
    let cancelled = false;
    void fetchAvailableAgents().then((agents) => {
      if (!cancelled) setHasAgent(agents.length > 0);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <InfraPanel
      data={data}
      onScout={beginInfrastructureScout}
      scouting={agentRunStatus === 'running'}
      canScout={hasAgent}
      canScoutReason={NO_AGENT_REASON}
    />
  );
}

export function Dock() {
  const rawLogs = useBuilderStore((s) => s.logs);
  const register = useBuilderStore((s) => s.viewRegister);
  const logs = filterLogs(rawLogs, register);
  const openByDefault = payloadOpenByDefault(register);
  const run = useBuilderStore((s) => s.run);
  const flow = useBuilderStore((s) => s.flow);
  const selectedNodeId = useBuilderStore((s) => s.selectedNodeId);
  const tab = useBuilderStore((s) => s.dockTab);
  const setTab = useBuilderStore((s) => s.setDockTab);
  const toggleDock = useBuilderStore((s) => s.toggleDock);
  const { scrollerRef, endRef: logEndRef, detached, jumpToLatest } = useTailAnchor(logs.length);

  const selectedNode = flow.nodes.find((n) => n.id === selectedNodeId);
  const selectedState = selectedNodeId ? run?.nodeStates[selectedNodeId] : undefined;
  // Result nodes (internal flows) AND Response nodes (HTTP operations) — the
  // Output tab shows an operation's resulting JSON, which for an HTTP op is the
  // Response node's { status, body }.
  const resultNodes = flow.nodes.filter((n) => n.type === 'Result' || n.type === 'Response');

  return (
    <section className="flex h-full flex-col border-t border-border bg-background">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as 'logs' | 'output' | 'infra')}
        className="min-h-0 flex-1"
      >
        <TabsList className="shrink-0 pr-1.5">
          <TabsTrigger value="logs">
            Logs
            {logs.length > 0 && (
              <Badge variant="mono" className="text-[9px]">{logs.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="output">Output</TabsTrigger>
          <TabsTrigger value="infra">Infra</TabsTrigger>
          <RunPicker />
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={toggleDock}
            aria-label="Close panel"
            title="Close panel (⌘J)"
          >
            <XIcon className="size-3.5" />
          </Button>
        </TabsList>

        <TabsContent value="logs" className="relative overflow-auto px-3.5 py-2" ref={scrollerRef as unknown as React.Ref<HTMLDivElement>}>
          {detached && (
            <button
              type="button"
              onClick={jumpToLatest}
              className="sticky top-0 left-1/2 z-10 -translate-x-1/2 rounded-full border border-highlight/40 bg-card px-3 py-0.5 text-[10.5px] text-highlight shadow-md hover:bg-secondary"
            >
              ↓ latest
            </button>
          )}
          {logs.length === 0 && <Empty>Run the flow to see logs.</Empty>}
          {logs.map((line, i) => (
            <div key={i} className="flex items-baseline gap-3 py-0.5 font-mono text-[11.5px]">
              <span className="shrink-0 text-muted-foreground/50">{line.timestamp.slice(11, 19)}</span>
              <span
                className={`w-11 shrink-0 text-[10px] uppercase tracking-wider ${levelColor[line.level] ?? ''}`}
              >
                {line.level}
              </span>
              <span className="min-w-32 shrink-0 text-foreground/80">{line.nodeLabel ?? '—'}</span>
              <LogMessage message={line.message} defaultOpen={openByDefault} />
            </div>
          ))}
          <div ref={logEndRef} />
        </TabsContent>

        <TabsContent value="output" className="overflow-auto px-3.5 py-2">
          {selectedNode ? (
            selectedState?.executions && selectedState.executions.length > 1 ? (
              <ExecutionPager executions={selectedState.executions}>
                {(record) => (
                  <NodeIoPanes
                    label={selectedNode.label}
                    input={record.input}
                    output={record.output}
                    error={record.error}
                  />
                )}
              </ExecutionPager>
            ) : (
              <NodeIoPanes
                label={selectedNode.label}
                input={selectedState?.input}
                output={selectedState?.output}
                error={selectedState?.error}
              />
            )
          ) : resultNodes.length > 0 && run ? (
            <>
              {resultNodes.some((n) => {
                const out = run.nodeStates[n.id]?.output as { status?: unknown } | undefined;
                return out?.status === 401;
              }) && <SessionExpiredHint key={run.id} />}
              <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3.5">
              {resultNodes.map((n) => (
                <div key={n.id}>
                  <OutputTitle>{n.label}</OutputTitle>
                  {run.nodeStates[n.id]?.output !== undefined ? (
                    <Json value={run.nodeStates[n.id].output} />
                  ) : (
                    <Empty>No result yet.</Empty>
                  )}
                </div>
              ))}
              </div>
            </>
          ) : (
            <Empty>Run the flow to see output.</Empty>
          )}
        </TabsContent>

        <TabsContent value="infra" className="overflow-auto px-3.5 py-2.5">
          <InfraTab />
        </TabsContent>

      </Tabs>
    </section>
  );
}
