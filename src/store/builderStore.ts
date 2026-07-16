import { create } from 'zustand';
import { InMemoryTraceSink } from '../engine/trace';
import { NodeRegistry } from '../engine/registry';
import type { FlowRun } from '../engine/executor';
import type {
  FieldMapping, LogLine, ScenarioDefinition,
  WorkflowDefinition, WorkflowNode, WorkflowRun,
} from '../engine/types';
import { loadWorkspace, parseFlow, saveWorkspace, serializeFlow } from './persistence';
import { fetchNodeMeta } from './nodeMeta';
import {
  cancelServerRun,
  createOperationOnServer,
  deleteWorkflowOnServer,
  fetchWorkflows,
  deleteEnvironmentSecret as deleteEnvironmentSecretOnServer,
  listEnvironments,
  loginEnvironment as loginEnvironmentOnServer,
  putWorkflow,
  runnerHealthy,
  runNodeOnServer,
  setEnvironmentAuth as setEnvironmentAuthOnServer,
  setEnvironmentSecret as setEnvironmentSecretOnServer,
  setServingMode as setServingModeOnServer,
  startServerRun,
  stepServerRun,
  subscribeServerRun,
  testWorkflow as testWorkflowOnServer,
} from './serverRunner';
import type {
  EnvAuth, ErrorHandlerTag, EnvironmentSummary, ScenarioTestReport, ServerRunOptions, StepResult,
} from './serverRunner';
import { cancelAgent, fetchAgentDiff, revertAgent, startAgent, streamAgent } from './agentClient';
import type { AgentEvent, AgentIntent, AgentKind, StartAgentOptions } from './agentClient';
import { fetchSetupStatus } from './setupClient';
import type { SetupStatus } from './setupClient';
import { extractGuidedQuestions } from '../lib/guidedQuestions';

export interface WorkflowSummary {
  id: string;
  name: string;
  folder?: string;
  /** On-disk relative path (from the runner's ApiStore), when known. */
  path?: string;
  /** HTTP trigger method/path, when this operation is routed. */
  http?: { method: string; path: string };
}

/** Configures the two entry points that share the create modal: "New API"
 *  (name + first operation) and "New operation" (optionally scoped to an API
 *  via `location`). Owned here so any surface — Sidebar, canvas empty state —
 *  opens the SAME modal (hosted once by CreateModalHost). */
export type CreateModalState =
  | { mode: 'api'; initialGoal?: string }
  | { mode: 'operation'; location?: string };

/** Per-operation path/http metadata, keyed by id — sourced from the runner's
 *  `/workflows` `operations` array (the store's `WorkflowDefinition`s don't
 *  carry `path`, since path is a filesystem concept, not a flow field). */
export type OpMeta = Map<string, { path: string; http?: { method: string; path: string } }>;

/** Drop one flow's scenario-test report (no-op when absent) — scenario edits
 *  make the last report stale. */
function dropReport(
  reports: Record<string, ScenarioTestReport>,
  flowId: string,
): Record<string, ScenarioTestReport> {
  if (!(flowId in reports)) return reports;
  const { [flowId]: _stale, ...rest } = reports;
  return rest;
}


/**
 * One level of the stepped-run drill stack: entered when a step response
 * reports `entered` (execution moved inside a Subflow node), popped on
 * `exited`. The parent's flow/run/selection are stashed here so the canvas
 * can show the child while the parent keeps receiving its own SSE states
 * (routed into `savedRun` by workflowId), and be restored intact on exit.
 */
export interface StepDrillEntry {
  /** The child flow's id (the level the drill entered INTO). */
  workflowId: string;
  /** The PARENT's Subflow node id that execution entered through. */
  viaNodeId: string;
  /** The parent level's flow, restored on exit. */
  savedFlow: WorkflowDefinition;
  /** The parent level's run — still updated by routed nodeState events while drilled. */
  savedRun: WorkflowRun | null;
  savedSelectedNodeId: string | null;
  /** True when the child flow wasn't found in the workspace: the view stayed
   *  on the parent, but the level is still pushed so the client stack depth
   *  mirrors the server's and the matching `exited` pops correctly. Popping a
   *  placeholder leaves flow/run/selection untouched (they never changed). */
  placeholder?: true;
}

/** A finished run plus builder-side context the engine doesn't track. */
export type RunHistoryEntry = WorkflowRun & {
  scenarioName?: string;
  /** Present only when this run was fired by an error-handler op. */
  errorHandler?: ErrorHandlerTag;
  /** True when the run executed against scenario mocks (Mock mode) — a mocked
   *  run must never be mistaken for a real one in history. */
  mock?: boolean;
};

interface BuilderState {
  flow: WorkflowDefinition;
  /** Flows other than the active one. */
  shelf: WorkflowDefinition[];
  /** id/name of every workflow, active first. */
  workflows: WorkflowSummary[];
  createWorkflow(): void;
  switchWorkflow(id: string): void;
  moveWorkflowToFolder(id: string, folder: string | null): void;
  /** id -> path/http metadata sourced from the runner's `/workflows` `operations` array. */
  opMeta: OpMeta;
  /**
   * Create a new operation (a routed or internal flow) at `${api}/${folder ?
   * folder + '/' : ''}${slug(name)}`, save it to the runner at that exact
   * path (new nested ops can't rely on PUT's existing-path lookup), refresh
   * from the runner, and select it. The runner refuses to overwrite an
   * existing operation at that path (409) — that failure is surfaced in the
   * returned result rather than silently swallowed, and the workspace is not
   * refreshed/switched on failure.
   */
  createOperation(input: {
    api: string;
    folder?: string;
    name: string;
    method?: string;
    httpPath?: string;
  }): Promise<{ ok: boolean; error?: string }>;
  /**
   * Delete one or more operations by flow id (an API delete passes every op id
   * under it). Removes each on the runner, then re-syncs — if the open flow was
   * among them, syncFromRunner falls back to another flow automatically.
   */
  deleteOperations(ids: string[]): Promise<{ ok: boolean; error?: string }>;
  registry: NodeRegistry;
  trace: InMemoryTraceSink;
  run: WorkflowRun | null;
  logs: LogLine[];
  selectedNodeId: string | null;
  activeRun: FlowRun | null;
  dockTab: 'logs' | 'output' | 'infra';
  setDockTab(tab: 'logs' | 'output' | 'infra'): void;
  /** null = not yet checked. Runs are always server-side; when the runner is
   *  offline the studio surfaces a calm offline state instead of executing. */
  runnerOnline: boolean | null;
  /** True when the reachable runner is serving EMBERFLOW_MOCK responses
   *  (from /healthz's `mock` field) rather than live execution. False when
   *  offline or not mocked. */
  runnerMock: boolean;
  /** Flip the runner's serving mode (mock answers from scenario expects; real
   *  executes). Re-checks the runner so `runnerMock` reflects the live state. */
  setServingMode(mode: 'real' | 'mock'): Promise<void>;
  checkRunner(): Promise<void>;
  /** Fetch consumer-node metadata from the runner and merge definition-only entries into the registry. */
  syncNodeMeta(): Promise<void>;

