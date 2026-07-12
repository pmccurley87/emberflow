import { useRef, useState } from 'react';
import {
  ChevronDownIcon,
  DownloadIcon,
  FlameIcon,
  PencilIcon,
  EllipsisIcon,
  ListChecksIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  SparklesIcon,
  SquareIcon,
  StepForwardIcon,
  TerminalSquareIcon,
  TriangleAlertIcon,
  UploadIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { diagnoseOperation, type DiagnoseOperationExtras } from '../engine/diagnostics';
import type { NodeRegistry } from '../engine';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useBuilderStore } from '../store/builderStore';
import { EnvironmentPicker, useRunnerPolling } from './EnvironmentPicker';
import { useRunConsole } from './RunLogPanel';
import { SettingsDialog } from './SettingsDialog';
import { WelcomeDialog } from './WelcomeDialog';
import { ScenariosPanel } from './Scenarios';
import type { ScenarioDefinition } from '../engine';

/** Derives diagnoseOperation's `infraNodes` extra from the studio's client-side
 *  node registry (synced from the runner via syncNodeMeta, plus the bundled
 *  built-ins present from module load). A node whose type isn't yet in the
 *  registry is skipped rather than aborting the whole computation — the
 *  degradation is per-node, not all-or-nothing. */
function infraNodesOf(
  flow: { nodes: Array<{ id: string; type: string }> },
  registry: NodeRegistry,
): DiagnoseOperationExtras['infraNodes'] {
  const infraNodes: NonNullable<DiagnoseOperationExtras['infraNodes']> = [];
  for (const node of flow.nodes) {
    if (!registry.has(node.type)) continue;
    const { traceKind } = registry.get(node.type).definition;
    if (traceKind === 'db' || traceKind === 'http' || traceKind === 'llm') {
      infraNodes.push({ id: node.id, traceKind });
    }
  }
  return infraNodes;
}

/** Derives diagnoseOperation's `mutationSourcesByNode` extra from the studio's
 *  client-side node registry, mirroring infraNodesOf's per-node degradation:
 *  a node whose type isn't registered, isn't a mutation, or whose
 *  implementation isn't a function is simply absent from the map rather than
 *  aborting the whole computation. */
function mutationSourcesOf(
  flow: { nodes: Array<{ id: string; type: string }> },
  registry: NodeRegistry,
): DiagnoseOperationExtras['mutationSourcesByNode'] {
  const mutationSourcesByNode: NonNullable<DiagnoseOperationExtras['mutationSourcesByNode']> = {};
  for (const node of flow.nodes) {
    if (!registry.has(node.type)) continue;
    const { definition, implementation } = registry.get(node.type);
    if (definition.effects === 'mutation' && typeof implementation === 'function') {
      mutationSourcesByNode[node.id] = String(implementation);
    }
  }
  return mutationSourcesByNode;
}

const statusDot: Record<string, string> = {
  succeeded: 'bg-success',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground',
  running: 'bg-highlight animate-pulse',
};

/**
 * Run split button: the main segment runs the flow to the end; the attached
 * chevron opens the scenario menu (Patrick's "play button with a dropdown"),
 * replacing the old Scenarios dock tab. Turns destructive-red when a run would
 * execute writes against a protected environment.
 */