  /** Runner environments (key names only; empty when the runner is offline). */
  environments: EnvironmentSummary[];
  /** The runner's default environment name. */
  environmentsDefault: string;
  /** The environment the next run points at (persisted). */
  selectedEnvironment: string;
  /** When on, mutation nodes dry-run their writes (persisted). */
  safeMode: boolean;
  /** Refresh environments from the runner; clears the list when offline. */
  fetchEnvironments(): Promise<void>;
  /** Select an environment; protected environments force safe mode on. */
  selectEnvironment(name: string): void;
  /**
   * Fire the environment's configured login request, then re-fetch
   * environments so `environments[].auth.authenticated` reflects the
   * runner's freshly-persisted credential. Rethrows on failure.
   */
  loginEnvironment(name: string): Promise<void>;
  /**
   * Set a secret's value on an environment, then re-fetch environments so
   * `environments[].secretKeys` reflects the runner's freshly-persisted key.
   * The value transits studio→runner only over this call.
   */
  setEnvironmentSecret(name: string, key: string, value: string): Promise<void>;
  /** Delete a secret from an environment, then re-fetch environments. */
  deleteEnvironmentSecret(name: string, key: string): Promise<void>;
  /**
   * Set (or, with `null`, clear) an environment's login-auth config, then
   * re-fetch environments so `environments[].auth` reflects the change.
   */
  setEnvironmentAuth(name: string, auth: EnvAuth | null): Promise<void>;
  /**
   * Toggle safe mode. Turning it OFF on a protected environment requires
   * `confirmName` to equal the selected environment; otherwise it is a no-op
   * and returns false (the UI drives the typed-confirm dialog).
   */
  setSafeMode(on: boolean, confirmName?: string): boolean;
  /** Whether the workspace mirrors the runner's files or local storage. */
  workspaceSource: 'local' | 'server';
  /** Adopt the runner's workflow set as the workspace (one-shot on adoption). */
  syncFromRunner(): Promise<void>;
  /** Live server-side run id, when executing in server mode. */
  activeServerRunId: string | null;
  /** True while a stepped run is in progress (started via Step, not Run) — drives
   * the toolbar's step-over affordance. Cleared when the run finishes or resets. */
  stepMode: boolean;
  /** Stepped-run subflow drill stack, deepest last. Non-empty while execution
   *  is inside one (or more, when nested) Subflow nodes and the canvas shows
   *  the drilled child. Empty otherwise. */
  stepDrill: StepDrillEntry[];
  /** View-only peek back up the drill stack: an index into `stepDrill` shows
   *  that ancestor level's stashed flow/run in the runbook WITHOUT popping the
   *  stack or touching the server; null shows the deepest (live) level.
   *  Reset to null whenever execution enters or exits a subflow. */
  drillPeek: number | null;
  /** Peek at ancestor level `index` of the drill stack (null = back to the
   *  deepest level). Out-of-range indexes clear the peek. */
  peekDrill(index: number | null): void;
  sidebarOpen: boolean;
  toggleSidebar(): void;
  /** Whether the bottom dock panel is mounted (persisted). */
  dockOpen: boolean;
  toggleDock(): void;
  /** Whether the right-hand inspector panel is mounted (persisted). */
  inspectorOpen: boolean;
  toggleInspector(): void;
  /** Whether the Agent panel is open — a persistent surface for chatting with
   *  the agent about the open operation (starting a run auto-opens it). */
  agentPanelOpen: boolean;
  toggleAgentPanel(): void;
  /** True while the agent panel is in environment-setup mode: its chat input
   *  dispatches setup-environments instead of edit-flow. Entered from the
   *  Environments dialog's call-to-action; cleared when the panel closes. */
  agentEnvSetup: boolean;
  beginEnvironmentSetup(): void;
  /** Dispatch the infrastructure scout (scout-infrastructure intent): reads the
   *  project's deps/config/ORM/env-refs and writes emberflow/infrastructure.json.
   *  Shared by the Welcome checklist and the Dock's Infra tab empty state. An
   *  optional free-text `instruction` (from the Infrastructure modal's "Update
   *  with AI") amends the manifest; empty/omitted runs a full rescan. */
  beginInfrastructureScout(instruction?: string): void;
  /** Whether the first-run Welcome/Setup checklist dialog is open. Auto-opened
   *  on a fresh project (see WelcomeDialog); always reachable from the Toolbar. */
  welcomeOpen: boolean;
  setWelcomeOpen(open: boolean): void;
  /** The New API / New operation modal's open state. Lifted to the store so
   *  surfaces outside the Sidebar (e.g. the canvas empty state) share the ONE
   *  modal instead of duplicating it; null = closed. Hosted by CreateModalHost. */
  createModal: CreateModalState | null;
  setCreateModal(state: CreateModalState | null): void;
  /** Whether the Settings dialog is open. Lifted to the store so the Welcome
   *  checklist's "coding agent" row can deep-link into it. */
  settingsOpen: boolean;
  setSettingsOpen(open: boolean): void;
  /** True while Settings was deep-linked from the Welcome checklist — the
   *  dialog then shows a back arrow that returns to the checklist. Cleared on
   *  any close so a later toolbar-opened Settings doesn't inherit it. */
  settingsFromWelcome: boolean;
  openSettingsFromWelcome(): void;
  /** Latest /setup-status snapshot. WelcomeDialog refreshes it on mount and on
   *  open; shared here so the StatusBar's setup-progress chip stays in sync. */
  setupStatus: SetupStatus | null;
  refreshSetupStatus(): Promise<SetupStatus | null>;
  /** Open the agent panel (no toggle). */
  openAgentPanel(): void;
  /** Where the run console docks (persisted). Default 'right'. */
  /** null = no explicit choice — the register decides (technical → bottom, simple → right). */
  consolePosition: 'right' | 'bottom' | null;
  setConsolePosition(position: 'right' | 'bottom'): void;
  /**
   * Which register the runbook document speaks: 'simple' shows outcomes,
   * 'technical' reveals trace kinds, type names and the technical outcome line.
   * Persisted; default simple.
   */
  viewRegister: 'simple' | 'technical';
  setViewRegister(register: 'simple' | 'technical'): void;
  /**
   * Run whose console the user dismissed. The console is available whenever a
   * watched run exists; dismissing hides it, reopening (or a new run) shows it.
   */
  runConsoleDismissedId: string | null;
  dismissRunConsole(): void;
  reopenRunConsole(): void;
  /**
   * Run ids the user has explicitly opened the console for. In the simple
   * register, starting a run does not summon the console — only an explicit
   * toolbar open does, tracked here so that run's console then behaves like
   * the technical register's for its remaining lifetime. Session-only, not
   * persisted; the technical register ignores this set entirely (always open).
   */
  runConsoleOpenedIds: Set<string>;
  /** Finished runs, newest first, across all workflows (session-scoped). */
  runHistory: RunHistoryEntry[];
  /** Log lines captured for each finished run. */
  logsByRun: Record<string, LogLine[]>;
  recordRun(run: WorkflowRun, errorHandler?: ErrorHandlerTag): void;
  /** Scenario that started the live run (tags its history entry). */
  activeScenarioId: string | null;
  /** Run the flow to the end with a named scenario's input as the run payload. */
  runScenario(scenarioId: string): Promise<void>;
  /** Start a stepped run with a scenario's input: first node executes, Step continues. */
  stepScenario(scenarioId: string): Promise<void>;
  /**
   * Latest scenario-suite test report per flow id, from POST
   * /workflows/:id/test (server/testRunner.ts — no expectation logic is
   * duplicated studio-side). Studio test runs never enter runHistory: they
   * don't go through recordRun/SSE.
   */
  scenarioTestReports: Record<string, ScenarioTestReport>;
  /** Flow id currently awaiting its test report, or null when idle. */
  scenarioTestPending: string | null;
  /** Run flowId's scenario suite on the runner and store the report. */
  testWorkflow(flowId: string, environment?: string): Promise<void>;
  addScenario(
    name: string,
    input: Record<string, unknown>,
    description?: string,
    expect?: ScenarioDefinition['expect'],
  ): void;
  updateScenario(id: string, patch: Partial<Omit<ScenarioDefinition, 'id'>>): void;
  removeScenario(id: string): void;
  /** Whether the currently-active run executes against mocks — stamped at run
   *  start, copied onto its history entry when it finishes. */
  activeRunMock: boolean;
  /** Load a past run's snapshot (statuses + logs) into the view. */
  viewRun(runId: string): void;

  /**
   * A studio-triggered coding-agent run (new-scenario/edit-node/edit-flow),
   * streamed live from the server's /agent endpoints. null when no agent run
   * has been started this session (or after it's been dismissed).
   */
  agentRun: {
    id: string;
    events: AgentEvent[];
    status: 'running' | 'done' | 'error';
    /** The instruction the user sent — shown as the first (user) message in the panel. */
    instruction?: string;
    diff?: string;
    files?: string[];
    /** True when this run is a `guided-setup` run OWNED by the WelcomeDialog's
     *  two-pane phase machine. It suppresses the right-hand AgentConsole
     *  auto-open (the dialog embeds the stream itself) and, since the run lives
     *  in this single slot, lets the dialog re-attach after being closed
     *  mid-run — the phase derives from this flag + `status`. */
    guided?: boolean;
  } | null;
  /** Prior guided-setup conversation (finished runs' events + the user's
   *  answers), preserved across continuation runs — each continuation REPLACES
   *  the agentRun slot, so without this the onboarding pane would wipe to
   *  "Thinking…" on every answer. Cleared on a fresh (no-notes) start. */
  guidedTranscript: AgentEvent[];
  /** Persisted agent+model picked in Settings; used as runAgent's default opts. */
  agentChoice: AgentChoice;
  setAgentChoice(choice: AgentChoice): void;
  /** Start a coding-agent run and stream its events into `agentRun`. */
  runAgent(intent: AgentIntent, opts?: StartAgentOptions): Promise<void>;
  /** Kick off (or continue) the WelcomeDialog's guided-setup run: one agent run
   *  that reads state, scouts/skips, installs skills, and interviews about
   *  environments. Marks the run `guided` so the dialog owns its stream and the
   *  right-hand console stays closed. */
  beginGuidedSetup(instruction?: string): void;
  /** Discard a FINISHED guided run + transcript so the welcome dialog returns
   *  to its idle intro (Start setup) instead of auto-resuming an old stream.
   *  No-op while a guided run is live. */
  resetGuidedSetup(): void;
  /**
   * The operation currently being scaffolded by the create flow. Its stub is
   * already selected; the canvas shows a "waiting for the agent" holding pattern
   * until the agent finishes writing it. Cleared when the agent run completes.
   */
  buildingOperationId: string | null;
  /**
   * Create a stub operation (name + HTTP route) at `location`, select it so the
   * canvas shows the shell immediately, then kick an `edit-flow` agent run to
   * build out its logic. Powers the New API / New operation modal — the user
   * sees what they're building before the agent fills it in.
   */
  createAndBuild(input: {
    location: string;
    name: string;
    method: string;
    httpPath: string;
    goal: string;
  }): Promise<{ ok: boolean; error?: string }>;
  /** Revert the agent run's file changes, then reload flows from the runner. */
  revertAgentRun(): Promise<void>;
  /** Hide the agent console without affecting the underlying run. */
  dismissAgentRun(): void;

  addNode(type: string, position: { x: number; y: number }): void;
  moveNode(id: string, position: { x: number; y: number }): void;
  /** Persist a display node's canvas size (metadata.size). */
  resizeNode(id: string, size: { width: number; height: number }): void;
  removeNode(id: string): void;
  removeEdge(id: string): void;
  connect(source: string, target: string, targetHandle?: string, sourceHandle?: string): void;
  selectNode(id: string | null): void;
  renameFlow(name: string): void;
  /** Replace (or clear) the active flow's `http` trigger — Inspector's HTTP
   *  section is the only writer; pass undefined to demote the flow back to
   *  an internal sub-flow. */
  setFlowHttp(http: WorkflowDefinition['http']): void;
  renameNode(id: string, label: string): void;
  updateNodeConfig(id: string, key: string, value: unknown): void;
  /** Set (or clear with undefined) a node's retry policy — engine retries the
   *  implementation call maxTries total times with waitMs between attempts. */
  setNodeRetry(id: string, retry: WorkflowNode['retry']): void;
  /** Seed an empty ("") default for `param` under the first Input node's
   *  `config.defaults.params`, creating nested objects immutably as needed,
   *  then saves — the same fix `doctor --fix` applies. Never overwrites an
   *  existing value; no-op if the flow has no Input node. */
  seedParamDefault(param: string): void;
  setInputMapping(nodeId: string, field: string, mapping: FieldMapping | null): void;
  pinNodeOutput(nodeId: string, output: unknown): void;
  unpinNode(nodeId: string): void;
  /**
   * Execute one node in isolation against the given input on the runner (POST
   * /node-run), capturing logs and recording a local trace sample. Does not
   * touch run state. Requires the runner to be online.
   */
  runNodeIsolated(
    nodeId: string,
    input: Record<string, unknown>,
  ): Promise<{ output?: unknown; error?: string; logs: LogLine[] }>;

  stepRun(): Promise<void>;
  runToEnd(): Promise<void>;
  resetRun(): void;

  saveFlow(): void;
  loadFlow(): void;
  exportFlow(): string;
  importFlow(json: string): void;
}

// The studio registry is definitions-only: it carries node metadata (labels,
// schemas, categories) synced from the runner via syncNodeMeta, never the node
// implementations. All execution happens on the runner — the studio is a pure
// client. syncNodeMeta populates this from GET /api/nodes.
const registry = new NodeRegistry();

function touched(flow: WorkflowDefinition): WorkflowDefinition {
  return { ...flow, updatedAt: new Date().toISOString() };
}

function summaries(
  active: WorkflowDefinition,
  shelf: WorkflowDefinition[],
  opMeta: OpMeta = new Map(),
): WorkflowSummary[] {
  return [active, ...shelf].map((f) => {
    const meta = opMeta.get(f.id);
    return {
      id: f.id,
      name: f.name,
      folder: f.folder,
      ...(meta ? { path: meta.path, http: meta.http } : {}),
    };
  });
}

/** slug: lowercase, spaces -> '-', strip anything not URL-safe (alnum/hyphen). */
function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/** Derive nodeId -> pinned output from a flow's node metadata. */
export function pinsOf(flow: WorkflowDefinition): Record<string, unknown> {
  const pins: Record<string, unknown> = {};
  for (const n of flow.nodes) {
    if (n.metadata && 'pinnedOutput' in n.metadata) pins[n.id] = n.metadata.pinnedOutput;
  }
  return pins;
}

function emptyFlow(): WorkflowDefinition {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: 'Untitled Flow',
    version: 1,
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
  };
}

// The workspace comes from the runner (adopted on first health check via
// syncFromRunner). At boot we hydrate only from any locally-persisted workspace;
// with none, we open an empty flow. No example flows are seeded client-side —
// the studio bundles no node implementations, so it can't execute them anyway.
const workspace = loadWorkspace();
const savedFlows = workspace?.flows ?? [];
const initialFlow =
  savedFlows.find((f) => f.id === workspace?.activeId) ?? savedFlows[0] ?? emptyFlow();
const initialShelf = savedFlows.filter((f) => f.id !== initialFlow.id);

const ENV_KEY = 'emberflow.environment';
const SAFE_KEY = 'emberflow.safeMode';
const SIDEBAR_KEY = 'emberflow.panel.sidebar';
const DOCK_KEY = 'emberflow.panel.dock';
const INSPECTOR_KEY = 'emberflow.panel.inspector';
const REGISTER_KEY = 'emberflow.view.register';
const CONSOLE_POSITION_KEY = 'emberflow.console.position';
const AGENT_CHOICE_KEY = 'emberflow.agentChoice';

function persistEnvironment(name: string): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(ENV_KEY, name);
}
function persistSafeMode(on: boolean): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(SAFE_KEY, on ? '1' : '0');
}
/** Panels default open: only an explicit stored '0' hides them. */
function loadPanel(key: string): boolean {
  return typeof localStorage !== 'undefined' ? localStorage.getItem(key) !== '0' : true;
}
function persistPanel(key: string, open: boolean): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, open ? '1' : '0');
}
const initialSelectedEnvironment =
  typeof localStorage !== 'undefined' ? localStorage.getItem(ENV_KEY) ?? '' : '';
// Simple register by default: only an explicit stored 'technical' opts in.
// Legacy stored value 'business' (pre-rename) normalizes to 'simple'.
const initialViewRegister: 'simple' | 'technical' =
  typeof localStorage !== 'undefined' && localStorage.getItem(REGISTER_KEY) === 'technical'
    ? 'technical'
    : 'simple';
// null = user never chose; the effective position follows the register
// (technical reads best as a bottom log; simple as a right column).
const storedConsolePosition = typeof localStorage !== 'undefined' ? localStorage.getItem(CONSOLE_POSITION_KEY) : null;
const initialConsolePosition: 'right' | 'bottom' | null =
  storedConsolePosition === 'bottom' || storedConsolePosition === 'right' ? storedConsolePosition : null;

/** The position the console actually renders at, honoring an explicit choice first. */
export function effectiveConsolePosition(
  position: 'right' | 'bottom' | null,
  register: 'simple' | 'technical',
): 'right' | 'bottom' {
  return position ?? (register === 'technical' ? 'bottom' : 'right');
}
// Safe by default: only an explicit stored '0' opts out.
const initialSafeMode =
  typeof localStorage !== 'undefined' ? localStorage.getItem(SAFE_KEY) !== '0' : true;

export interface AgentChoice {
  agent?: AgentKind;
  model?: string;
  reasoning?: 'low' | 'medium' | 'high';
}