function RunSplitButton({
  onRun,
  runDisabled,
  live,
  stepping,
}: {
  onRun: () => void;
  runDisabled: boolean;
  live: boolean;
  stepping: boolean;
}) {
  const flow = useBuilderStore((s) => s.flow);
  const runHistory = useBuilderStore((s) => s.runHistory);
  const runScenario = useBuilderStore((s) => s.runScenario);
  const stepScenario = useBuilderStore((s) => s.stepScenario);
  const runnerMock = useBuilderStore((s) => s.runnerMock);
  const runAgent = useBuilderStore((s) => s.runAgent);
  const agentRunning = useBuilderStore((s) => s.agentRun?.status === 'running');
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState<'manage' | 'new' | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');

  const scenarios = flow.scenarios ?? [];
  const variant = live ? 'destructive' : 'default';
  const paramBlockers = diagnoseOperation(flow, scenarios).filter(
    (d) => d.code === 'missing-param-default',
  );
  const paramsBlocked = paramBlockers.length > 0;
  // The params guard only blocks STARTING a fresh plain run (which sends no
  // request, so path params would be undefined). While stepping, the run is
  // already under way with real input — "Finish" must stay clickable.
  const mainRunDisabled = runDisabled || (paramsBlocked && !stepping);
  const selectedEnvironment = useBuilderStore((s) => s.selectedEnvironment);
  const safeMode = useBuilderStore((s) => s.safeMode);
  // Blocked wins (it says why the button is disabled); otherwise plain-terms
  // explainer of what a real run means.
  const runTitle = paramsBlocked
    ? paramBlockers.map((d) => d.message).join('\n')
    : stepping
      ? 'Runs the stepped run to the end.'
      : runnerMock
        ? 'Runs this operation against scenario mocks — real logic, canned infrastructure. Nothing real is touched.'
        : `Runs this operation for real against "${selectedEnvironment || 'browser'}" — every node executes, and requests hit real services. Safe mode ${safeMode ? 'is on: writes are skipped' : 'is off: writes happen'}.`;

  const lastRunFor = (sc: ScenarioDefinition) =>
    runHistory.find((r) => r.workflowId === flow.id && r.scenarioName === sc.name);

  const play = (id: string) => {
    void runScenario(id);
    setOpen(false);
  };

  const step = (id: string) => {
    void stepScenario(id);
    setOpen(false);
  };

  const submitAiScenario = () => {
    const text = aiInstruction.trim();
    if (!text) return;
    void runAgent({ action: 'new-scenario', flowId: flow.id, instruction: text });
    setAiInstruction('');
    setAiOpen(false);
    setOpen(false);
  };

  const coverWithAi = () => {
    setOpen(false);
    void runAgent({
      action: 'cover-operation',
      flowId: flow.id,
      instruction: 'Cover this operation with a branch-covering scenario suite; every scenario gets an expect.',
    });
  };

  const dropdownTrigger = (
    <Button
      size="sm"
      variant={variant}
      className="gap-1 rounded-l-none border-l border-black/20 px-1.5"
      disabled={runDisabled}
      aria-label="Run a scenario"
    >
      {scenarios.length > 0 && (
        <span className="rounded bg-black/15 px-1 font-mono text-[9px] leading-tight">
          {scenarios.length}
        </span>
      )}
      <ChevronDownIcon className="size-3 opacity-80" />
    </Button>
  );

  return (
    <>
      <div className="flex items-center">
        <Button
          size="sm"
          variant={variant}
          className={cn('rounded-r-none', runnerMock && !live && 'bg-warn/85 text-black hover:bg-warn')}
          onClick={onRun}
          disabled={mainRunDisabled}
          title={runTitle}
        >
          {stepping ? <SquareIcon /> : <PlayIcon />} {stepping ? 'Finish' : 'Run'}
        </Button>
        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) {
              setAiOpen(false);
              setAiInstruction('');
            }
          }}
        >
          <PopoverTrigger asChild>{dropdownTrigger}</PopoverTrigger>
          <PopoverContent className="w-[26rem] max-w-[calc(100vw-2rem)] p-1" align="end">
            {scenarios.length === 0 ? (
              <div className="flex flex-col gap-1.5 px-2.5 py-2">
                <span className="text-[12px] text-muted-foreground/80">
                  No scenarios yet — named inputs (with mocks and expects) to run this flow
                  through. Cover with AI writes a starter suite.
                </span>
                <Button size="sm" variant="secondary" disabled={agentRunning} onClick={coverWithAi}>
                  <SparklesIcon className="size-3.5" />
                  Cover with AI
                </Button>
              </div>
            ) : (
              <div className="flex flex-col">
                {scenarios.map((sc) => {
                  const last = lastRunFor(sc);
                  return (
                    <div key={sc.id} className="group flex items-start rounded-sm transition-colors hover:bg-accent">
                      <button
                        onClick={() => play(sc.id)}
                        title={runnerMock ? 'Runs this scenario against its mocks — nothing real is touched.' : undefined}
                        className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 px-2 py-1.5 text-left"
                      >
                        <PlayIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        <span
                          className={cn(
                            'mt-[7px] size-1.5 shrink-0 rounded-full',
                            last ? statusDot[last.status] : 'bg-border',
                          )}
                          title={last ? `Last run ${last.status}` : 'Not run yet'}
                        />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-[12.5px] font-medium leading-tight">{sc.name}</span>
                          {sc.description && (
                            <span className="text-[11.5px] leading-snug text-muted-foreground">
                              {sc.description}
                            </span>
                          )}
                        </span>
                      </button>
                      <button
                        onClick={() => step(sc.id)}
                        title="Step through this scenario"
                        aria-label={`Step through ${sc.name}`}
                        className="mt-1 mr-1 shrink-0 cursor-pointer rounded-sm p-1.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-secondary hover:text-foreground focus-visible:opacity-100"
                      >
                        <StepForwardIcon className="size-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="my-1 h-px bg-border" />
            {aiOpen ? (
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <Input
                  autoFocus
                  value={aiInstruction}
                  onChange={(e) => setAiInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitAiScenario();
                  }}
                  placeholder="e.g. cover the empty-title case"
                  className="h-8 text-[12.5px]"
                />
                <Button size="sm" onClick={submitAiScenario} disabled={!aiInstruction.trim()}>
                  Go
                </Button>
              </div>
            ) : (
              <button
                onClick={() => setAiOpen(true)}
                disabled={agentRunning}
                className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <SparklesIcon className="size-3.5" />
                New scenario with AI…
              </button>
            )}
            <button
              onClick={() => {
                setManage('manage');
                setOpen(false);
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <PencilIcon className="size-3.5" />
              Manage scenarios…
            </button>
            <button
              onClick={() => {
                setManage('new');
                setOpen(false);
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <PlusIcon className="size-3.5" />
              New scenario…
            </button>
          </PopoverContent>
        </Popover>
      </div>

      <Dialog open={manage !== null} onOpenChange={(o) => !o && setManage(null)}>
        <DialogContent className="max-w-2xl">
          <DialogTitle>Scenarios</DialogTitle>
          <div className="max-h-[65vh] overflow-auto">
            <ScenariosPanel autoNew={manage === 'new'} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}


const severityDot: Record<string, string> = {
  error: 'bg-destructive',
  warning: 'bg-warn',
  info: 'bg-muted-foreground',
};

/**
 * Problems chip: amber triangle + count when the current operation has
 * diagnostics (missing param defaults, uncovered params, no expects). The
 * diagnostic messages themselves are the helper copy — each says what is
 * wrong and what to do about it. Renders nothing when the operation is clean.
 */
function ProblemsChip() {
  const flow = useBuilderStore((s) => s.flow);
  const registry = useBuilderStore((s) => s.registry);
  const seedParamDefault = useBuilderStore((s) => s.seedParamDefault);
  const runAgent = useBuilderStore((s) => s.runAgent);
  const agentRunning = useBuilderStore((s) => s.agentRun?.status === 'running');
  const [open, setOpen] = useState(false);
  const diagnostics = diagnoseOperation(flow, flow.scenarios, {
    infraNodes: infraNodesOf(flow, registry),
    mutationSourcesByNode: mutationSourcesOf(flow, registry),
  });
  if (diagnostics.length === 0) return null;

  const fixWithAi = (action: 'new-scenario' | 'cover-operation', instruction: string) => {
    setOpen(false);
    void runAgent({ action, flowId: flow.id, instruction });
  };

  const rowAction = (d: (typeof diagnostics)[number]) => {
    switch (d.code) {
      case 'missing-param-default':
        return (
          <button
            className="shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Adds an empty placeholder under the Input node's defaults.params — the same fix doctor --fix applies. You can put a real value there later."
            onClick={() => seedParamDefault(d.param!)}
          >
            Seed default
          </button>
        );
      case 'param-no-real-scenario':
        return (
          <button
            className="shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            title="Asks the agent to add a scenario with a real value for this param."
            disabled={agentRunning}
            onClick={() =>
              fixWithAi(
                'new-scenario',
                `Add a scenario that supplies a real value for path param ":${d.param}" (pull a real id from the project's data if you can) and give it an expect.`,
              )
            }
          >
            Fix with AI
          </button>
        );
      case 'no-expects':
        return (
          <button
            className="shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            title="Asks the agent to write a branch-covering scenario suite with expects."
            disabled={agentRunning}
            onClick={() =>
              fixWithAi(
                'cover-operation',
                'Cover this operation with a branch-covering scenario suite; every scenario gets an expect.',
              )
            }
          >
            Fix with AI
          </button>
        );
      case 'missing-node-mock':
        return (
          <button
            className="shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            title="Asks the agent to write mocks for this operation's infrastructure nodes."
            disabled={agentRunning}
            onClick={() =>
              fixWithAi(
                'cover-operation',
                `Add realistic mocks for every infrastructure node in this operation${d.nodeId ? ` (including "${d.nodeId}")` : ''}: give the op-level "mocks" map (and each scenario's) a canned output matching the shape each node's implementation returns, so mock runs execute without touching anything real.`,
              )
            }
          >
            Fix with AI
          </button>
        );
      default:
        return null;
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium text-warn transition-colors hover:bg-warn/10"
          title="This operation has problems — click for details"
          aria-label={`${diagnostics.length} operation problems`}
        >
          <TriangleAlertIcon className="size-3.5" />
          {diagnostics.length}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96 max-w-[calc(100vw-2rem)] p-1" align="end">
        <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Operation problems
        </div>
        <div className="flex flex-col gap-0.5">
          {diagnostics.map((d, i) => (
            <div key={`${d.code}-${d.param ?? i}`} className="flex items-start gap-2 rounded-sm px-2.5 py-1.5">
              <span className={cn('mt-[5px] size-1.5 shrink-0 rounded-full', severityDot[d.severity])} />
              <span className="flex-1 text-[12px] leading-snug text-foreground/90">{d.message}</span>
              {rowAction(d)}
            </div>
          ))}
        </div>
        {diagnostics.length >= 2 && (
          <div className="mt-0.5 border-t border-border/60 px-2.5 pb-1.5 pt-2">
            <button
              className="w-full rounded-sm py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              disabled={agentRunning}
              onClick={() =>
                fixWithAi(
                  'cover-operation',
                  'Run doctor on this operation and resolve every finding: seed or set param defaults, add scenarios with real param values, and give scenarios expects. Verify with test.',
                )
              }
            >
              Fix all with AI
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * VS Code-style layout toggles: show/hide the sidebar, bottom dock and
 * inspector, plus a terminal button that dismisses/reopens the run console —
 * only present while a watched run's console is available.
 */
function LayoutToggles() {
  const dismissRunConsole = useBuilderStore((s) => s.dismissRunConsole);
  const reopenRunConsole = useBuilderStore((s) => s.reopenRunConsole);
  const runConsole = useRunConsole();

  // Panel visibility lives on the panels themselves (each has a close, closed
  // edges grow a reopen tab); only the contextual run-console toggle stays here.
  // The button occupies its slot even when unavailable (invisible) so a run
  // beginning never reflows the toolbar and shoves the Run/Step controls.
  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          'relative size-7',
          !runConsole.available && 'pointer-events-none invisible',
          runConsole.open ? 'bg-secondary/60 text-foreground' : 'text-muted-foreground',
        )}
        onClick={() => (runConsole.open ? dismissRunConsole() : reopenRunConsole())}
        title="Toggle run console"
        aria-label="Toggle run console"
        tabIndex={runConsole.available ? 0 : -1}
      >
        <TerminalSquareIcon />
        {runConsole.running && (
          <span className="absolute right-1 top-1 size-1.5 rounded-full bg-highlight" />
        )}
      </Button>
    </div>
  );
}

export function Toolbar() {
  useRunnerPolling();
  const flowName = useBuilderStore((s) => s.flow.name);
  const run = useBuilderStore((s) => s.run);
  const renameFlow = useBuilderStore((s) => s.renameFlow);
  const runToEnd = useBuilderStore((s) => s.runToEnd);
  const stepRun = useBuilderStore((s) => s.stepRun);
  const stepMode = useBuilderStore((s) => s.stepMode);
  const stepping = stepMode && run?.status === 'running';
  const runnerMock = useBuilderStore((s) => s.runnerMock);
  const saveFlow = useBuilderStore((s) => s.saveFlow);
  const exportFlow = useBuilderStore((s) => s.exportFlow);
  const importFlow = useBuilderStore((s) => s.importFlow);
  const executionMode = useBuilderStore((s) => s.executionMode);
  const runnerOnline = useBuilderStore((s) => s.runnerOnline);
  const environments = useBuilderStore((s) => s.environments);
  const selectedEnvironment = useBuilderStore((s) => s.selectedEnvironment);
  const safeMode = useBuilderStore((s) => s.safeMode);
  const agentPanelOpen = useBuilderStore((s) => s.agentPanelOpen);
  const toggleAgentPanel = useBuilderStore((s) => s.toggleAgentPanel);
  const setWelcomeOpen = useBuilderStore((s) => s.setWelcomeOpen);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  // Only a manual server override with the runner down blocks running;
  // auto mode always has the browser fallback.
  const runDisabled = busy || (executionMode === 'server' && runnerOnline === false);
  const currentEnv = environments.find((e) => e.name === selectedEnvironment);
  const live = (currentEnv?.protected ?? false) && !safeMode;

  const guard = (work: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  const handleExport = () => {
    const blob = new Blob([exportFlow()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${flowName || 'flow'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      importFlow(await file.text());
    } catch (err) {
      console.error('Import failed', err);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <header className="flex h-12 items-center gap-3 border-b border-border bg-background px-3">
      <span className="flex items-center gap-1.5 pl-1 text-[13px] font-semibold tracking-tight">
        <FlameIcon className="size-4 text-highlight" /> emberflow
      </span>
      <input
        className="h-8 min-w-44 rounded-md border border-transparent bg-transparent px-2.5 text-[13px] text-muted-foreground outline-none transition-colors hover:border-border focus:border-ring focus:text-foreground focus-visible:ring-ring/50 focus-visible:ring-[3px]"
        value={flowName}
        onChange={(e) => renameFlow(e.target.value)}
        aria-label="Flow name"
        spellCheck={false}
      />
      <div className="ml-auto flex items-center gap-2">
        <ProblemsChip />
        <EnvironmentPicker />
        <div className="h-5 w-px bg-border" />
        {/* A stepped run in flight keeps the SAME two controls in the SAME
            slots so nothing shifts under a repeated click: the split button's
            main action turns into "Finish" (run to end), and Step becomes the
            highlighted "Step over" primary. */}
        <RunSplitButton
          onRun={guard(runToEnd)}
          runDisabled={runDisabled}
          live={live}
          stepping={stepping}
        />
        <Button
          variant={stepping ? 'default' : 'secondary'}
          size="sm"
          onClick={guard(stepRun)}
          disabled={runDisabled}
          title={
            stepping
              ? 'Runs the next node, then pauses again.'
              : runnerMock
                ? 'Runs one node at a time against scenario mocks — real logic, canned infrastructure, paused between nodes.'
                : `Runs one node at a time against "${selectedEnvironment || 'browser'}" — same real execution, paused between nodes.`
          }
        >
          {stepping ? <PlayIcon /> : <StepForwardIcon />}
          {stepping ? 'Step over' : 'Step'}
        </Button>
        <div className="h-5 w-px bg-border" />
        <Popover open={moreOpen} onOpenChange={setMoreOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More actions" className="text-muted-foreground hover:text-foreground">
              <EllipsisIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-44 p-1" align="end">
            {[
              { icon: <SaveIcon className="size-3.5" />, label: 'Save', action: () => saveFlow() },
              { icon: <DownloadIcon className="size-3.5" />, label: 'Export', action: handleExport },
              { icon: <UploadIcon className="size-3.5" />, label: 'Import', action: () => fileRef.current?.click() },
            ].map(({ icon, label, action }) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  action();
                  setMoreOpen(false);
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-[12.5px] text-foreground transition-colors hover:bg-accent"
              >
                <span className="text-muted-foreground">{icon}</span>
                {label}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => handleImportFile(e.target.files?.[0])}
        />
        <div className="h-5 w-px bg-border" />
        <LayoutToggles />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setWelcomeOpen(true)}
          aria-label="Setup checklist"
          title="Setup — first-run checklist for this project"
          className="text-muted-foreground hover:text-foreground"
        >
          <ListChecksIcon />
        </Button>
        <WelcomeDialog />
        <SettingsDialog />
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleAgentPanel}
          aria-pressed={agentPanelOpen}
          aria-label="Toggle agent panel"
          title="Agent — chat to change this operation, watch it update live"
          className={cn(
            agentPanelOpen
              ? 'bg-secondary text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <SparklesIcon />
        </Button>
      </div>
    </header>
  );
}