function persistAgentChoice(choice: AgentChoice): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(AGENT_CHOICE_KEY, JSON.stringify(choice));
}
function loadAgentChoice(): AgentChoice {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(AGENT_CHOICE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as AgentChoice;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
const initialAgentChoice = loadAgentChoice();
// One-shot: apply the active flow's preferred environment the first time the
// runner's environment list arrives (the flow opened before it was available).
let flowEnvSynced = false;
// While stepping, selection follows the step cursor so the Inspector shows the
// node that just executed. Cleared by run-to-end/scenario runs.
let stepFollow = false;

export const useBuilderStore = create<BuilderState>((set, get) => {
  /** Whether the selected environment is protected (writes are expensive there). */
  const selectedEnvProtected = (): boolean => {
    const s = get();
    return s.environments.find((e) => e.name === s.selectedEnvironment)?.protected ?? false;
  };

  /** Env/safety options for a server run, adding the confirm token when unsafe-on-protected. */
  const serverRunOptions = (): ServerRunOptions => {
    const s = get();
    const needsConfirm = selectedEnvProtected() && !s.safeMode;
    return {
      ...(s.selectedEnvironment ? { environment: s.selectedEnvironment } : {}),
      safeMode: s.safeMode,
      ...(needsConfirm ? { confirm: s.selectedEnvironment } : {}),
    };
  };

  /** One consciously-unsafe run at a time: revert to safe after it finishes. */
  const revertUnsafeAfterRun = (): void => {
    if (selectedEnvProtected() && !get().safeMode) {
      set({ safeMode: true });
      persistSafeMode(true);
    }
  };

  /**
   * Auto-select the current flow's preferred environment when the runner
   * offers one, so a prod-targeting flow doesn't silently run against local.
   * Applied on explicit flow open and once when environments first load; not on
   * every runner poll, so a manual override mid-session isn't fought.
   */
  const applyFlowEnvironment = (): void => {
    const s = get();
    const preferred = s.flow.environment;
    if (!preferred || preferred === s.selectedEnvironment) return;
    if (!s.environments.some((e) => e.name === preferred)) return;
    get().selectEnvironment(preferred);
  };

  const reportRunError = (message: string): void => {
    set((s) => ({
      logs: [
        ...s.logs,
        { timestamp: new Date().toISOString(), level: 'error', runId: 'runner', message },
      ],
    }));
  };

  /**
   * Execution stepped INTO a Subflow node: stash the current level and show
   * the child flow with a fresh synthetic run (status running, no node states
   * yet — the child's first node executes on the NEXT step and lights up as
   * its SSE states arrive). Logs are the root run's and keep streaming; the
   * server run id and step mode are untouched. If the child flow isn't in the
   * workspace (shouldn't happen for project flows), stay on the parent but
   * push a placeholder level so stack depths stay aligned with the server.
   */
  const enterDrill = (entered: { workflowId: string; nodeId: string }): void => {
    const s = get();
    const child = s.shelf.find((f) => f.id === entered.workflowId);
    if (!child || child.id === s.flow.id) {
      // Unknown child — keep stepping the parent view rather than crash, but
      // still push a PLACEHOLDER level: the server's drill stack grew, and
      // the client's must stay depth-aligned so the matching `exited` pops
      // the right level (and deeper enters keep routing correctly).
      hydrating(() =>
        set({
          stepDrill: [
            ...s.stepDrill,
            {
              workflowId: entered.workflowId,
              viaNodeId: entered.nodeId,
              savedFlow: s.flow,
              savedRun: s.run,
              savedSelectedNodeId: s.selectedNodeId,
              placeholder: true,
            },
          ],
          drillPeek: null,
        }),
      );
      return;
    }
    const runId = s.activeServerRunId ?? s.run?.id;
    if (!runId) return;
    // Same id as the root run: child states stream on the root run's SSE, and
    // the visible-run guard in onNodeState keys off this id.
    const childRun: WorkflowRun = {
      id: runId,
      workflowId: child.id,
      status: 'running',
      startedAt: new Date().toISOString(),
      nodeStates: {},
    };
    // hydrating: a drill swap is a view change, not an edit — it must not
    // trigger the autosave that a `flow` reference change normally implies.
    hydrating(() =>
      set({
        stepDrill: [
          ...s.stepDrill,
          {
            workflowId: child.id,
            viaNodeId: entered.nodeId,
            savedFlow: s.flow,
            savedRun: s.run,
            savedSelectedNodeId: s.selectedNodeId,
          },
        ],
        drillPeek: null,
        flow: child,
        run: childRun,
        selectedNodeId: null,
      }),
    );
  };

  /** The drilled child completed: pop one level and restore the parent's
   *  flow/run/selection (its run kept receiving its own routed SSE states —
   *  including the Subflow node's terminal state — while we were inside). */
  const exitDrill = (): void => {
    const s = get();
    const entry = s.stepDrill[s.stepDrill.length - 1];
    if (!entry) return;
    if (entry.placeholder) {
      // The view never left the parent for this level — just drop it. The
      // live flow/run kept receiving the parent's states while "inside".
      hydrating(() => set({ stepDrill: s.stepDrill.slice(0, -1), drillPeek: null }));
      return;
    }
    hydrating(() =>
      set({
        stepDrill: s.stepDrill.slice(0, -1),
        drillPeek: null,
        flow: entry.savedFlow,
        run: entry.savedRun,
        selectedNodeId: entry.savedSelectedNodeId,
      }),
    );
  };

  /** Unwind the whole drill stack back to the root level (run finish/reset/
   *  flow switch): restore the root's flow/run/selection and drop the stack. */
  const drainDrill = (): void => {
    const s = get();
    if (s.stepDrill.length === 0) {
      if (s.drillPeek !== null) set({ drillPeek: null });
      return;
    }
    // All-placeholder stack: the view never left the root, and the live run
    // (not the stashes) kept receiving its states — just drop the levels.
    if (s.stepDrill.every((d) => d.placeholder)) {
      hydrating(() => set({ stepDrill: [], drillPeek: null }));
      return;
    }
    const root = s.stepDrill[0];
    hydrating(() =>
      set({
        stepDrill: [],
        drillPeek: null,
        flow: root.savedFlow,
        run: root.savedRun,
        selectedNodeId: root.savedSelectedNodeId,
      }),
    );
  };

  /** Consume one step response: drive the drill stack from entered/exited
   *  markers and clear the live-run id when the run is done. `exited` can
   *  co-occur with `done` (child was the last node, or the child failed). */
  const handleStepResult = (result: StepResult): void => {
    // Order matters when both markers co-occur: a retrying Subflow node pops
    // its failed child AND re-enters a fresh one in the same step — the pop
    // must apply before the push, or the exit would pop the new level.
    if (result.exited) exitDrill();
    if (result.entered) enterDrill(result.entered);
    if (result.done) set({ activeServerRunId: null });
  };

  /** Start a server-side run (if none live) and wire its SSE events into the store. */
  const ensureServerRun = async (
    mode: 'run' | 'step',
    input?: Record<string, unknown>,
    scenarioName?: string,
  ): Promise<string | null> => {
    const existing = get().activeServerRunId;
    if (existing) return existing;
    const flow = get().flow;
    // Remember whether this run executed against mocks — the history entry is
    // tagged so a mocked run is never mistaken for a real one later.
    set({ activeRunMock: get().runnerMock });
    try {
      const runId = await startServerRun(flow, mode, pinsOf(flow), input, {
        ...serverRunOptions(),
        ...(scenarioName ? { scenarioName } : {}),
      });
      const initial: WorkflowRun = {
        id: runId,
        workflowId: flow.id,
        status: 'running',
        startedAt: new Date().toISOString(),
        nodeStates: Object.fromEntries(flow.nodes.map((n) => [n.id, { status: 'queued' as const }])),
      };
      set({ activeServerRunId: runId, run: initial, logs: [] });
      subscribeServerRun(runId, {
        onNodeState: (workflowId, nodeId, state) => {
          set((s) => {
            const followed =
              stepFollow && (state.status === 'succeeded' || state.status === 'failed');
            // The level whose flow is loaded owns this event (deepest drilled
            // level, or the root when not drilled) → apply to the live run.
            if (s.flow.id === workflowId) {
              if (!s.run || s.run.id !== runId) return {};
              return {
                run: { ...s.run, nodeStates: { ...s.run.nodeStates, [nodeId]: state } },
                ...(followed ? { selectedNodeId: nodeId } : {}),
              };
            }
            // A stashed drill level owns it (e.g. the parent's Subflow node
            // updating while we're inside the child) → apply to its stashed
            // run so nothing is lost when that level is restored or peeked.
            const idx = s.stepDrill.findIndex((d) => d.savedFlow.id === workflowId);
            if (idx === -1) return {}; // unknown workflowId — ignore
            const entry = s.stepDrill[idx];
            if (!entry.savedRun || entry.savedRun.id !== runId) return {};
            const savedRun = {
              ...entry.savedRun,
              nodeStates: { ...entry.savedRun.nodeStates, [nodeId]: state },
            };
            return {
              stepDrill: s.stepDrill.map((d, i) => (i === idx ? { ...d, savedRun } : d)),
            };
          });
        },
        onLog: (line) => set((s) => ({ logs: [...s.logs, line] })),
        onFinished: (run, errorHandler) => {
          // The final run is the ROOT run — unwind any remaining drill levels
          // (cancel/failure can finish a run while drilled) before showing it.
          drainDrill();
          set({ run });
          get().recordRun(run, errorHandler);
          set({ activeServerRunId: null });
          revertUnsafeAfterRun();
        },
        onError: (message) => {
          reportRunError(message);
          set({ activeServerRunId: null });
        },
      });
      return runId;
    } catch (err) {
      reportRunError(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  return {
    flow: initialFlow,
    shelf: initialShelf,
    workflows: summaries(initialFlow, initialShelf),
    opMeta: new Map(),
    registry,
    trace: new InMemoryTraceSink(),
    run: null,
    logs: [],
    selectedNodeId: null,
    activeRun: null,
    dockTab: 'logs',
    sidebarOpen: loadPanel(SIDEBAR_KEY),
    dockOpen: loadPanel(DOCK_KEY),
    inspectorOpen: loadPanel(INSPECTOR_KEY),
    agentPanelOpen: false,
    agentEnvSetup: false,
    welcomeOpen: false,
    createModal: null,
    settingsOpen: false,
    settingsFromWelcome: false,
    setupStatus: null,
    viewRegister: initialViewRegister,
    consolePosition: initialConsolePosition,
    runConsoleDismissedId: null,
    runConsoleOpenedIds: new Set(),
    runHistory: [],
    logsByRun: {},
    activeScenarioId: null,
    scenarioTestReports: {},
    activeRunMock: false,
    scenarioTestPending: null,
    agentRun: null,
    guidedTranscript: [],
    buildingOperationId: null,
    agentChoice: initialAgentChoice,
    setAgentChoice(choice) {
      set({ agentChoice: choice });
      persistAgentChoice(choice);
    },
    runnerOnline: null,
    runnerMock: false,
    workspaceSource: 'local',
    activeServerRunId: null,
    stepMode: false,
    stepDrill: [],
    drillPeek: null,
    peekDrill(index) {
      set((s) => {
        if (index === null || s.stepDrill.length === 0) return { drillPeek: null };
        return { drillPeek: index >= 0 && index < s.stepDrill.length ? index : null };
      });
    },
    environments: [],
    environmentsDefault: '',
    selectedEnvironment: initialSelectedEnvironment,
    safeMode: initialSafeMode,

    setDockTab(tab) {
      set({ dockTab: tab });
    },

    async fetchEnvironments() {
      const list = await listEnvironments();
      if (!list) {
        set({ environments: [], environmentsDefault: '' });
        return;
      }
      // A runner with no environments file synthesizes a bare "local" env —
      // that's "no environments yet" to the user, not a real choice: hide it
      // so the dropdown shows the zero-environment onboarding state. Also
      // drop any selection persisted from another project — a phantom "dev"
      // chip in the status bar would claim an environment that doesn't exist.
      if (list.configured === false) {
        set({ environments: [], environmentsDefault: '', selectedEnvironment: '' });
        return;
      }
      set({ environments: list.environments, environmentsDefault: list.defaultEnvironment });
      // Reconcile the persisted selection against what the runner actually offers.
      const s = get();
      const known = list.environments.some((e) => e.name === s.selectedEnvironment);
      if (!known || !s.selectedEnvironment) {
        get().selectEnvironment(list.defaultEnvironment);
      } else {
        // A protected selection always implies safe mode on load.
        const env = list.environments.find((e) => e.name === s.selectedEnvironment);
        if (env?.protected && !s.safeMode) {
          set({ safeMode: true });
          persistSafeMode(true);
        }
      }
      // First time the environments land, honor the active flow's preference
      // (the flow was opened before the runner list was available).
      if (!flowEnvSynced) {
        flowEnvSynced = true;
        applyFlowEnvironment();
      }
    },

    selectEnvironment(name) {
      const env = get().environments.find((e) => e.name === name);
      set({ selectedEnvironment: name });
      persistEnvironment(name);
      // Protected environments force safe mode on selection.
      if (env?.protected) {
        set({ safeMode: true });
        persistSafeMode(true);
      }
    },

    async loginEnvironment(name) {
      await loginEnvironmentOnServer(name);
      await get().fetchEnvironments();
    },

    async setEnvironmentSecret(name, key, value) {
      await setEnvironmentSecretOnServer(name, key, value);
      await get().fetchEnvironments();
    },

    async deleteEnvironmentSecret(name, key) {
      await deleteEnvironmentSecretOnServer(name, key);
      await get().fetchEnvironments();
    },

    async setEnvironmentAuth(name, auth) {
      await setEnvironmentAuthOnServer(name, auth);
      await get().fetchEnvironments();
    },

    setSafeMode(on, confirmName) {
      // Disabling safe mode on a protected env demands the typed-back env name.
      if (!on && selectedEnvProtected() && confirmName !== get().selectedEnvironment) {
        return false;
      }
      set({ safeMode: on });
      persistSafeMode(on);
      return true;
    },

    async setServingMode(mode) {
      await setServingModeOnServer(mode);
      await get().checkRunner();
    },

    async checkRunner() {
      const was = get().runnerOnline;
      const { online, mock } = await runnerHealthy();
      set({ runnerOnline: online, runnerMock: mock });
      // Environments live on the runner; refresh alongside the health check.
      if (online) await get().fetchEnvironments();
      else set({ environments: [], environmentsDefault: '' });
      // One-shot adoption: when the runner first comes online and we're still
      // showing the local workspace, replace it with the runner's files.
      if (online && was !== true && get().workspaceSource === 'local') {
        await get().syncFromRunner();
      }
    },

    async syncNodeMeta() {
      const meta = await fetchNodeMeta();
      if (meta.length === 0) return;
      const registry = get().registry;
      for (const m of meta) {
        const { source, sourceRef, builtin, ...definition } = m;
        registry.registerDefinition(definition, source, { sourceRef, builtin });
      }
      // Force palette/inspector consumers to re-read the registry: a new
      // top-level reference (Zustand uses Object.is) sharing the same node data.
      set({ registry: registry.withSameNodes() });
    },

    async syncFromRunner() {
      const payload = await fetchWorkflows();
      if (!payload || payload.flows.length === 0) return;
      const { flows, operations } = payload;
      const opMeta: OpMeta = new Map(
        operations.map((op) => [op.id, { path: op.path, http: op.http }]),
      );
      const current = get().flow.id;
      const flow = flows.find((f) => f.id === current) ?? flows[0];
      const shelf = flows.filter((f) => f.id !== flow.id);
      hydrating(() =>
        set({
          flow,
          shelf,
          opMeta,
          workflows: summaries(flow, shelf, opMeta),
          workspaceSource: 'server',
          run: null,
          logs: [],
          activeRun: null,
          selectedNodeId: null,
          stepDrill: [],
          drillPeek: null,
        }),
      );
    },

    async createOperation(input) {
      const { api, folder, name, method, httpPath } = input;
      const id = `${api}/${folder ? `${folder}/` : ''}${slug(name)}`;
      const now = new Date().toISOString();
      const inputNode: WorkflowNode = {
        id: 'input',
        type: 'Input',
        label: 'Input',
        position: { x: 0, y: 0 },
        config: {},
      };
      const nodes: WorkflowNode[] = [inputNode];
      const edges: WorkflowDefinition['edges'] = [];
      if (method) {
        const responseNode: WorkflowNode = {
          id: 'response',
          type: 'Response',
          label: 'Response',
          position: { x: 320, y: 0 },
          config: {},
        };
        nodes.push(responseNode);
        edges.push({ id: crypto.randomUUID(), source: 'input', target: 'response' });
      }
      const flow: WorkflowDefinition = {
        id,
        name,
        version: 1,
        nodes,
        edges,
        createdAt: now,
        updatedAt: now,
        ...(method && httpPath ? { http: { method, path: httpPath } } : {}),
      };
      const result = await createOperationOnServer(flow, id);
      if (!result.ok) return result;
      await get().syncFromRunner();
      get().switchWorkflow(id);
      return result;
    },

    async deleteOperations(ids) {
      if (ids.length === 0) return { ok: true };
      for (const id of ids) {
        const result = await deleteWorkflowOnServer(id);
        if (!result.ok) return result;
      }
      // Re-sync from the runner; if the open flow was deleted, syncFromRunner
      // falls back to another flow (or leaves state as-is if none remain).
      await get().syncFromRunner();
      return { ok: true };
    },

    async createAndBuild(input) {
      const { location, name, method, httpPath, goal } = input;
      const parts = location.split('/').filter(Boolean);
      const api = parts[0] || 'default';
      const folder = parts.slice(1).join('/') || undefined;
      // 1) Create the stub op (Input → Response + http trigger) and select it,
      //    so the canvas shows the shell of what's being built right away.
      const created = await get().createOperation({ api, folder, name, method, httpPath });
      if (!created.ok) return created;
      const stubId = `${api}/${folder ? `${folder}/` : ''}${slug(name)}`;
      // 2) Flag the holding pattern, then hand the stub to the agent. Send the
      //    user's goal verbatim (it shows as their message in the panel); the
      //    edit-flow prompt already tells the agent to build the operation out.
      set({ buildingOperationId: stubId });
      // scaffold: this op is a placeholder-named shell — the agent's first step
      // is to rename it properly, then build it out (see the edit-flow prompt).
      void get().runAgent({ action: 'edit-flow', flowId: stubId, instruction: goal, scaffold: true });
      return { ok: true };
    },

    async runAgent(intent, opts) {
      const effectiveOpts = opts ?? get().agentChoice;
      // A guided-setup run is OWNED by the WelcomeDialog's embedded stream, so
      // it must NOT auto-open the right-hand AgentConsole panel. The `guided`
      // marker on the run slot drives both the suppression here and the dialog's
      // phase machine (which re-attaches to this same slot when reopened).
      const guided = intent.action === 'guided-setup';
      // If a build is in flight, remember the op being built + the op ids that
      // existed before the run. If the agent renames the op (the id changes),
      // syncFromRunner can't find the old id and falls back to flows[0], leaving
      // the built op unselected — so we re-select the newly-added op on finish.
      const buildingId = get().buildingOperationId;
      const priorIds = buildingId
        ? new Set([get().flow.id, ...get().shelf.map((f) => f.id)])
        : null;
      let agentRunId: string;
      try {
        agentRunId = await startAgent(intent, effectiveOpts);
      } catch (err) {
        set({
          agentRun: {
            id: '',
            events: [{ type: 'error', text: err instanceof Error ? err.message : String(err) }],
            status: 'error',
            guided,
          },
          // Open the panel so the failure is visible — without this, a start
          // error (e.g. no agent CLI on PATH) lands in a closed panel and the
          // click appears to do nothing. A guided run's failure surfaces in the
          // WelcomeDialog's own pane, so it stays closed.
          ...(guided ? {} : { agentPanelOpen: true }),
        });
        return;
      }

      set({
        agentRun: { id: agentRunId, events: [], status: 'running', instruction: intent.instruction, guided },
        // The WelcomeDialog embeds the stream for guided runs — don't also pop
        // the right-hand console.
        ...(guided ? {} : { agentPanelOpen: true }),
      });

      // Live canvas: while the agent works, poll the runner (GET /workflows reads
      // disk fresh) so the open operation reflects the agent's edits AS THEY LAND
      // — not only at the end. Preserves run/logs/selection (unlike syncFromRunner)
      // and follows a mid-run rename. Partial reads throw and are swallowed; the
      // next tick recovers.
      let livePoll: ReturnType<typeof setInterval> | undefined;
      const pollOnce = async (): Promise<void> => {
        try {
          const payload = await fetchWorkflows();
          if (!payload || payload.flows.length === 0) return;
          const { flows, operations } = payload;
          const opMeta: OpMeta = new Map(operations.map((op) => [op.id, { path: op.path, http: op.http }]));
          const currentId = get().flow.id;
          let flow = flows.find((f) => f.id === currentId);
          // Rename mid-run: the open id is gone — follow the op that's new since
          // the run started (the rename target).
          if (!flow && priorIds) flow = flows.find((f) => !priorIds.has(f.id));
          if (!flow) return;
          const shelf = flows.filter((f) => f.id !== flow.id);
          hydrating(() =>
            set({ flow, shelf, opMeta, workflows: summaries(flow, shelf, opMeta) }),
          );
          // Once real nodes appear (beyond the Input→terminus stub), drop the
          // holding pattern so the live canvas shows instead of "waiting…".
          if (get().buildingOperationId && flow.nodes.length > 2) set({ buildingOperationId: null });
        } catch {
          // transient (partial read / runner blip) — next tick recovers
        }
      };
      const stopPoll = (): void => {
        if (livePoll) {
          clearInterval(livePoll);
          livePoll = undefined;
        }
      };
      livePoll = setInterval(() => void pollOnce(), 2000);

      const finish = async (status: 'done' | 'error') => {
        stopPoll();
        set((s) => (s.agentRun && s.agentRun.id === agentRunId ? { agentRun: { ...s.agentRun, status } } : {}));
        // The build (if any) is over — drop the canvas holding pattern.
        set({ buildingOperationId: null });
        if (status === 'done') {
          // Reload the flow the agent just edited so the canvas shows the change
          // live — the whole point is watching your instruction take effect.
          // Also refresh runner health/environments immediately: setup-auth and
          // setup-environments runs change the env list, and waiting out the
          // 10s poll makes the dropdown look broken right after "done".
          void get().checkRunner();
          try {
            await get().syncFromRunner();
            // Keep the built op selected even if the agent renamed it: if the
            // id we were building is gone, select whichever op is new since the
            // run started (the rename target).
            if (buildingId && get().flow.id !== buildingId) {
              const added = [get().flow, ...get().shelf].find((f) => priorIds && !priorIds.has(f.id));
              if (added) get().switchWorkflow(added.id);
            }
          } catch {
            // reload best-effort — the diff below still shows what changed
          }
          try {
            const { diff, files } = await fetchAgentDiff(agentRunId);
            set((s) => (s.agentRun && s.agentRun.id === agentRunId ? { agentRun: { ...s.agentRun, diff, files } } : {}));
          } catch {
            // Diff fetch failure isn't fatal — the console still shows the event stream.
          }
        }
      };

      streamAgent(agentRunId, (event) => {
        set((s) =>
          s.agentRun && s.agentRun.id === agentRunId
            ? { agentRun: { ...s.agentRun, events: [...s.agentRun.events, event] } }
            : {},
        );
        if (event.type === 'done') void finish('done');
        else if (event.type === 'error') void finish('error');
      });
    },

    async revertAgentRun() {
      const agentRun = get().agentRun;
      if (!agentRun) return;
      await revertAgent(agentRun.id);
      // The diff is now stale (files restored) — clear it so the panel stops
      // showing the old diff + a live Revert button.
      set((s) =>
        s.agentRun && s.agentRun.id === agentRun.id
          ? { agentRun: { ...s.agentRun, diff: undefined, files: undefined } }
          : {},
      );
      await get().syncFromRunner();
    },

    dismissAgentRun() {
      const agentRun = get().agentRun;
      if (agentRun && agentRun.status === 'running') void cancelAgent(agentRun.id);
      set({ agentRun: null });
    },

    toggleSidebar() {
      set((s) => {
        const open = !s.sidebarOpen;
        persistPanel(SIDEBAR_KEY, open);
        return { sidebarOpen: open };
      });
    },

    toggleDock() {
      set((s) => {
        const open = !s.dockOpen;
        persistPanel(DOCK_KEY, open);
        return { dockOpen: open };
      });
    },

    toggleInspector() {
      set((s) => {
        const open = !s.inspectorOpen;
        persistPanel(INSPECTOR_KEY, open);
        return { inspectorOpen: open };
      });
    },

    beginEnvironmentSetup() {
      set({ agentPanelOpen: true, agentEnvSetup: true });
    },

    beginInfrastructureScout(instruction) {
      // Defensive: callers wired as onClick handlers leak a MouseEvent as the
      // first arg — anything that isn't a string means "full rescan".
      const amendment = typeof instruction === 'string' ? instruction.trim() : '';
      void get().runAgent({
        action: 'scout-infrastructure',
        instruction:
          amendment && amendment.length > 0
            ? amendment
            : "Scan this project's dependencies, config files, ORM schemas, env-var references and HTTP clients, and write emberflow/infrastructure.json describing the databases, APIs and providers it already uses.",
      });
    },

    beginGuidedSetup(instruction) {
      // onClick handlers leak a MouseEvent as the first arg — only a real string
      // is a continuation answer; anything else means "start with no notes".
      const notes = typeof instruction === 'string' ? instruction.trim() : '';
      const prior = get().agentRun;
      if (notes && prior?.guided) {
        // Continuation: the new run REPLACES the agentRun slot, so fold the
        // finished run's events plus the user's answer into the persistent
        // transcript — otherwise the pane wipes to "Thinking…" and the whole
        // conversation vanishes. Question blocks are stripped here (they were
        // answered; re-rendering them as raw fences would be noise).
        const stripped = prior.events.map((e) =>
          e.type === 'message' && e.text ? { ...e, text: extractGuidedQuestions(e.text).stripped } : e,
        );
        set((s) => ({
          guidedTranscript: [
            ...s.guidedTranscript,
            ...stripped,
            { type: 'message', text: `**You:** ${notes}` },
          ],
        }));
      } else if (!notes) {
        // Fresh start: a brand-new guided run begins a brand-new conversation.
        set({ guidedTranscript: [] });
      }
      void get().runAgent({ action: 'guided-setup', instruction: notes });
    },

    resetGuidedSetup() {
      const run = get().agentRun;
      if (run?.guided && run.status === 'running') return; // never kill a live run
      set((s) => ({
        guidedTranscript: [],
        agentRun: s.agentRun?.guided ? null : s.agentRun,
      }));
    },

    setWelcomeOpen(open) {
      set({ welcomeOpen: open });
    },

    setCreateModal(state) {
      set({ createModal: state });
    },

    setSettingsOpen(open) {
      set(open ? { settingsOpen: true } : { settingsOpen: false, settingsFromWelcome: false });
    },

    openSettingsFromWelcome() {
      set({ welcomeOpen: false, settingsOpen: true, settingsFromWelcome: true });
    },

    async refreshSetupStatus() {
      const status = await fetchSetupStatus();
      if (status) set({ setupStatus: status });
      return status;
    },

    openAgentPanel() {
      set({ agentPanelOpen: true });
    },

    toggleAgentPanel() {
      // Closing the panel leaves environment-setup mode — reopening it later
      // should be about the open operation again.
      set((s) => ({ agentPanelOpen: !s.agentPanelOpen, ...(s.agentPanelOpen ? { agentEnvSetup: false } : {}) }));
    },

    setViewRegister(register) {
      set({ viewRegister: register });
      if (typeof localStorage !== 'undefined') localStorage.setItem(REGISTER_KEY, register);
    },

    setConsolePosition(position) {
      set({ consolePosition: position });
      if (typeof localStorage !== 'undefined') localStorage.setItem(CONSOLE_POSITION_KEY, position);
    },

    dismissRunConsole() {
      set({ runConsoleDismissedId: get().run?.id ?? null });
    },

    reopenRunConsole() {
      set((s) => {
        const runId = s.run?.id;
        const runConsoleOpenedIds = runId
          ? new Set(s.runConsoleOpenedIds).add(runId)
          : s.runConsoleOpenedIds;
        return { runConsoleDismissedId: null, runConsoleOpenedIds };
      });
    },

    recordRun(run, errorHandler) {
      set((s) => {
        const scenario = s.activeScenarioId
          ? s.flow.scenarios?.find((sc) => sc.id === s.activeScenarioId)
          : undefined;
        const entry: RunHistoryEntry = {
          ...run,
          ...(scenario ? { scenarioName: scenario.name } : {}),
          ...(errorHandler ? { errorHandler } : {}),
          ...(s.activeRunMock ? { mock: true } : {}),
        };
        return {
          runHistory: [entry, ...s.runHistory].slice(0, 50),
          logsByRun: { ...s.logsByRun, [run.id]: s.logs },
        };
      });
    },

    viewRun(runId) {
      const entry = get().runHistory.find((r) => r.id === runId);
      if (entry) {
        set((s) => ({ run: entry, logs: s.logsByRun[runId] ?? [], activeRun: null }));
      }
    },

    createWorkflow() {
      const flow = emptyFlow();
      set((s) => {
        const shelf = [...s.shelf, s.flow];
        return {
          flow,
          shelf,
          workflows: summaries(flow, shelf, s.opMeta),
          run: null,
          logs: [],
          activeRun: null,
          selectedNodeId: null,
        };
      });
      revertUnsafeAfterRun();
    },

    moveWorkflowToFolder(id, folder) {
      set((s) => {
        const assign = (f: WorkflowDefinition): WorkflowDefinition => {
          if (f.id !== id) return f;
          const next = { ...f };
          if (folder) next.folder = folder;
          else delete next.folder;
          return next;
        };
        const flow = assign(s.flow);
        const shelf = s.shelf.map(assign);
        return { flow, shelf, workflows: summaries(flow, shelf, s.opMeta) };
      });
    },

    switchWorkflow(id) {
      // Switching flows while drilled would strand the stashed parent — put
      // the root level back first so flow/shelf are consistent again.
      drainDrill();
      let switched = false;
      set((s) => {
        if (s.flow.id === id) return {};
        const target = s.shelf.find((f) => f.id === id);
        if (!target) return {};
        switched = true;
        const shelf = [...s.shelf.filter((f) => f.id !== id), s.flow];
        return {
          flow: target,
          shelf,
          workflows: summaries(target, shelf, s.opMeta),
          run: null,
          logs: [],
          activeRun: null,
          selectedNodeId: null,
        };
      });
      // Switching flows ends any consciously-unsafe session, then honors the
      // newly-opened flow's preferred environment (if any).
      if (switched) {
        revertUnsafeAfterRun();
        applyFlowEnvironment();
      }
    },

    addNode(type, position) {
      const definition = get().registry.get(type).definition;
      set((s) => ({
        flow: touched({
          ...s.flow,
          nodes: [
            ...s.flow.nodes,
            { id: crypto.randomUUID(), type, label: definition.label, position, config: {} },
          ],
        }),
      }));
    },

    moveNode(id, position) {
      set((s) => ({
        flow: {
          ...s.flow,
          nodes: s.flow.nodes.map((n) => (n.id === id ? { ...n, position } : n)),
        },
      }));
    },

    resizeNode(id, size) {
      // Layout-only, like moveNode: no updatedAt bump on every drag tick.
      set((s) => ({
        flow: {
          ...s.flow,
          nodes: s.flow.nodes.map((n) =>
            n.id === id ? { ...n, metadata: { ...n.metadata, size } } : n,
          ),
        },
      }));
    },

    removeNode(id) {
      set((s) => ({
        flow: touched({
          ...s.flow,
          nodes: s.flow.nodes.filter((n) => n.id !== id),
          edges: s.flow.edges.filter((e) => e.source !== id && e.target !== id),
        }),
        selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
      }));
    },

    removeEdge(id) {
      set((s) => {
        const edge = s.flow.edges.find((e) => e.id === id);
        let nodes = s.flow.nodes;
        // A field edge carries a mapping; deleting the edge deletes the mapping.
        if (edge?.targetHandle) {
          nodes = nodes.map((n) => {
            if (n.id !== edge.target) return n;
            const mapping = n.inputMap?.[edge.targetHandle!];
            if (!mapping || mapping.sourceNodeId !== edge.source) return n;
            const inputMap = { ...n.inputMap };
            delete inputMap[edge.targetHandle!];
            return { ...n, inputMap };
          });
        }
        return {
          flow: touched({ ...s.flow, nodes, edges: s.flow.edges.filter((e) => e.id !== id) }),
        };
      });
    },

    // connect/removeNode/moveNode/resizeNode: the runbook view has no
    // authoring surface today (it's read-only, projection-driven). These
    // stay for the file/agent authoring path — flows are built by editing
    // workflow JSON or via agent tooling that calls this store directly —
    // and for the canvas-based editing surface planned for later.
    connect(source, target, targetHandle, sourceHandle) {
      set((s) => {
        let nodes = s.flow.nodes;
        if (targetHandle) {
          nodes = nodes.map((n) =>
            n.id === target
              ? {
                  ...n,
                  inputMap: {
                    ...n.inputMap,
                    [targetHandle]: { sourceNodeId: source, sourceField: '$' },
                  },
                }
              : n,
          );
        }
        return {
          flow: touched({
            ...s.flow,
            nodes,
            edges: [
              ...s.flow.edges,
              { id: crypto.randomUUID(), source, target, targetHandle, sourceHandle },
            ],
          }),
        };
      });
    },

    selectNode(id) {
      // Selecting a node always surfaces the Inspector — a click that lands
      // nowhere visible reads as a dead click. Deselection leaves panels alone.
      if (id !== null && !get().inspectorOpen) {
        set({ selectedNodeId: id, inspectorOpen: true });
        persistPanel(INSPECTOR_KEY, true);
        return;
      }
      set({ selectedNodeId: id });
    },

    renameFlow(name) {
      set((s) => {
        const flow = touched({ ...s.flow, name });
        return { flow, workflows: summaries(flow, s.shelf, s.opMeta) };
      });
    },

    setFlowHttp(http) {
      set((s) => {
        const flow = touched({ ...s.flow, http });
        return { flow, workflows: summaries(flow, s.shelf, s.opMeta) };
      });
    },

    renameNode(id, label) {
      set((s) => ({
        flow: touched({
          ...s.flow,
          nodes: s.flow.nodes.map((n) => (n.id === id ? { ...n, label } : n)),
        }),
      }));
    },

    updateNodeConfig(id, key, value) {
      set((s) => ({
        flow: touched({
          ...s.flow,
          nodes: s.flow.nodes.map((n) =>
            n.id === id ? { ...n, config: { ...n.config, [key]: value } } : n,
          ),
        }),
      }));
    },

    setNodeRetry(id, retry) {
      set((s) => ({
        flow: touched({
          ...s.flow,
          nodes: s.flow.nodes.map((n) => {
            if (n.id !== id) return n;
            const { retry: _drop, ...rest } = n;
            return retry ? { ...rest, retry } : rest;
          }),
        }),
      }));
    },

    seedParamDefault(param) {
      const inputNode = get().flow.nodes.find((n) => n.type === 'Input');
      if (!inputNode) return;
      const existingDefaults = (inputNode.config?.defaults as Record<string, unknown> | undefined) ?? {};
      const existingParams =
        (existingDefaults.params as Record<string, unknown> | undefined) ?? {};
      if (existingParams[param] !== undefined) return;
      set((s) => ({
        flow: touched({
          ...s.flow,
          nodes: s.flow.nodes.map((n) =>
            n.id === inputNode.id
              ? {
                  ...n,
                  config: {
                    ...n.config,
                    defaults: {
                      ...existingDefaults,
                      params: { ...existingParams, [param]: '' },
                    },
                  },
                }
              : n,
          ),
        }),
      }));
      get().saveFlow();
    },

    setInputMapping(nodeId, field, mapping) {
      set((s) => ({
        flow: touched({
          ...s.flow,
          nodes: s.flow.nodes.map((n) => {
            if (n.id !== nodeId) return n;
            const inputMap = { ...n.inputMap };
            if (mapping) inputMap[field] = mapping;
            else delete inputMap[field];
            return { ...n, inputMap };
          }),
        }),
      }));
    },

    pinNodeOutput(nodeId, output) {
      set((s) => ({
        flow: touched({
          ...s.flow,
          nodes: s.flow.nodes.map((n) =>
            n.id === nodeId
              ? { ...n, metadata: { ...n.metadata, pinnedOutput: output } }
              : n,
          ),
        }),
      }));
    },

    unpinNode(nodeId) {
      set((s) => ({
        flow: touched({
          ...s.flow,
          nodes: s.flow.nodes.map((n) => {
            if (n.id !== nodeId || !n.metadata || !('pinnedOutput' in n.metadata)) return n;
            const metadata = { ...n.metadata };
            delete metadata.pinnedOutput;
            if (Object.keys(metadata).length === 0) {
              const { metadata: _dropped, ...rest } = n;
              return rest;
            }
            return { ...n, metadata };
          }),
        }),
      }));
    },

    async runNodeIsolated(nodeId, input) {
      const s = get();
      const node = s.flow.nodes.find((n) => n.id === nodeId);
      if (!node) return { error: `Unknown node: ${nodeId}`, logs: [] };
      // Isolated node runs execute on the runner (POST /node-run) against the
      // selected environment's secrets/vars, honouring safe mode — the studio
      // bundles no implementations. Runner offline → surface the offline notice.
      const startedAt = new Date().toISOString();
      let result: { output?: unknown; error?: string; logs: LogLine[] };
      try {
        result = await runNodeOnServer({
          type: node.type,
          input,
          config: node.config ?? {},
          ...(s.selectedEnvironment ? { environment: s.selectedEnvironment } : {}),
          safeMode: s.safeMode,
          ...(selectedEnvProtected() && !s.safeMode ? { confirm: s.selectedEnvironment } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: get().runnerOnline === false
            ? 'Runner offline — start it with `npx emberflow dev`, then run this node again.'
            : message,
          logs: [],
        };
      }
      // Record a local trace sample so the modal's "previous executions" list
      // and pin affordance keep working alongside runner-recorded samples.
      s.trace.record({
        id: crypto.randomUUID(),
        workflowId: s.flow.id,
        runId: `isolated-${crypto.randomUUID().slice(0, 8)}`,
        nodeId: node.id,
        nodeType: node.type,
        nodeLabel: node.label,
        input,
        output: result.output,
        status: result.error ? 'failed' : 'succeeded',
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return { output: result.output, error: result.error, logs: result.logs ?? [] };
    },

    async testWorkflow(flowId, environment) {
      set({ scenarioTestPending: flowId });
      try {
        const report = await testWorkflowOnServer(flowId, environment);
        set((s) => ({
          scenarioTestReports: { ...s.scenarioTestReports, [flowId]: report },
        }));
      } finally {
        set((s) => (s.scenarioTestPending === flowId ? { scenarioTestPending: null } : {}));
      }
    },

    async runScenario(scenarioId) {
      const scenario = get().flow.scenarios?.find((sc) => sc.id === scenarioId);
      if (!scenario) return;
      stepFollow = false;
      get().resetRun();
      set({ stepMode: false });
      set({ activeScenarioId: scenarioId });
      await ensureServerRun('run', scenario.input, scenario.name);
    },

    async stepScenario(scenarioId) {
      const scenario = get().flow.scenarios?.find((sc) => sc.id === scenarioId);
      if (!scenario) return;
      stepFollow = true;
      get().resetRun();
      set({ stepMode: true });
      set({ activeScenarioId: scenarioId });
      const runId = await ensureServerRun('step', scenario.input, scenario.name);
      if (runId) {
        try {
          handleStepResult(await stepServerRun(runId));
        } catch (err) {
          reportRunError(err instanceof Error ? err.message : String(err));
        }
      }
    },

    addScenario(name, input, description, expect) {
      const scenario: ScenarioDefinition = {
        id: crypto.randomUUID(),
        name,
        ...(description ? { description } : {}),
        input,
        ...(expect ? { expect } : {}),
      };
      set((s) => ({
        flow: touched({ ...s.flow, scenarios: [...(s.flow.scenarios ?? []), scenario] }),
        // A scenario change makes the last test report stale — drop it so the
        // panel never shows a ✓/✗ for expectations that no longer exist.
        scenarioTestReports: dropReport(s.scenarioTestReports, s.flow.id),
      }));
    },

    updateScenario(id, patch) {
      set((s) => ({
        flow: touched({
          ...s.flow,
          scenarios: (s.flow.scenarios ?? []).map((sc) =>
            sc.id === id ? { ...sc, ...patch } : sc,
          ),
        }),
        scenarioTestReports: dropReport(s.scenarioTestReports, s.flow.id),
      }));
    },

    removeScenario(id) {
      set((s) => {
        const scenarios = (s.flow.scenarios ?? []).filter((sc) => sc.id !== id);
        const flow = { ...s.flow };
        if (scenarios.length > 0) flow.scenarios = scenarios;
        else delete flow.scenarios;
        return {
          flow: touched(flow),
          scenarioTestReports: dropReport(s.scenarioTestReports, s.flow.id),
        };
      });
    },

    async stepRun() {
      // A plain step/run is not scenario-driven; only tag history for runs
      // started via runScenario.
      if (!get().activeServerRunId) set({ activeScenarioId: null });
      stepFollow = true;
      set({ stepMode: true, runConsoleDismissedId: null });
      const runId = await ensureServerRun('step');
      if (runId) {
        try {
          handleStepResult(await stepServerRun(runId));
        } catch (err) {
          reportRunError(err instanceof Error ? err.message : String(err));
        }
      }
    },

    async runToEnd() {
      stepFollow = false;
      set({ stepMode: false, runConsoleDismissedId: null });
      if (!get().activeServerRunId) set({ activeScenarioId: null });
      const existing = get().activeServerRunId;
      if (existing) {
        // A stepped run is already live on the runner — walk it to the end.
        // Drill markers still apply (entered/exited keep the view balanced;
        // handleStepResult clears activeServerRunId on done).
        try {
          let done = false;
          while (!done) {
            const result = await stepServerRun(existing);
            handleStepResult(result);
            done = result.done;
          }
        } catch (err) {
          reportRunError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      await ensureServerRun('run');
    },

    resetRun() {
      // Unwind any subflow drill first so the root flow is back on the canvas
      // before the run state clears.
      drainDrill();
      get().activeRun?.cancel();
      const serverRunId = get().activeServerRunId;
      if (serverRunId) void cancelServerRun(serverRunId);
      // A fresh run clears any prior dismissal so the console re-surfaces —
      // in technical it auto-opens (useRunConsole), so Run always shows logs.
      set({ run: null, logs: [], activeRun: null, activeServerRunId: null, stepMode: false, runConsoleDismissedId: null });
    },

    saveFlow() {
      const s = get();
      const flows = [s.flow, ...s.shelf];
      if (s.workspaceSource === 'server') {
        // Runner is source of truth: push every flow, keep localStorage as backup.
        for (const f of flows) void putWorkflow(f);
      }
      saveWorkspace({ flows, activeId: s.flow.id });
    },

    loadFlow() {
      const ws = loadWorkspace();
      if (!ws) return;
      const flow = ws.flows.find((f) => f.id === ws.activeId) ?? ws.flows[0];
      const shelf = ws.flows.filter((f) => f.id !== flow.id);
      hydrating(() =>
        set({
          flow,
          shelf,
          workflows: summaries(flow, shelf, get().opMeta),
          run: null,
          logs: [],
          activeRun: null,
          selectedNodeId: null,
        }),
      );
    },

    exportFlow() {
      return serializeFlow(get().flow);
    },

    importFlow(json) {
      const imported = parseFlow(json);
      set((s) => {
        // Imported flow becomes (or replaces) a workflow and is made active.
        const shelf = [...s.shelf.filter((f) => f.id !== imported.id), s.flow].filter(
          (f) => f.id !== imported.id,
        );
        return {
          flow: imported,
          shelf,
          workflows: summaries(imported, shelf, s.opMeta),
          run: null,
          logs: [],
          activeRun: null,
          selectedNodeId: null,
        };
      });
    },
  };
});

// Autosave: any flow/shelf change (layout, resize, config, scenarios) persists
// after a short idle, so nothing is lost to a reload without hitting Save.
// Changes that merely hydrate the workspace (runner sync, local load) are not
// edits and must not save — writing them back would echo runner state forever.
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
export let suppressAutosave = false;
export function hydrating<T>(fn: () => T): T {
  suppressAutosave = true;
  try {
    return fn();
  } finally {
    suppressAutosave = false;
  }
}
useBuilderStore.subscribe((state, prev) => {
  if (suppressAutosave) return;
  if (state.flow === prev.flow && state.shelf === prev.shelf) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    // A background tab must not save: two open tabs would take turns
    // clobbering each other's workspace (last writer wins).
    if (typeof document !== 'undefined' && !document.hasFocus()) return;
    useBuilderStore.getState().saveFlow();
  }, 800);
});

// Merge consumer-node metadata from the runner (if reachable) into the
// registry so custom project nodes appear in the palette/inspector.
void useBuilderStore.getState().syncNodeMeta();
