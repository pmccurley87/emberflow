import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinsOf, useBuilderStore } from './builderStore';
import { createLoginFlow } from '../flows/login-flow';
import * as serverRunner from './serverRunner';
import * as agentClient from './agentClient';
import type { WorkflowDefinition } from '../engine';
import type { ScenarioTestReport, ServerRunHandlers, StepResult } from './serverRunner';

vi.mock('./serverRunner', async () => {
  const actual = await vi.importActual<typeof import('./serverRunner')>('./serverRunner');
  return {
    ...actual,
    fetchWorkflows: vi.fn(),
    putWorkflow: vi.fn(),
    createOperationOnServer: vi.fn(),
    listEnvironments: vi.fn(),
    loginEnvironment: vi.fn(),
    setEnvironmentSecret: vi.fn(),
    deleteEnvironmentSecret: vi.fn(),
    setEnvironmentAuth: vi.fn(),
    runnerHealthy: vi.fn(),
    testWorkflow: vi.fn(),
    startServerRun: vi.fn(),
    stepServerRun: vi.fn(),
    subscribeServerRun: vi.fn(),
    setServingMode: vi.fn(),
    runNodeOnServer: vi.fn(),
  };
});

vi.mock('./agentClient', async () => {
  const actual = await vi.importActual<typeof import('./agentClient')>('./agentClient');
  return {
    ...actual,
    startAgent: vi.fn(async () => 'run-1'),
    streamAgent: vi.fn(() => () => {}),
    fetchAgentDiff: vi.fn(async () => ({ diff: '', files: [] })),
  };
});

describe('builderStore graph editing', () => {
  beforeEach(() => {
    useBuilderStore.setState({ flow: createLoginFlow(), run: null, logs: [], activeRun: null });
  });

  it('connect with a targetHandle creates an input mapping to the whole output', () => {
    const s = useBuilderStore.getState();
    s.connect('validate', 'issueToken', 'userId');
    const node = useBuilderStore.getState().flow.nodes.find((n) => n.id === 'issueToken')!;
    expect(node.inputMap?.userId).toEqual({ sourceNodeId: 'validate', sourceField: '$' });
    const edge = useBuilderStore.getState().flow.edges.find(
      (e) => e.source === 'validate' && e.target === 'issueToken',
    );
    expect(edge?.targetHandle).toBe('userId');
  });

  it('removing a field edge clears the mapping it created', () => {
    const s = useBuilderStore.getState();
    s.connect('validate', 'issueToken', 'userId');
    const edge = useBuilderStore.getState().flow.edges.find(
      (e) => e.source === 'validate' && e.target === 'issueToken' && e.targetHandle === 'userId',
    )!;
    useBuilderStore.getState().removeEdge(edge.id);
    const node = useBuilderStore.getState().flow.nodes.find((n) => n.id === 'issueToken')!;
    expect(node.inputMap?.userId).toBeUndefined();
  });

  it('setInputMapping sets and clears mappings', () => {
    useBuilderStore.getState().setInputMapping('issueToken', 'userId', {
      sourceNodeId: 'fetch', sourceField: 'id',
    });
    let node = useBuilderStore.getState().flow.nodes.find((n) => n.id === 'issueToken')!;
    expect(node.inputMap?.userId).toEqual({ sourceNodeId: 'fetch', sourceField: 'id' });

    useBuilderStore.getState().setInputMapping('issueToken', 'userId', null);
    node = useBuilderStore.getState().flow.nodes.find((n) => n.id === 'issueToken')!;
    expect(node.inputMap?.userId).toBeUndefined();
  });

  it('updateNodeConfig writes config values', () => {
    useBuilderStore.getState().updateNodeConfig('validate', 'username', 'grace');
    const node = useBuilderStore.getState().flow.nodes.find((n) => n.id === 'validate')!;
    expect(node.config.username).toBe('grace');
  });

  it('renameNode updates the label', () => {
    useBuilderStore.getState().renameNode('validate', 'Check Login');
    const node = useBuilderStore.getState().flow.nodes.find((n) => n.id === 'validate')!;
    expect(node.label).toBe('Check Login');
  });

  it('seedParamDefault seeds an empty default on the Input node and saves', () => {
    const saveSpy = vi.spyOn(useBuilderStore.getState(), 'saveFlow');
    useBuilderStore.getState().seedParamDefault('id');
    const input = useBuilderStore.getState().flow.nodes.find((n) => n.type === 'Input')!;
    expect((input.config.defaults as { params: Record<string, unknown> }).params.id).toBe('');
    expect(saveSpy).toHaveBeenCalled();
  });

  it('seedParamDefault preserves an existing value for the param', () => {
    const flow = useBuilderStore.getState().flow;
    useBuilderStore.setState({
      flow: {
        ...flow,
        nodes: flow.nodes.map((n) =>
          n.type === 'Input'
            ? { ...n, config: { ...n.config, defaults: { params: { id: 'real-id' } } } }
            : n,
        ),
      },
    });
    useBuilderStore.getState().seedParamDefault('id');
    const input = useBuilderStore.getState().flow.nodes.find((n) => n.type === 'Input')!;
    expect((input.config.defaults as { params: Record<string, unknown> }).params.id).toBe('real-id');
  });

  it('seedParamDefault is a no-op when the flow has no Input node', () => {
    const flow = useBuilderStore.getState().flow;
    const flowWithoutInput = { ...flow, nodes: flow.nodes.filter((n) => n.type !== 'Input') };
    useBuilderStore.setState({ flow: flowWithoutInput });
    expect(() => useBuilderStore.getState().seedParamDefault('id')).not.toThrow();
    const stillNoInput = useBuilderStore.getState().flow.nodes.find((n) => n.type === 'Input');
    expect(stillNoInput).toBeUndefined();
  });
});

describe('builderStore workflows', () => {
  beforeEach(() => {
    useBuilderStore.setState({ flow: createLoginFlow(), run: null, logs: [], activeRun: null });
  });

  it('createWorkflow adds an empty flow and switches to it', () => {
    const before = useBuilderStore.getState().flow.id;
    useBuilderStore.getState().createWorkflow();
    const state = useBuilderStore.getState();
    expect(state.flow.id).not.toBe(before);
    expect(state.flow.nodes).toEqual([]);
    expect(state.workflows.some((w) => w.id === state.flow.id)).toBe(true);
  });

  it('switchWorkflow loads the target and clears run state', () => {
    const loginId = useBuilderStore.getState().flow.id;
    useBuilderStore.getState().createWorkflow();
    const newId = useBuilderStore.getState().flow.id;
    useBuilderStore.getState().switchWorkflow(loginId);
    expect(useBuilderStore.getState().flow.id).toBe(loginId);
    expect(useBuilderStore.getState().run).toBeNull();
    useBuilderStore.getState().switchWorkflow(newId);
    expect(useBuilderStore.getState().flow.id).toBe(newId);
  });

  it('workflows list reflects renames', () => {
    useBuilderStore.getState().renameFlow('Signup Flow');
    const state = useBuilderStore.getState();
    expect(state.workflows.find((w) => w.id === state.flow.id)?.name).toBe('Signup Flow');
  });

  it('moveWorkflowToFolder sets and clears folder on active and shelved flows', () => {
    const activeId = useBuilderStore.getState().flow.id;
    useBuilderStore.getState().createWorkflow();
    const newId = useBuilderStore.getState().flow.id;

    useBuilderStore.getState().moveWorkflowToFolder(activeId, 'Auth');
    useBuilderStore.getState().moveWorkflowToFolder(newId, 'Auth');
    let workflows = useBuilderStore.getState().workflows;
    expect(workflows.find((w) => w.id === activeId)?.folder).toBe('Auth');
    expect(workflows.find((w) => w.id === newId)?.folder).toBe('Auth');

    useBuilderStore.getState().moveWorkflowToFolder(newId, null);
    workflows = useBuilderStore.getState().workflows;
    expect(workflows.find((w) => w.id === newId)?.folder).toBeUndefined();
  });
});

describe('builderStore pinning', () => {
  beforeEach(() => {
    vi.mocked(serverRunner.startServerRun).mockReset().mockResolvedValue('run-p');
    vi.mocked(serverRunner.subscribeServerRun).mockReset().mockImplementation(() => () => {});
    useBuilderStore.setState({
      flow: createLoginFlow(), run: null, logs: [], activeRun: null,
      activeServerRunId: null, runnerOnline: true,
    });
  });

  it('threads pinned outputs to the server run (the runner honours the pin)', async () => {
    useBuilderStore
      .getState()
      .pinNodeOutput('validate', { userId: 'user-pinned', username: 'pinned' });
    await useBuilderStore.getState().runToEnd();
    // pins are startServerRun's 3rd arg (flow, mode, pins, input, options).
    const pins = vi.mocked(serverRunner.startServerRun).mock.calls[0][2];
    expect(pins).toEqual({ validate: { userId: 'user-pinned', username: 'pinned' } });
  });

  it('unpinNode clears the pin and empties metadata', () => {
    useBuilderStore.getState().pinNodeOutput('validate', { userId: 'x' });
    expect(pinsOf(useBuilderStore.getState().flow)).toHaveProperty('validate');
    useBuilderStore.getState().unpinNode('validate');
    const node = useBuilderStore.getState().flow.nodes.find((n) => n.id === 'validate')!;
    expect(node.metadata).toBeUndefined();
    expect(pinsOf(useBuilderStore.getState().flow)).toEqual({});
  });

  it('pins survive export/import round-trips', () => {
    useBuilderStore.getState().pinNodeOutput('validate', { userId: 'kept' });
    const json = useBuilderStore.getState().exportFlow();
    useBuilderStore.getState().importFlow(json);
    expect(pinsOf(useBuilderStore.getState().flow)).toEqual({
      validate: { userId: 'kept' },
    });
  });
});

describe('builderStore isolated node run (server-backed)', () => {
  beforeEach(() => {
    vi.mocked(serverRunner.runNodeOnServer).mockReset();
    useBuilderStore.setState({
      flow: createLoginFlow(),
      run: null,
      logs: [],
      activeRun: null,
      runnerOnline: true,
      selectedEnvironment: 'local',
      safeMode: true,
    });
  });

  it('calls the runner with the node type, input, config and env, and records a local sample', async () => {
    vi.mocked(serverRunner.runNodeOnServer).mockResolvedValue({
      output: { plan: 'pro' },
      logs: [{ timestamp: 't', level: 'info', runId: 'node-run', message: 'plan pro' }],
    });
    const before = useBuilderStore.getState().trace.samplesFor('checkPlan').length;

    const result = await useBuilderStore
      .getState()
      .runNodeIsolated('checkPlan', { user: { plan: 'pro' } });

    expect(result.error).toBeUndefined();
    expect((result.output as { plan: string }).plan).toBe('pro');
    expect(result.logs.some((l) => l.message.includes('pro'))).toBe(true);
    const call = vi.mocked(serverRunner.runNodeOnServer).mock.calls[0][0];
    // Sends the node TYPE (CheckPlan), not the node id (checkPlan).
    expect(call.type).toBe('CheckPlan');
    expect(call.input).toEqual({ user: { plan: 'pro' } });
    expect(call.environment).toBe('local');
    const samples = useBuilderStore.getState().trace.samplesFor('checkPlan');
    expect(samples.length).toBe(before + 1);
    expect(samples[0].input).toEqual({ user: { plan: 'pro' } });
    expect(useBuilderStore.getState().run).toBeNull();
  });

  it('surfaces a runner error as the result error and records a failed sample', async () => {
    vi.mocked(serverRunner.runNodeOnServer).mockResolvedValue({
      error: 'Password too short',
      logs: [],
    });
    const failed = await useBuilderStore
      .getState()
      .runNodeIsolated('validate', { username: 'ada', password: 'x' });
    expect(failed.error).toContain('Password too short');
    expect(useBuilderStore.getState().trace.samplesFor('validate')[0].status).toBe('failed');
  });

  it('shows the offline notice when the runner is unreachable', async () => {
    useBuilderStore.setState({ runnerOnline: false });
    vi.mocked(serverRunner.runNodeOnServer).mockRejectedValue(new Error('Failed to fetch'));
    const result = await useBuilderStore
      .getState()
      .runNodeIsolated('validate', { username: 'ada', password: 'x' });
    expect(result.error).toContain('Runner offline');
    expect(result.logs).toEqual([]);
  });
});

describe('builderStore runner sync', () => {
  const serverFlow = (id: string, name: string): WorkflowDefinition => ({
    id,
    name,
    version: 1,
    nodes: [],
    edges: [],
    createdAt: '2026-07-02T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
  });

  /** Wraps flows into the { flows, operations } shape fetchWorkflows now returns. */
  const payload = (
    flows: WorkflowDefinition[],
    operations: serverRunner.OperationMeta[] = [],
  ): serverRunner.WorkflowsPayload => ({ flows, operations });

  beforeEach(() => {
    vi.mocked(serverRunner.fetchWorkflows).mockReset();
    vi.mocked(serverRunner.putWorkflow).mockReset().mockResolvedValue(true);
    vi.mocked(serverRunner.createOperationOnServer).mockReset().mockResolvedValue({ ok: true });
    useBuilderStore.setState({
      flow: createLoginFlow(),
      shelf: [],
      workspaceSource: 'local',
      opMeta: new Map(),
      run: null,
      logs: [],
      activeRun: null,
    });
  });

  it('syncFromRunner adopts the server flows and flips workspaceSource', async () => {
    const flows = [serverFlow('srv-a', 'Server A'), serverFlow('srv-b', 'Server B')];
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValue(payload(flows));

    await useBuilderStore.getState().syncFromRunner();

    const state = useBuilderStore.getState();
    expect(state.workspaceSource).toBe('server');
    expect(state.flow.id).toBe('srv-a');
    expect([state.flow, ...state.shelf].map((f) => f.id).sort()).toEqual(['srv-a', 'srv-b']);
  });

  it('syncFromRunner leaves the workspace alone when the runner returns null', async () => {
    const before = useBuilderStore.getState().flow.id;
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValue(null);

    await useBuilderStore.getState().syncFromRunner();

    const state = useBuilderStore.getState();
    expect(state.workspaceSource).toBe('local');
    expect(state.flow.id).toBe(before);
  });

  it('saveFlow PUTs every flow to the runner once adopted', async () => {
    const flows = [serverFlow('srv-a', 'Server A'), serverFlow('srv-b', 'Server B')];
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValue(payload(flows));
    await useBuilderStore.getState().syncFromRunner();

    useBuilderStore.getState().saveFlow();

    expect(vi.mocked(serverRunner.putWorkflow)).toHaveBeenCalledTimes(2);
    const putIds = vi.mocked(serverRunner.putWorkflow).mock.calls.map((c) => c[0].id).sort();
    expect(putIds).toEqual(['srv-a', 'srv-b']);
  });

  it('saveFlow does not PUT while the workspace is local', () => {
    useBuilderStore.getState().saveFlow();
    expect(vi.mocked(serverRunner.putWorkflow)).not.toHaveBeenCalled();
  });

  it('summaries() carries path/http from the operations array', async () => {
    const flows = [serverFlow('claims/claims/create', 'Create'), serverFlow('billing/charge', 'Charge')];
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValue(
      payload(flows, [
        { id: 'claims/claims/create', name: 'Create', path: 'claims/claims/create', http: { method: 'POST', path: '/claims' } },
        { id: 'billing/charge', name: 'Charge', path: 'billing/charge' },
      ]),
    );

    await useBuilderStore.getState().syncFromRunner();

    const summaries = useBuilderStore.getState().workflows;
    const create = summaries.find((s) => s.id === 'claims/claims/create')!;
    expect(create.path).toBe('claims/claims/create');
    expect(create.http).toEqual({ method: 'POST', path: '/claims' });
    const charge = summaries.find((s) => s.id === 'billing/charge')!;
    expect(charge.path).toBe('billing/charge');
    expect(charge.http).toBeUndefined();
  });

  it('createOperation posts a new flow at the api/folder/slug path with matching http, then refreshes and selects it', async () => {
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValue(
      payload([serverFlow('claims/claims/create-claim', 'Create Claim')], [
        {
          id: 'claims/claims/create-claim',
          name: 'Create Claim',
          path: 'claims/claims/create-claim',
          http: { method: 'POST', path: '/claims' },
        },
      ]),
    );

    const result = await useBuilderStore.getState().createOperation({
      api: 'claims',
      folder: 'claims',
      name: 'Create Claim',
      method: 'POST',
      httpPath: '/claims',
    });

    expect(result).toEqual({ ok: true });
    expect(vi.mocked(serverRunner.createOperationOnServer)).toHaveBeenCalledTimes(1);
    const [savedFlow, savedPath] = vi.mocked(serverRunner.createOperationOnServer).mock.calls[0];
    expect(savedPath).toBe('claims/claims/create-claim');
    expect(savedFlow.id).toBe('claims/claims/create-claim');
    expect(savedFlow.http).toEqual({ method: 'POST', path: '/claims' });
    expect(savedFlow.nodes.some((n) => n.type === 'Response')).toBe(true);

    expect(vi.mocked(serverRunner.fetchWorkflows)).toHaveBeenCalled();
    const state = useBuilderStore.getState();
    expect(state.flow.id).toBe('claims/claims/create-claim');
  });

  it('createOperation surfaces the collision error and does not refresh/switch when the server refuses an existing path (409)', async () => {
    vi.mocked(serverRunner.createOperationOnServer).mockResolvedValue({
      ok: false,
      error: 'operation already exists at billing/charge',
    });

    const result = await useBuilderStore.getState().createOperation({ api: 'billing', name: 'Charge' });

    expect(result).toEqual({ ok: false, error: 'operation already exists at billing/charge' });
    expect(vi.mocked(serverRunner.fetchWorkflows)).not.toHaveBeenCalled();
  });
});

describe('builderStore run history', () => {
  const fakeRun = (id: string, flowId: string) => ({
    id,
    workflowId: flowId,
    status: 'succeeded' as const,
    startedAt: '2026-07-02T10:00:00Z',
    completedAt: '2026-07-02T10:00:02Z',
    nodeStates: {},
  });

  beforeEach(() => {
    useBuilderStore.setState({
      flow: createLoginFlow(),
      run: null,
      logs: [],
      activeRun: null,
      runHistory: [],
    });
  });

  it('recordRun prepends to history', () => {
    const flowId = useBuilderStore.getState().flow.id;
    useBuilderStore.getState().recordRun(fakeRun('r1', flowId));
    useBuilderStore.getState().recordRun(fakeRun('r2', flowId));
    expect(useBuilderStore.getState().runHistory.map((r) => r.id)).toEqual(['r2', 'r1']);
  });

  it('viewRun sets the run snapshot and restores its logs', () => {
    const flowId = useBuilderStore.getState().flow.id;
    useBuilderStore.setState({
      logs: [{ timestamp: 't', level: 'info', runId: 'r1', message: 'hello' }],
    });
    useBuilderStore.getState().recordRun(fakeRun('r1', flowId));
    useBuilderStore.setState({ logs: [] });
    useBuilderStore.getState().viewRun('r1');
    expect(useBuilderStore.getState().run?.id).toBe('r1');
    expect(useBuilderStore.getState().logs.map((l) => l.message)).toEqual(['hello']);
  });

  it('history for another flow is not shown by historyForActiveFlow', () => {
    const flowId = useBuilderStore.getState().flow.id;
    useBuilderStore.getState().recordRun(fakeRun('r1', flowId));
    useBuilderStore.getState().recordRun(fakeRun('r2', 'other-flow'));
    const visible = useBuilderStore
      .getState()
      .runHistory.filter((r) => r.workflowId === flowId);
    expect(visible.map((r) => r.id)).toEqual(['r1']);
  });
});

describe('builderStore scenarios', () => {
  beforeEach(() => {
    vi.mocked(serverRunner.startServerRun).mockReset().mockResolvedValue('run-s');
    vi.mocked(serverRunner.subscribeServerRun).mockReset().mockImplementation(() => () => {});
    // Start from a scenario-free flow: the seeded examples would offset counts.
    const flow = createLoginFlow();
    delete flow.scenarios;
    useBuilderStore.setState({
      flow,
      run: null,
      logs: [],
      activeRun: null,
      activeServerRunId: null,
      runHistory: [],
      activeScenarioId: null,
      runnerOnline: true,
    });
  });

  it('scenario CRUD mutates flow.scenarios', () => {
    useBuilderStore
      .getState()
      .addScenario('new user', { username: 'newton', password: 'apple123' }, 'welcome branch');
    const scenarios = useBuilderStore.getState().flow.scenarios!;
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].description).toBe('welcome branch');

    const id = scenarios[0].id;
    useBuilderStore.getState().updateScenario(id, { name: 'brand new user' });
    expect(useBuilderStore.getState().flow.scenarios![0].name).toBe('brand new user');

    useBuilderStore.getState().removeScenario(id);
    expect(useBuilderStore.getState().flow.scenarios).toBeUndefined();
  });

  it('runScenario starts a server run with the scenario payload + name and tags history', async () => {
    let capturedHandlers: ServerRunHandlers | undefined;
    vi.mocked(serverRunner.subscribeServerRun).mockImplementation((_runId, handlers) => {
      capturedHandlers = handlers;
      return () => {};
    });
    useBuilderStore
      .getState()
      .addScenario('new user', { username: 'newton', password: 'apple123' });
    const id = useBuilderStore.getState().flow.scenarios![0].id;

    await useBuilderStore.getState().runScenario(id);

    const call = vi.mocked(serverRunner.startServerRun).mock.calls[0];
    expect(call[1]).toBe('run');
    expect(call[3]).toEqual({ username: 'newton', password: 'apple123' });
    expect(call[4]).toMatchObject({ scenarioName: 'new user' });

    const flowId = useBuilderStore.getState().flow.id;
    capturedHandlers!.onFinished({
      id: 'run-s',
      workflowId: flowId,
      status: 'succeeded',
      startedAt: '2026-07-10T10:00:00Z',
      completedAt: '2026-07-10T10:00:01Z',
      nodeStates: {},
    });
    expect(useBuilderStore.getState().runHistory[0].scenarioName).toBe('new user');
  });

  it('a plain run after a scenario run is not tagged', async () => {
    const handlersByRun: Record<string, ServerRunHandlers> = {};
    vi.mocked(serverRunner.subscribeServerRun).mockImplementation((runId, handlers) => {
      handlersByRun[runId] = handlers;
      return () => {};
    });
    useBuilderStore
      .getState()
      .addScenario('new user', { username: 'newton', password: 'apple123' });
    const id = useBuilderStore.getState().flow.scenarios![0].id;
    const flowId = useBuilderStore.getState().flow.id;

    vi.mocked(serverRunner.startServerRun).mockResolvedValueOnce('run-a');
    await useBuilderStore.getState().runScenario(id);
    handlersByRun['run-a'].onFinished({
      id: 'run-a', workflowId: flowId, status: 'succeeded',
      startedAt: '2026-07-10T10:00:00Z', completedAt: '2026-07-10T10:00:01Z', nodeStates: {},
    });

    vi.mocked(serverRunner.startServerRun).mockResolvedValueOnce('run-b');
    await useBuilderStore.getState().runToEnd();
    handlersByRun['run-b'].onFinished({
      id: 'run-b', workflowId: flowId, status: 'succeeded',
      startedAt: '2026-07-10T10:00:02Z', completedAt: '2026-07-10T10:00:03Z', nodeStates: {},
    });
    expect(useBuilderStore.getState().runHistory[0].scenarioName).toBeUndefined();
  });
});

describe('builderStore environments + safe mode', () => {
  const env = (name: string, isProtected: boolean) => ({
    name,
    protected: isProtected,
    varKeys: [],
    secretKeys: [],
  });

  beforeEach(() => {
    useBuilderStore.setState({
      environments: [env('local', false), env('prod', true)],
      environmentsDefault: 'local',
      selectedEnvironment: 'local',
      safeMode: true,
    });
  });

  it('selectEnvironment forces safe mode on protected environments', () => {
    useBuilderStore.getState().setSafeMode(true);
    useBuilderStore.getState().selectEnvironment('prod');
    expect(useBuilderStore.getState().selectedEnvironment).toBe('prod');
    expect(useBuilderStore.getState().safeMode).toBe(true);
  });

  it('selectEnvironment leaves safe mode alone on unprotected environments', () => {
    useBuilderStore.setState({ safeMode: false, selectedEnvironment: 'prod' });
    useBuilderStore.getState().selectEnvironment('local');
    expect(useBuilderStore.getState().safeMode).toBe(false);
  });

  it('setSafeMode refuses to disable on a protected env without a matching confirm', () => {
    useBuilderStore.setState({ selectedEnvironment: 'prod', safeMode: true });
    expect(useBuilderStore.getState().setSafeMode(false)).toBe(false);
    expect(useBuilderStore.getState().setSafeMode(false, 'nope')).toBe(false);
    expect(useBuilderStore.getState().safeMode).toBe(true);

    expect(useBuilderStore.getState().setSafeMode(false, 'prod')).toBe(true);
    expect(useBuilderStore.getState().safeMode).toBe(false);
  });

  it('setSafeMode disables freely on an unprotected env', () => {
    useBuilderStore.setState({ selectedEnvironment: 'local', safeMode: true });
    expect(useBuilderStore.getState().setSafeMode(false)).toBe(true);
    expect(useBuilderStore.getState().safeMode).toBe(false);
  });

  it('switching flows reverts an unsafe-on-protected session to safe', () => {
    useBuilderStore.setState({ selectedEnvironment: 'prod', safeMode: false });
    const loginId = useBuilderStore.getState().flow.id;
    useBuilderStore.getState().createWorkflow();
    useBuilderStore.getState().switchWorkflow(loginId);
    expect(useBuilderStore.getState().safeMode).toBe(true);
  });

  it('fetchEnvironments falls back to the default when the selection is unknown', async () => {
    vi.mocked(serverRunner.listEnvironments).mockResolvedValue({
      defaultEnvironment: 'local',
      environments: [env('local', false), env('prod', true)],
    });
    useBuilderStore.setState({ selectedEnvironment: 'gone' });
    await useBuilderStore.getState().fetchEnvironments();
    expect(useBuilderStore.getState().selectedEnvironment).toBe('local');
    expect(useBuilderStore.getState().environments).toHaveLength(2);
  });

  it('fetchEnvironments clears the list when the runner is offline', async () => {
    vi.mocked(serverRunner.listEnvironments).mockResolvedValue(null);
    await useBuilderStore.getState().fetchEnvironments();
    expect(useBuilderStore.getState().environments).toEqual([]);
    expect(useBuilderStore.getState().environmentsDefault).toBe('');
  });

  it('loginEnvironment calls the client then re-fetches so authenticated flips true', async () => {
    useBuilderStore.setState({
      environments: [
        { ...env('dev', false), auth: { configured: true, authenticated: false, secretRef: 'dev-token' } },
      ],
      environmentsDefault: 'dev',
      selectedEnvironment: 'dev',
    });
    vi.mocked(serverRunner.loginEnvironment).mockResolvedValue(undefined);
    vi.mocked(serverRunner.listEnvironments).mockResolvedValue({
      defaultEnvironment: 'dev',
      environments: [
        { ...env('dev', false), auth: { configured: true, authenticated: true, secretRef: 'dev-token' } },
      ],
    });

    await useBuilderStore.getState().loginEnvironment('dev');

    expect(vi.mocked(serverRunner.loginEnvironment)).toHaveBeenCalledWith('dev');
    expect(vi.mocked(serverRunner.listEnvironments)).toHaveBeenCalled();
    expect(useBuilderStore.getState().environments.find((e) => e.name === 'dev')?.auth?.authenticated).toBe(true);
  });

  it('setEnvironmentSecret calls the client then re-fetches environments', async () => {
    useBuilderStore.setState({
      environments: [env('dev', false)],
      environmentsDefault: 'dev',
      selectedEnvironment: 'dev',
    });
    vi.mocked(serverRunner.setEnvironmentSecret).mockResolvedValue(undefined);
    vi.mocked(serverRunner.listEnvironments).mockResolvedValue({
      defaultEnvironment: 'dev',
      environments: [{ ...env('dev', false), secretKeys: ['k'] }],
    });

    await useBuilderStore.getState().setEnvironmentSecret('dev', 'k', 'v');

    expect(vi.mocked(serverRunner.setEnvironmentSecret)).toHaveBeenCalledWith('dev', 'k', 'v');
    expect(vi.mocked(serverRunner.listEnvironments)).toHaveBeenCalled();
    expect(useBuilderStore.getState().environments.find((e) => e.name === 'dev')?.secretKeys).toEqual(['k']);
  });

  it('deleteEnvironmentSecret calls the client then re-fetches environments', async () => {
    useBuilderStore.setState({
      environments: [{ ...env('dev', false), secretKeys: ['k'] }],
      environmentsDefault: 'dev',
      selectedEnvironment: 'dev',
    });
    vi.mocked(serverRunner.deleteEnvironmentSecret).mockResolvedValue(undefined);
    vi.mocked(serverRunner.listEnvironments).mockResolvedValue({
      defaultEnvironment: 'dev',
      environments: [env('dev', false)],
    });

    await useBuilderStore.getState().deleteEnvironmentSecret('dev', 'k');

    expect(vi.mocked(serverRunner.deleteEnvironmentSecret)).toHaveBeenCalledWith('dev', 'k');
    expect(vi.mocked(serverRunner.listEnvironments)).toHaveBeenCalled();
    expect(useBuilderStore.getState().environments.find((e) => e.name === 'dev')?.secretKeys).toEqual([]);
  });

  it('setEnvironmentAuth calls the client then re-fetches so configured flips true', async () => {
    useBuilderStore.setState({
      environments: [env('dev', false)],
      environmentsDefault: 'dev',
      selectedEnvironment: 'dev',
    });
    const auth = { attach: { as: 'header' as const, name: 'Authorization', secretRef: 'dev-token' } };
    vi.mocked(serverRunner.setEnvironmentAuth).mockResolvedValue(undefined);
    vi.mocked(serverRunner.listEnvironments).mockResolvedValue({
      defaultEnvironment: 'dev',
      environments: [
        { ...env('dev', false), auth: { configured: true, authenticated: false, secretRef: 'dev-token', config: auth } },
      ],
    });

    await useBuilderStore.getState().setEnvironmentAuth('dev', auth);

    expect(vi.mocked(serverRunner.setEnvironmentAuth)).toHaveBeenCalledWith('dev', auth);
    expect(vi.mocked(serverRunner.listEnvironments)).toHaveBeenCalled();
    expect(useBuilderStore.getState().environments.find((e) => e.name === 'dev')?.auth?.configured).toBe(true);
  });
});

describe('builderStore agent picker', () => {
  beforeEach(() => {
    vi.mocked(agentClient.startAgent).mockClear().mockResolvedValue('run-1');
    useBuilderStore.setState({ agentChoice: {}, agentRun: null });
  });

  it('runAgent threads the persisted agentChoice to startAgent when called with no opts', async () => {
    useBuilderStore.getState().setAgentChoice({ agent: 'codex', model: 'gpt-x' });
    await useBuilderStore.getState().runAgent({ action: 'edit-flow', flowId: 'f1', instruction: 'go' });
    expect(agentClient.startAgent).toHaveBeenCalledWith(
      { action: 'edit-flow', flowId: 'f1', instruction: 'go' },
      { agent: 'codex', model: 'gpt-x' },
    );
  });

  it('runAgent prefers explicit opts over the persisted choice', async () => {
    useBuilderStore.getState().setAgentChoice({ agent: 'codex', model: 'gpt-x' });
    await useBuilderStore
      .getState()
      .runAgent({ action: 'edit-flow', flowId: 'f1', instruction: 'go' }, { model: 'other' });
    expect(agentClient.startAgent).toHaveBeenCalledWith(expect.anything(), { model: 'other' });
  });

  it('beginInfrastructureScout: a leaked MouseEvent (onClick wiring) falls back to the full-rescan instruction', () => {
    // Regression: the Dock's scout button once passed the click event as
    // `instruction`, crashing on instruction.trim(). Non-strings = full rescan.
    useBuilderStore.getState().beginInfrastructureScout(
      { type: 'click' } as unknown as string,
    );
    expect(agentClient.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'scout-infrastructure',
        instruction: expect.stringContaining('Scan this project'),
      }),
      expect.anything(),
    );
  });

  it('beginInfrastructureScout: a real instruction threads verbatim', () => {
    useBuilderStore.getState().beginInfrastructureScout('add our Redis cache');
    expect(agentClient.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: 'add our Redis cache' }),
      expect.anything(),
    );
  });

  it('on agent run finish, fetches a scenario verdict for each touched operation', async () => {
    vi.mocked(serverRunner.testWorkflow).mockReset().mockResolvedValue({ results: [], passed: 2, failed: 0, skipped: 0 });
    vi.mocked(serverRunner.runnerHealthy).mockReset().mockResolvedValue({ online: true, mock: true });
    vi.mocked(serverRunner.fetchWorkflows).mockReset().mockResolvedValue(null);
    vi.mocked(agentClient.fetchAgentDiff)
      .mockReset()
      .mockResolvedValue({ diff: 'd', files: ['emberflow/apis/billing/charge.json'] });
    let onDone: ((event: agentClient.AgentEvent) => void) | undefined;
    vi.mocked(agentClient.streamAgent)
      .mockReset()
      .mockImplementation((_runId, onEvent) => {
        onDone = onEvent;
        return () => {};
      });

    await useBuilderStore.getState().runAgent({ action: 'edit-flow', flowId: 'f1', instruction: 'go' });
    onDone?.({ type: 'done' });

    // finish('done') runs its async work off the synchronous event callback.
    await vi.waitFor(() => {
      expect(useBuilderStore.getState().agentRun?.verdicts?.['billing/charge']).toBeDefined();
    });

    expect(useBuilderStore.getState().agentRun?.verdicts?.['billing/charge']).toEqual({
      results: [],
      passed: 2,
      failed: 0,
      skipped: 0,
    });

    // Safety regression guard: this fetch is automatic (no user click), so it
    // must always run in mock mode — never touch real infrastructure/secrets.
    expect(vi.mocked(serverRunner.testWorkflow)).toHaveBeenCalledWith('billing/charge', undefined, true);
  });

  it('startAgent-catch does not clobber a different, still-running agentRun slot', async () => {
    // Seed a live run in slot A.
    useBuilderStore.setState({
      agentRun: { id: 'run-A', events: [], status: 'running' },
    });
    vi.mocked(agentClient.startAgent).mockClear().mockRejectedValueOnce(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // A second, unrelated runAgent call fails to start — this must not
    // stomp the still-running run-A slot with an 'error' state (the T4
    // ledgered race: a start failure racing a live run).
    await useBuilderStore.getState().runAgent({ action: 'edit-flow', flowId: 'f2', instruction: 'go' });

    expect(useBuilderStore.getState().agentRun).toEqual({ id: 'run-A', events: [], status: 'running' });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('mid-run steering', () => {
  beforeEach(() => {
    vi.mocked(agentClient.startAgent).mockClear().mockResolvedValue('run-1');
    vi.mocked(serverRunner.fetchWorkflows).mockReset().mockResolvedValue(null);
    vi.mocked(serverRunner.runnerHealthy).mockReset().mockResolvedValue({ online: true, mock: true });
    vi.mocked(agentClient.fetchAgentDiff).mockReset().mockResolvedValue({ diff: '', files: [] });
    useBuilderStore.setState({ agentChoice: {}, agentRun: null, steerQueue: null });
  });

  it('queueSteer during a running agent run holds the text and dispatches it as the next run on finish', async () => {
    let onEvent: ((event: agentClient.AgentEvent) => void) | undefined;
    vi.mocked(agentClient.streamAgent)
      .mockReset()
      .mockImplementation((_runId, handler) => {
        onEvent = handler;
        return () => {};
      });

    await useBuilderStore.getState().runAgent({ action: 'edit-flow', flowId: 'f1', instruction: 'go' });
    expect(useBuilderStore.getState().agentRun?.status).toBe('running');

    useBuilderStore.getState().queueSteer('also add rate limiting');
    expect(useBuilderStore.getState().steerQueue).toBe('also add rate limiting');

    onEvent?.({ type: 'done' });

    await vi.waitFor(() => {
      expect(vi.mocked(agentClient.startAgent).mock.calls.length).toBe(2);
    });

    expect(vi.mocked(agentClient.startAgent).mock.calls[1][0]).toEqual({
      action: 'edit-flow',
      flowId: 'f1',
      instruction: 'also add rate limiting',
    });
    expect(useBuilderStore.getState().steerQueue).toBeNull();
  });

  it('steer queued during a build-api run re-dispatches via buildApi, restoring buildingApiLocation', async () => {
    let onEvent: ((event: agentClient.AgentEvent) => void) | undefined;
    vi.mocked(agentClient.streamAgent)
      .mockReset()
      .mockImplementation((_runId, handler) => {
        onEvent = handler;
        return () => {};
      });

    await useBuilderStore.getState().runAgent({ action: 'build-api', location: 'billing', instruction: 'build it' });
    expect(useBuilderStore.getState().agentRun?.status).toBe('running');

    useBuilderStore.getState().queueSteer('also add refunds');
    onEvent?.({ type: 'done' });

    await vi.waitFor(() => {
      expect(vi.mocked(agentClient.startAgent).mock.calls.length).toBe(2);
    });

    expect(vi.mocked(agentClient.startAgent).mock.calls[1][0]).toEqual({
      action: 'build-api',
      location: 'billing',
      instruction: 'Continuing the same build. The user added while you worked: also add refunds',
    });
    expect(useBuilderStore.getState().steerQueue).toBeNull();
    // The continuation must go through buildApi (not a raw runAgent) so the
    // holding view/canvas-follow state is re-armed for the follow-up run —
    // finish() clears buildingApiLocation, but the dispatch above should have
    // set it right back.
    expect(useBuilderStore.getState().buildingApiLocation).toBe('billing');
  });

  it('prefixes the follow-up instruction with failure context when the finished run errored', async () => {
    let onEvent: ((event: agentClient.AgentEvent) => void) | undefined;
    vi.mocked(agentClient.streamAgent)
      .mockReset()
      .mockImplementation((_runId, handler) => {
        onEvent = handler;
        return () => {};
      });

    await useBuilderStore.getState().runAgent({ action: 'edit-flow', flowId: 'f1', instruction: 'go' });
    useBuilderStore.getState().queueSteer('try a different approach');
    onEvent?.({ type: 'error', text: 'boom' });

    await vi.waitFor(() => {
      expect(vi.mocked(agentClient.startAgent).mock.calls.length).toBe(2);
    });

    expect(vi.mocked(agentClient.startAgent).mock.calls[1][0]).toEqual({
      action: 'edit-flow',
      flowId: 'f1',
      instruction: 'The previous attempt failed partway. try a different approach',
    });
  });

  it('dispatches a setup-environments follow-up (with failure prefix) instead of dropping the queued steer', async () => {
    let onEvent: ((event: agentClient.AgentEvent) => void) | undefined;
    vi.mocked(agentClient.streamAgent)
      .mockReset()
      .mockImplementation((_runId, handler) => {
        onEvent = handler;
        return () => {};
      });

    await useBuilderStore.getState().runAgent({ action: 'setup-environments', instruction: 'set up dev + prod' });
    useBuilderStore.getState().queueSteer('also add a staging env');
    onEvent?.({ type: 'done' });

    await vi.waitFor(() => {
      expect(vi.mocked(agentClient.startAgent).mock.calls.length).toBe(2);
    });

    expect(vi.mocked(agentClient.startAgent).mock.calls[1][0]).toEqual({
      action: 'setup-environments',
      instruction: 'also add a staging env',
    });
    expect(useBuilderStore.getState().steerQueue).toBeNull();
  });

  it('queueSteer with an empty/whitespace string clears the queue', () => {
    useBuilderStore.setState({ steerQueue: 'pending text' });
    useBuilderStore.getState().queueSteer('   ');
    expect(useBuilderStore.getState().steerQueue).toBeNull();
  });

  it('queueSteer appends to an existing queue instead of replacing it', () => {
    useBuilderStore.setState({ steerQueue: null });
    useBuilderStore.getState().queueSteer('first note');
    expect(useBuilderStore.getState().steerQueue).toBe('first note');
    useBuilderStore.getState().queueSteer('second note');
    expect(useBuilderStore.getState().steerQueue).toBe('first note\nsecond note');
  });

  it('a steer queued during an ask run scoped to a flow dispatches an edit-flow follow-up', async () => {
    let onEvent: ((event: agentClient.AgentEvent) => void) | undefined;
    vi.mocked(agentClient.streamAgent)
      .mockReset()
      .mockImplementation((_runId, handler) => {
        onEvent = handler;
        return () => {};
      });

    await useBuilderStore.getState().runAgent({ action: 'ask', flowId: 'f1', instruction: 'what does this do?' });
    useBuilderStore.getState().queueSteer('now add rate limiting');
    onEvent?.({ type: 'done' });

    await vi.waitFor(() => {
      expect(vi.mocked(agentClient.startAgent).mock.calls.length).toBe(2);
    });

    expect(vi.mocked(agentClient.startAgent).mock.calls[1][0]).toEqual({
      action: 'edit-flow',
      flowId: 'f1',
      instruction: 'now add rate limiting',
    });
    expect(useBuilderStore.getState().steerQueue).toBeNull();
  });

  it('a steer queued during a flowId-less ask run is preserved, not dropped, on finish', async () => {
    let onEvent: ((event: agentClient.AgentEvent) => void) | undefined;
    vi.mocked(agentClient.streamAgent)
      .mockReset()
      .mockImplementation((_runId, handler) => {
        onEvent = handler;
        return () => {};
      });

    await useBuilderStore.getState().runAgent({ action: 'ask', instruction: 'what does this project do?' });
    useBuilderStore.getState().queueSteer('now add rate limiting');
    onEvent?.({ type: 'done' });

    // No obvious continuation target for a flowId-less ask — only the
    // original run's startAgent call should have happened, and the queued
    // text must survive rather than being silently cleared.
    await vi.waitFor(() => {
      expect(useBuilderStore.getState().agentRun?.status).toBe('done');
    });
    expect(vi.mocked(agentClient.startAgent).mock.calls.length).toBe(1);
    expect(useBuilderStore.getState().steerQueue).toBe('now add rate limiting');
  });

  it('a preserved steerQueue from a flowId-less ask does not leak into a later unrelated run', async () => {
    let onEventA: ((event: agentClient.AgentEvent) => void) | undefined;
    vi.mocked(agentClient.streamAgent)
      .mockReset()
      .mockImplementation((_runId, handler) => {
        onEventA = handler;
        return () => {};
      });

    // Run A: flowId-less ask, with a queued steer that has no continuation
    // target — finish() preserves it (see test above).
    await useBuilderStore.getState().runAgent({ action: 'ask', instruction: 'what does this project do?' });
    useBuilderStore.getState().queueSteer('now add rate limiting');
    onEventA?.({ type: 'done' });
    await vi.waitFor(() => {
      expect(useBuilderStore.getState().agentRun?.status).toBe('done');
    });
    expect(useBuilderStore.getState().steerQueue).toBe('now add rate limiting');

    // Run B: an unrelated run started from any launch button (edit-flow on a
    // different flow). The stale queue from run A must not survive into it.
    let onEventB: ((event: agentClient.AgentEvent) => void) | undefined;
    vi.mocked(agentClient.streamAgent)
      .mockReset()
      .mockImplementation((_runId, handler) => {
        onEventB = handler;
        return () => {};
      });
    vi.mocked(agentClient.startAgent).mockClear().mockResolvedValue('run-2');

    const runBPromise = useBuilderStore.getState().runAgent({ action: 'edit-flow', flowId: 'f2', instruction: 'go' });
    // Cleared synchronously at the top of runAgent, before B's own startAgent
    // call resolves.
    expect(useBuilderStore.getState().steerQueue).toBeNull();
    await runBPromise;

    onEventB?.({ type: 'done' });
    await vi.waitFor(() => {
      expect(useBuilderStore.getState().agentRun?.status).toBe('done');
    });

    // B's finish() must not dispatch a follow-up from A's stale text: only
    // B's own startAgent call happened.
    expect(vi.mocked(agentClient.startAgent).mock.calls.length).toBe(1);
    expect(vi.mocked(agentClient.startAgent).mock.calls[0][0]).toEqual({
      action: 'edit-flow',
      flowId: 'f2',
      instruction: 'go',
    });
    expect(useBuilderStore.getState().steerQueue).toBeNull();
  });
});

describe('builderStore buildApi', () => {
  beforeEach(() => {
    vi.mocked(agentClient.startAgent).mockClear().mockResolvedValue('run-1');
    vi.mocked(serverRunner.createOperationOnServer).mockClear();
    useBuilderStore.setState({ agentChoice: {}, agentRun: null, buildingApiLocation: null });
  });

  it('sets buildingApiLocation and commissions a build-api run — no stub operation is pre-created', () => {
    useBuilderStore.getState().buildApi({ location: 'billing', goal: 'draft, send, and track invoices' });

    expect(useBuilderStore.getState().buildingApiLocation).toBe('billing');
    expect(agentClient.startAgent).toHaveBeenCalledWith(
      { action: 'build-api', location: 'billing', instruction: 'draft, send, and track invoices' },
      expect.anything(),
    );
    // The whole point vs createAndBuild: the agent owns the surface, so no
    // stub is stood up before the run.
    expect(serverRunner.createOperationOnServer).not.toHaveBeenCalled();
  });
});

describe('builderStore build ledger', () => {
  const opFlow = (id: string, name: string): WorkflowDefinition => ({
    id,
    name,
    version: 1,
    nodes: [],
    edges: [],
    createdAt: '2026-07-02T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
  });
  const payload = (flows: WorkflowDefinition[]): serverRunner.WorkflowsPayload => ({ flows, operations: [] });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(agentClient.startAgent).mockClear().mockResolvedValue('run-1');
    vi.mocked(serverRunner.fetchWorkflows).mockReset();
    vi.mocked(serverRunner.runnerHealthy).mockReset().mockResolvedValue({ online: true, mock: true });
    vi.mocked(agentClient.fetchAgentDiff).mockReset().mockResolvedValue({ diff: '', files: [] });
    useBuilderStore.setState({
      agentChoice: {},
      agentRun: null,
      buildingApiLocation: null,
      buildLedger: null,
      flow: opFlow('other/root', 'Other'),
      shelf: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks ops building/done tick by tick, then all done on finish, cleared only when the next run starts', async () => {
    let onEvent: ((event: agentClient.AgentEvent) => void) | undefined;
    vi.mocked(agentClient.streamAgent)
      .mockReset()
      .mockImplementation((_runId, handler) => {
        onEvent = handler;
        return () => {};
      });

    // Tick 1: baseline — op A is already there when the location comes into
    // view (e.g. a pre-existing op). It seeds prevSerialized but writes no
    // ledger entry.
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValueOnce(
      payload([opFlow('other/root', 'Other'), opFlow('goinsights/a', 'A v1')]),
    );

    useBuilderStore.setState({ buildingApiLocation: 'goinsights' });
    await useBuilderStore
      .getState()
      .runAgent({ action: 'build-api', location: 'goinsights', instruction: 'build it' });

    await vi.advanceTimersByTimeAsync(2000);
    expect(useBuilderStore.getState().buildLedger).toEqual({});

    // Tick 2: op A is unchanged (still no entry — it was never 'building'),
    // op B is new since the baseline tick.
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValueOnce(
      payload([opFlow('other/root', 'Other'), opFlow('goinsights/a', 'A v1'), opFlow('goinsights/b', 'B v1')]),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(useBuilderStore.getState().buildLedger).toEqual({
      'goinsights/b': 'building',
    });

    // Tick 3: op B is unchanged since tick 2 (was 'building') -> 'done'.
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValueOnce(
      payload([opFlow('other/root', 'Other'), opFlow('goinsights/a', 'A v1'), opFlow('goinsights/b', 'B v1')]),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(useBuilderStore.getState().buildLedger).toEqual({
      'goinsights/b': 'done',
    });

    // Finish: everything flips to done, and stays around (not cleared).
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValue(null);
    onEvent?.({ type: 'done' });
    await vi.waitFor(() => {
      expect(useBuilderStore.getState().agentRun?.status).toBe('done');
    });
    expect(useBuilderStore.getState().buildLedger).toEqual({
      'goinsights/b': 'done',
    });

    // A new run clears the ledger at the start, before any poll tick lands.
    await useBuilderStore.getState().runAgent({ action: 'edit-flow', flowId: 'other/root', instruction: 'go' });
    expect(useBuilderStore.getState().buildLedger).toBeNull();
  });

  it('a pre-existing op under the location is not misclassified as building, but IS tracked once the agent edits it', async () => {
    let onEvent: ((event: agentClient.AgentEvent) => void) | undefined;
    vi.mocked(agentClient.streamAgent)
      .mockReset()
      .mockImplementation((_runId, handler) => {
        onEvent = handler;
        return () => {};
      });

    // Tick 1 (baseline): 'goinsights/existing' predates this run (e.g. the
    // CommandBar building into a location that already has ops).
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValueOnce(
      payload([opFlow('goinsights/existing', 'Existing v1')]),
    );
    useBuilderStore.setState({ buildingApiLocation: 'goinsights' });
    await useBuilderStore
      .getState()
      .runAgent({ action: 'build-api', location: 'goinsights', instruction: 'build it' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(useBuilderStore.getState().buildLedger).toEqual({});

    // Tick 2: the agent adds a brand-new op. The pre-existing op is still
    // unchanged and untouched — only the new op is 'building'.
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValueOnce(
      payload([opFlow('goinsights/existing', 'Existing v1'), opFlow('goinsights/new', 'New v1')]),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(useBuilderStore.getState().buildLedger).toEqual({
      'goinsights/new': 'building',
    });

    // Tick 3: the agent now edits the pre-existing op — its serialized form
    // changes, so it becomes 'building'. The new op is unchanged since tick
    // 2 (was 'building') -> 'done'.
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValueOnce(
      payload([opFlow('goinsights/existing', 'Existing v2'), opFlow('goinsights/new', 'New v1')]),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(useBuilderStore.getState().buildLedger).toEqual({
      'goinsights/existing': 'building',
      'goinsights/new': 'done',
    });

    // Tick 4: the pre-existing op is unchanged since tick 3 (was 'building')
    // -> 'done'.
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValueOnce(
      payload([opFlow('goinsights/existing', 'Existing v2'), opFlow('goinsights/new', 'New v1')]),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(useBuilderStore.getState().buildLedger).toEqual({
      'goinsights/existing': 'done',
      'goinsights/new': 'done',
    });

    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValue(null);
    onEvent?.({ type: 'done' });
    await vi.waitFor(() => {
      expect(useBuilderStore.getState().agentRun?.status).toBe('done');
    });
  });

  it('an error finish drops still-building entries but keeps already-done ones', async () => {
    let onEvent: ((event: agentClient.AgentEvent) => void) | undefined;
    vi.mocked(agentClient.streamAgent)
      .mockReset()
      .mockImplementation((_runId, handler) => {
        onEvent = handler;
        return () => {};
      });

    // Tick 1 (baseline). pollOnce bails out early on an empty flows array, so
    // this needs at least one flow (outside the built location) to reach the
    // ledger-seeding code.
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValueOnce(payload([opFlow('other/root', 'Other')]));
    useBuilderStore.setState({ buildingApiLocation: 'goinsights' });
    await useBuilderStore
      .getState()
      .runAgent({ action: 'build-api', location: 'goinsights', instruction: 'build it' });
    await vi.advanceTimersByTimeAsync(2000);

    // Tick 2: op A appears (new -> building), op B appears (new -> building).
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValueOnce(
      payload([opFlow('goinsights/a', 'A v1'), opFlow('goinsights/b', 'B v1')]),
    );
    await vi.advanceTimersByTimeAsync(2000);

    // Tick 3: op A settles (unchanged -> done). Op B is still being edited
    // (changed -> stays building).
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValueOnce(
      payload([opFlow('goinsights/a', 'A v1'), opFlow('goinsights/b', 'B v2')]),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(useBuilderStore.getState().buildLedger).toEqual({
      'goinsights/a': 'done',
      'goinsights/b': 'building',
    });

    // The agent run errors out mid-edit of op B.
    vi.mocked(serverRunner.fetchWorkflows).mockResolvedValue(null);
    onEvent?.({ type: 'error', text: 'boom' });
    await vi.waitFor(() => {
      expect(useBuilderStore.getState().agentRun?.status).toBe('error');
    });
    expect(useBuilderStore.getState().buildLedger).toEqual({
      'goinsights/a': 'done',
    });
  });
});

describe('builderStore guided setup transcript', () => {
  beforeEach(() => {
    vi.mocked(agentClient.startAgent).mockClear().mockResolvedValue('run-1');
    useBuilderStore.setState({ agentChoice: {}, agentRun: null, guidedTranscript: [] });
  });

  const QUESTION_TEXT =
    'Two things to decide.\n\n' +
    '```emberflow-questions\n{"questions":[{"id":"envs","text":"Which environments?","options":["dev + prod"]}]}\n```\n';

  it('continuation: appends the prior guided run (question blocks stripped) + a **You:** message', () => {
    useBuilderStore.setState({
      guidedTranscript: [{ type: 'message', text: 'Earlier turn.' }],
      agentRun: {
        id: 'run-0',
        status: 'done',
        guided: true,
        events: [
          { type: 'message', text: 'Reading the ground truth first.' },
          { type: 'command', command: 'git status', commandStatus: 'completed' },
          { type: 'message', text: QUESTION_TEXT },
        ],
      },
    });

    useBuilderStore.getState().beginGuidedSetup('Which environments?: dev + prod');

    expect(useBuilderStore.getState().guidedTranscript).toEqual([
      { type: 'message', text: 'Earlier turn.' },
      { type: 'message', text: 'Reading the ground truth first.' },
      { type: 'command', command: 'git status', commandStatus: 'completed' },
      // The answered question block is stripped — only the prose survives.
      { type: 'message', text: 'Two things to decide.' },
      { type: 'message', text: '**You:** Which environments?: dev + prod' },
    ]);
    expect(agentClient.startAgent).toHaveBeenCalledWith(
      { action: 'guided-setup', instruction: 'Which environments?: dev + prod' },
      expect.anything(),
    );
  });

  it('fresh start (no notes) clears the transcript', () => {
    useBuilderStore.setState({
      guidedTranscript: [{ type: 'message', text: 'Stale conversation.' }],
    });
    useBuilderStore.getState().beginGuidedSetup();
    expect(useBuilderStore.getState().guidedTranscript).toEqual([]);
    expect(agentClient.startAgent).toHaveBeenCalledWith(
      { action: 'guided-setup', instruction: '' },
      expect.anything(),
    );
  });

  it('a leaked MouseEvent (onClick wiring) counts as a fresh start, not a continuation', () => {
    useBuilderStore.setState({
      guidedTranscript: [{ type: 'message', text: 'Stale conversation.' }],
      agentRun: { id: 'run-0', status: 'done', guided: true, events: [] },
    });
    useBuilderStore.getState().beginGuidedSetup({ type: 'click' } as unknown as string);
    expect(useBuilderStore.getState().guidedTranscript).toEqual([]);
  });

  it('notes without a prior guided run leave the transcript untouched', () => {
    useBuilderStore.setState({
      guidedTranscript: [{ type: 'message', text: 'Kept.' }],
      agentRun: { id: 'run-9', status: 'done', events: [{ type: 'message', text: 'edit-flow run' }] },
    });
    useBuilderStore.getState().beginGuidedSetup('an answer');
    expect(useBuilderStore.getState().guidedTranscript).toEqual([
      { type: 'message', text: 'Kept.' },
    ]);
  });
});

describe('builderStore node sizing', () => {
  beforeEach(() => {
    useBuilderStore.setState({ flow: createLoginFlow(), run: null, logs: [], activeRun: null });
  });

  it('resizeNode writes metadata.size and preserves other metadata', () => {
    useBuilderStore.getState().pinNodeOutput('result', { ok: true });
    useBuilderStore.getState().resizeNode('result', { width: 320, height: 240 });
    const node = useBuilderStore.getState().flow.nodes.find((n) => n.id === 'result')!;
    expect(node.metadata?.size).toEqual({ width: 320, height: 240 });
    expect(node.metadata?.pinnedOutput).toEqual({ ok: true });
  });

  it('size survives export/import round-trips', () => {
    useBuilderStore.getState().resizeNode('result', { width: 320, height: 240 });
    const json = useBuilderStore.getState().exportFlow();
    useBuilderStore.getState().importFlow(json);
    const node = useBuilderStore.getState().flow.nodes.find((n) => n.id === 'result')!;
    expect(node.metadata?.size).toEqual({ width: 320, height: 240 });
  });
});

describe('builderStore panel visibility', () => {
  beforeEach(() => {
    useBuilderStore.setState({ sidebarOpen: true, dockOpen: true, inspectorOpen: true });
  });

  it('toggleDock flips dockOpen', () => {
    expect(useBuilderStore.getState().dockOpen).toBe(true);
    useBuilderStore.getState().toggleDock();
    expect(useBuilderStore.getState().dockOpen).toBe(false);
    useBuilderStore.getState().toggleDock();
    expect(useBuilderStore.getState().dockOpen).toBe(true);
  });

  it('toggleInspector flips inspectorOpen', () => {
    useBuilderStore.getState().toggleInspector();
    expect(useBuilderStore.getState().inspectorOpen).toBe(false);
    useBuilderStore.getState().toggleInspector();
    expect(useBuilderStore.getState().inspectorOpen).toBe(true);
  });

  it('toggleSidebar flips sidebarOpen', () => {
    useBuilderStore.getState().toggleSidebar();
    expect(useBuilderStore.getState().sidebarOpen).toBe(false);
  });

  it('toggles persist their open state to localStorage', () => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
    });
    try {
      useBuilderStore.getState().toggleSidebar();
      useBuilderStore.getState().toggleDock();
      useBuilderStore.getState().toggleInspector();
      expect(store['emberflow.panel.sidebar']).toBe('0');
      expect(store['emberflow.panel.dock']).toBe('0');
      expect(store['emberflow.panel.inspector']).toBe('0');
      useBuilderStore.getState().toggleDock();
      expect(store['emberflow.panel.dock']).toBe('1');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('builderStore view register', () => {
  beforeEach(() => {
    useBuilderStore.setState({ viewRegister: 'simple' });
  });

  it('defaults to simple', () => {
    expect(useBuilderStore.getState().viewRegister).toBe('simple');
  });

  it('setViewRegister switches registers', () => {
    useBuilderStore.getState().setViewRegister('technical');
    expect(useBuilderStore.getState().viewRegister).toBe('technical');
    useBuilderStore.getState().setViewRegister('simple');
    expect(useBuilderStore.getState().viewRegister).toBe('simple');
  });

  it('persists the selection to localStorage', () => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
    });
    try {
      useBuilderStore.getState().setViewRegister('technical');
      expect(store['emberflow.view.register']).toBe('technical');
      useBuilderStore.getState().setViewRegister('simple');
      expect(store['emberflow.view.register']).toBe('simple');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('migrates a legacy stored "business" value to simple on load', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'emberflow.view.register' ? 'business' : null),
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    });
    try {
      vi.resetModules();
      const fresh = await import('./builderStore');
      expect(fresh.useBuilderStore.getState().viewRegister).toBe('simple');
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe('builderStore console position', () => {
  beforeEach(() => {
    useBuilderStore.setState({ consolePosition: 'right' });
  });

  it('defaults to right', () => {
    expect(useBuilderStore.getState().consolePosition).toBe('right');
  });

  it('setConsolePosition switches sides', () => {
    useBuilderStore.getState().setConsolePosition('bottom');
    expect(useBuilderStore.getState().consolePosition).toBe('bottom');
    useBuilderStore.getState().setConsolePosition('right');
    expect(useBuilderStore.getState().consolePosition).toBe('right');
  });

  it('persists the selection to localStorage', () => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
    });
    try {
      useBuilderStore.getState().setConsolePosition('bottom');
      expect(store['emberflow.console.position']).toBe('bottom');
      useBuilderStore.getState().setConsolePosition('right');
      expect(store['emberflow.console.position']).toBe('right');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('loads a persisted "bottom" value on init', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'emberflow.console.position' ? 'bottom' : null),
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    });
    try {
      vi.resetModules();
      const fresh = await import('./builderStore');
      expect(fresh.useBuilderStore.getState().consolePosition).toBe('bottom');
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe('builderStore run console dismissal', () => {
  const liveRun = (id: string) => ({
    id,
    workflowId: 'wf',
    status: 'running' as const,
    startedAt: '2026-07-02T10:00:00Z',
    nodeStates: {},
  });

  beforeEach(() => {
    useBuilderStore.setState({ run: null, runConsoleDismissedId: null, runConsoleOpenedIds: new Set() });
  });

  it('dismissRunConsole records the current run id, reopenRunConsole clears it', () => {
    useBuilderStore.setState({ run: liveRun('run-1') });
    useBuilderStore.getState().dismissRunConsole();
    expect(useBuilderStore.getState().runConsoleDismissedId).toBe('run-1');
    useBuilderStore.getState().reopenRunConsole();
    expect(useBuilderStore.getState().runConsoleDismissedId).toBeNull();
  });

  it('dismissRunConsole with no run stores null', () => {
    useBuilderStore.getState().dismissRunConsole();
    expect(useBuilderStore.getState().runConsoleDismissedId).toBeNull();
  });

  it('a new run is not pre-dismissed (dismissal is per run id)', () => {
    useBuilderStore.setState({ run: liveRun('run-1') });
    useBuilderStore.getState().dismissRunConsole();
    expect(useBuilderStore.getState().runConsoleDismissedId).toBe('run-1');
    // A fresh run has a different id, so it is not considered dismissed.
    useBuilderStore.setState({ run: liveRun('run-2') });
    expect(useBuilderStore.getState().run!.id).not.toBe(useBuilderStore.getState().runConsoleDismissedId);
  });

  it('starts with no opened-console run ids', () => {
    expect(useBuilderStore.getState().runConsoleOpenedIds.size).toBe(0);
  });

  it('reopenRunConsole records the current run id in runConsoleOpenedIds', () => {
    useBuilderStore.setState({ run: liveRun('run-1') });
    useBuilderStore.getState().reopenRunConsole();
    expect(useBuilderStore.getState().runConsoleOpenedIds.has('run-1')).toBe(true);
  });

  it('reopenRunConsole with no run leaves runConsoleOpenedIds untouched', () => {
    useBuilderStore.getState().reopenRunConsole();
    expect(useBuilderStore.getState().runConsoleOpenedIds.size).toBe(0);
  });

  it('opening one run does not mark a different run as opened', () => {
    useBuilderStore.setState({ run: liveRun('run-1') });
    useBuilderStore.getState().reopenRunConsole();
    useBuilderStore.setState({ run: liveRun('run-2') });
    expect(useBuilderStore.getState().runConsoleOpenedIds.has('run-2')).toBe(false);
    expect(useBuilderStore.getState().runConsoleOpenedIds.has('run-1')).toBe(true);
  });
});

// NOTE: useRunConsole's actual open/closed gating (register === 'technical' ||
// runConsoleOpenedIds.has(run.id)) lives in the RunLogPanel hook, which reads
// multiple store slices via useBuilderStore selectors — that composition, and
// the toolbar's visual reflection of it, is only verifiable in a rendered
// browser/component-test environment, not from the store alone.

// Subflow execution moved server-side (server/subflowRunner.ts, exercised by the
// runner's run tests) — the studio no longer runs child workflows in-tab.

describe('builderStore.syncNodeMeta', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('merges fetched nodes and yields a fresh registry reference', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ nodes: [{ type: 'Zzz', label: 'Zzz' }] }),
      })),
    );
    const before = useBuilderStore.getState().registry;
    await useBuilderStore.getState().syncNodeMeta();
    const after = useBuilderStore.getState().registry;
    expect(after).not.toBe(before);
    expect(after.has('Zzz')).toBe(true);
  });
});

describe('builderStore.testWorkflow', () => {
  beforeEach(() => {
    vi.mocked(serverRunner.testWorkflow).mockReset();
    useBuilderStore.setState({ scenarioTestReports: {}, scenarioTestPending: null });
  });

  it('stores the report and toggles pending around the call', async () => {
    const report: ScenarioTestReport = {
      results: [{ opId: 'login', scenario: 'happy path', status: 'passed' }],
      passed: 1,
      failed: 0,
      skipped: 0,
    };
    let pendingDuringCall: string | null = null;
    vi.mocked(serverRunner.testWorkflow).mockImplementation(async () => {
      pendingDuringCall = useBuilderStore.getState().scenarioTestPending;
      return report;
    });

    expect(useBuilderStore.getState().scenarioTestPending).toBeNull();
    await useBuilderStore.getState().testWorkflow('login');

    expect(pendingDuringCall).toBe('login');
    expect(useBuilderStore.getState().scenarioTestPending).toBeNull();
    expect(useBuilderStore.getState().scenarioTestReports.login).toEqual(report);
    expect(vi.mocked(serverRunner.testWorkflow)).toHaveBeenCalledWith('login', undefined);
  });

  it('threads the environment through to the client', async () => {
    vi.mocked(serverRunner.testWorkflow).mockResolvedValue({ results: [], passed: 0, failed: 0, skipped: 0 });
    await useBuilderStore.getState().testWorkflow('login', 'staging');
    expect(vi.mocked(serverRunner.testWorkflow)).toHaveBeenCalledWith('login', 'staging');
  });

  it('clears pending even when the client call rejects', async () => {
    vi.mocked(serverRunner.testWorkflow).mockRejectedValue(new Error('boom'));
    await expect(useBuilderStore.getState().testWorkflow('login')).rejects.toThrow('boom');
    expect(useBuilderStore.getState().scenarioTestPending).toBeNull();
  });
});

describe('builderStore.checkRunner runnerMock', () => {
  beforeEach(() => {
    vi.mocked(serverRunner.runnerHealthy).mockReset();
    vi.mocked(serverRunner.listEnvironments).mockReset().mockResolvedValue(null);
    useBuilderStore.setState({ runnerOnline: null, runnerMock: false, workspaceSource: 'server' });
  });

  it('sets runnerMock true when /healthz reports mock:true', async () => {
    vi.mocked(serverRunner.runnerHealthy).mockResolvedValue({ online: true, mock: true });
    await useBuilderStore.getState().checkRunner();
    expect(useBuilderStore.getState().runnerOnline).toBe(true);
    expect(useBuilderStore.getState().runnerMock).toBe(true);
  });

  it('sets runnerMock false when /healthz reports mock:false', async () => {
    vi.mocked(serverRunner.runnerHealthy).mockResolvedValue({ online: true, mock: false });
    await useBuilderStore.getState().checkRunner();
    expect(useBuilderStore.getState().runnerMock).toBe(false);
  });

  it('sets runnerMock false when the runner is offline', async () => {
    vi.mocked(serverRunner.runnerHealthy).mockResolvedValue({ online: false, mock: false });
    await useBuilderStore.getState().checkRunner();
    expect(useBuilderStore.getState().runnerOnline).toBe(false);
    expect(useBuilderStore.getState().runnerMock).toBe(false);
  });
});

describe('builderStore mock runs (studio wiring)', () => {
  beforeEach(() => {
    vi.mocked(serverRunner.startServerRun).mockReset();
    vi.mocked(serverRunner.subscribeServerRun).mockReset();
    const flow = createLoginFlow();
    flow.scenarios = [
      { id: 's1', name: 'happy', input: { username: 'g', password: 'x' }, mocks: { validate: { ok: true } } },
    ];
    useBuilderStore.setState({
      flow,
      shelf: [],
      run: null,
      logs: [],
      activeRun: null,
      activeServerRunId: null,
      runnerOnline: true,
      runnerMock: true,
      runHistory: [],
      activeScenarioId: null,
      activeRunMock: false,
    });
  });

  it('runScenario sends scenarioName so the runner can merge that scenario\'s mocks', async () => {
    vi.mocked(serverRunner.startServerRun).mockResolvedValue('run-m1');
    vi.mocked(serverRunner.subscribeServerRun).mockImplementation(() => () => {});

    await useBuilderStore.getState().runScenario('s1');

    const call = vi.mocked(serverRunner.startServerRun).mock.calls[0];
    expect(call[4]).toMatchObject({ scenarioName: 'happy' });
  });

  it('tags the history entry mock:true when the run started under Mock', async () => {
    let capturedHandlers: ServerRunHandlers | undefined;
    vi.mocked(serverRunner.startServerRun).mockResolvedValue('run-m2');
    vi.mocked(serverRunner.subscribeServerRun).mockImplementation((_runId, handlers) => {
      capturedHandlers = handlers;
      return () => {};
    });

    await useBuilderStore.getState().runScenario('s1');
    const flowId = useBuilderStore.getState().flow.id;
    capturedHandlers!.onFinished({
      id: 'run-m2',
      workflowId: flowId,
      status: 'succeeded',
      startedAt: '2026-07-10T10:00:00Z',
      completedAt: '2026-07-10T10:00:01Z',
      nodeStates: {},
    });

    const entry = useBuilderStore.getState().runHistory.find((r) => r.id === 'run-m2');
    expect(entry?.mock).toBe(true);
  });

  it('does not tag mock on a run started while serving real', async () => {
    useBuilderStore.setState({ runnerMock: false });
    let capturedHandlers: ServerRunHandlers | undefined;
    vi.mocked(serverRunner.startServerRun).mockResolvedValue('run-r1');
    vi.mocked(serverRunner.subscribeServerRun).mockImplementation((_runId, handlers) => {
      capturedHandlers = handlers;
      return () => {};
    });

    await useBuilderStore.getState().runScenario('s1');
    const flowId = useBuilderStore.getState().flow.id;
    capturedHandlers!.onFinished({
      id: 'run-r1',
      workflowId: flowId,
      status: 'succeeded',
      startedAt: '2026-07-10T10:00:00Z',
      completedAt: '2026-07-10T10:00:01Z',
      nodeStates: {},
    });

    expect(useBuilderStore.getState().runHistory.find((r) => r.id === 'run-r1')?.mock).toBeUndefined();
  });
});

describe('builderStore server-run finished event → errorHandler tag', () => {
  beforeEach(() => {
    vi.mocked(serverRunner.startServerRun).mockReset();
    vi.mocked(serverRunner.subscribeServerRun).mockReset();
    useBuilderStore.setState({
      flow: createLoginFlow(),
      shelf: [],
      run: null,
      logs: [],
      activeRun: null,
      activeServerRunId: null,
      runnerOnline: true,
      runHistory: [],
      activeScenarioId: null,
    });
  });

  it('tags the runHistory entry when the finished SSE event carries errorHandler', async () => {
    let capturedHandlers: ServerRunHandlers | undefined;
    vi.mocked(serverRunner.startServerRun).mockResolvedValue('run-1');
    vi.mocked(serverRunner.subscribeServerRun).mockImplementation((_runId, handlers) => {
      capturedHandlers = handlers;
      return () => {};
    });

    await useBuilderStore.getState().runToEnd();
    expect(capturedHandlers).toBeDefined();

    const flowId = useBuilderStore.getState().flow.id;
    capturedHandlers!.onFinished(
      {
        id: 'run-1',
        workflowId: flowId,
        status: 'failed',
        startedAt: '2026-07-09T10:00:00Z',
        completedAt: '2026-07-09T10:00:01Z',
        nodeStates: {},
      },
      { firedBy: 'notifyOnFailure' },
    );

    const entry = useBuilderStore.getState().runHistory.find((r) => r.id === 'run-1');
    expect(entry?.errorHandler).toEqual({ firedBy: 'notifyOnFailure' });
  });

  it('leaves errorHandler unset for an ordinary finished run', async () => {
    let capturedHandlers: ServerRunHandlers | undefined;
    vi.mocked(serverRunner.startServerRun).mockResolvedValue('run-2');
    vi.mocked(serverRunner.subscribeServerRun).mockImplementation((_runId, handlers) => {
      capturedHandlers = handlers;
      return () => {};
    });

    await useBuilderStore.getState().runToEnd();
    const flowId = useBuilderStore.getState().flow.id;
    capturedHandlers!.onFinished({
      id: 'run-2',
      workflowId: flowId,
      status: 'succeeded',
      startedAt: '2026-07-09T10:00:00Z',
      completedAt: '2026-07-09T10:00:01Z',
      nodeStates: {},
    });

    const entry = useBuilderStore.getState().runHistory.find((r) => r.id === 'run-2');
    expect(entry?.errorHandler).toBeUndefined();
  });
});

describe('builderStore subflow step drill-in', () => {
  const drillFlow = (id: string, name: string, nodeIds: string[]): WorkflowDefinition => ({
    id,
    name,
    version: 1,
    nodes: nodeIds.map((nid, i) => ({
      id: nid,
      type: 'Noop',
      label: nid,
      position: { x: i * 100, y: 0 },
      config: {},
    })),
    edges: [],
    createdAt: '2026-07-13T00:00:00Z',
    updatedAt: '2026-07-13T00:00:00Z',
  });

  let handlers: ServerRunHandlers | undefined;

  beforeEach(() => {
    handlers = undefined;
    vi.mocked(serverRunner.startServerRun).mockReset().mockResolvedValue('run-d');
    vi.mocked(serverRunner.stepServerRun).mockReset();
    vi.mocked(serverRunner.subscribeServerRun).mockReset().mockImplementation((_runId, h) => {
      handlers = h;
      return () => {};
    });
    useBuilderStore.setState({
      flow: drillFlow('parent', 'Parent Flow', ['start', 'sub', 'finish']),
      shelf: [drillFlow('child', 'Child Flow', ['c1', 'c2']), drillFlow('grandchild', 'Grandchild Flow', ['g1'])],
      run: null,
      logs: [],
      activeRun: null,
      activeServerRunId: null,
      runnerOnline: true,
      runHistory: [],
      activeScenarioId: null,
      stepMode: false,
      stepDrill: [],
      drillPeek: null,
      selectedNodeId: null,
    });
  });

  /** One Step click: queue the next step response and drive stepRun. */
  const step = (result: StepResult): Promise<void> => {
    vi.mocked(serverRunner.stepServerRun).mockResolvedValueOnce(result);
    return useBuilderStore.getState().stepRun();
  };

  it('entered pushes a drill level, swaps the view to the child, and routes nodeState by workflowId', async () => {
    await step({ done: false }); // first parent node
    await step({ done: false, entered: { workflowId: 'child', nodeId: 'sub' } });

    let s = useBuilderStore.getState();
    expect(s.flow.id).toBe('child');
    expect(s.stepDrill).toHaveLength(1);
    expect(s.stepDrill[0]).toMatchObject({ workflowId: 'child', viaNodeId: 'sub' });
    expect(s.stepDrill[0].savedFlow.id).toBe('parent');
    // Synthetic child run: running, no node states yet (first child node runs
    // on the NEXT step), same id as the root run so SSE routing applies.
    expect(s.run?.workflowId).toBe('child');
    expect(s.run?.status).toBe('running');
    expect(s.run?.nodeStates).toEqual({});
    expect(s.run?.id).toBe('run-d');
    // The live server run and step mode are untouched by drilling.
    expect(s.activeServerRunId).toBe('run-d');
    expect(s.stepMode).toBe(true);

    // Child workflowId → lights the visible (child) run.
    handlers!.onNodeState('child', 'c1', { status: 'running' });
    expect(useBuilderStore.getState().run?.nodeStates.c1?.status).toBe('running');

    // Parent workflowId → lands on the stashed parent run, not the child view.
    handlers!.onNodeState('parent', 'sub', { status: 'running' });
    s = useBuilderStore.getState();
    expect(s.run?.nodeStates.sub).toBeUndefined();
    expect(s.stepDrill[0].savedRun?.nodeStates.sub?.status).toBe('running');

    // Unknown workflowId → ignored.
    handlers!.onNodeState('elsewhere', 'x', { status: 'running' });
    expect(useBuilderStore.getState().run?.nodeStates.x).toBeUndefined();
  });

  it('drilling does not clear the root run logs', async () => {
    await step({ done: false });
    useBuilderStore.setState({
      logs: [{ timestamp: 't', level: 'info', runId: 'run-d', message: 'parent log' }],
    });
    await step({ done: false, entered: { workflowId: 'child', nodeId: 'sub' } });
    expect(useBuilderStore.getState().logs.map((l) => l.message)).toEqual(['parent log']);
  });

  it('exited restores the parent view including its updated Subflow node state and selection', async () => {
    await step({ done: false });
    useBuilderStore.setState({ selectedNodeId: 'start' });
    await step({ done: false, entered: { workflowId: 'child', nodeId: 'sub' } });
    expect(useBuilderStore.getState().selectedNodeId).toBeNull();

    handlers!.onNodeState('child', 'c1', { status: 'succeeded' });
    handlers!.onNodeState('parent', 'sub', { status: 'succeeded' });
    await step({ done: false, exited: true });

    const s = useBuilderStore.getState();
    expect(s.flow.id).toBe('parent');
    expect(s.stepDrill).toHaveLength(0);
    expect(s.run?.workflowId).toBe('parent');
    expect(s.run?.nodeStates.sub?.status).toBe('succeeded');
    expect(s.selectedNodeId).toBe('start');
  });

  it('nested enter/enter/exit/exit walks the stack one level at a time', async () => {
    await step({ done: false, entered: { workflowId: 'child', nodeId: 'sub' } });
    await step({ done: false, entered: { workflowId: 'grandchild', nodeId: 'c2' } });

    let s = useBuilderStore.getState();
    expect(s.flow.id).toBe('grandchild');
    expect(s.stepDrill.map((d) => d.workflowId)).toEqual(['child', 'grandchild']);
    expect(s.stepDrill[1].savedFlow.id).toBe('child');

    // Mid-level (child) states land on its stashed run while two deep.
    handlers!.onNodeState('child', 'c2', { status: 'running' });
    s = useBuilderStore.getState();
    expect(s.stepDrill[1].savedRun?.nodeStates.c2?.status).toBe('running');

    await step({ done: false, exited: true });
    s = useBuilderStore.getState();
    expect(s.flow.id).toBe('child');
    expect(s.stepDrill).toHaveLength(1);
    expect(s.run?.nodeStates.c2?.status).toBe('running');

    await step({ done: false, exited: true });
    s = useBuilderStore.getState();
    expect(s.flow.id).toBe('parent');
    expect(s.stepDrill).toHaveLength(0);
  });

  it('entered with an unknown child flow id stays on the parent but pushes a placeholder level', async () => {
    await step({ done: false, entered: { workflowId: 'missing', nodeId: 'sub' } });
    let s = useBuilderStore.getState();
    expect(s.flow.id).toBe('parent');
    // The server's drill stack grew — the client mirrors the depth with a
    // placeholder so the matching `exited` pops the right level.
    expect(s.stepDrill).toHaveLength(1);
    expect(s.stepDrill[0]).toMatchObject({ workflowId: 'missing', viaNodeId: 'sub', placeholder: true });
    expect(s.stepDrill[0].savedFlow.id).toBe('parent');

    // Parent states keep applying to the visible run as before.
    handlers!.onNodeState('parent', 'sub', { status: 'running' });
    expect(useBuilderStore.getState().run?.nodeStates.sub?.status).toBe('running');

    // The matching exited pops the placeholder and leaves the parent view —
    // including states received while "inside" — untouched.
    await step({ done: false, exited: true });
    s = useBuilderStore.getState();
    expect(s.flow.id).toBe('parent');
    expect(s.stepDrill).toHaveLength(0);
    expect(s.run?.nodeStates.sub?.status).toBe('running');
  });

  it('exited+entered in one step (Subflow retry) pops the failed child before pushing the fresh one', async () => {
    await step({ done: false, entered: { workflowId: 'child', nodeId: 'sub' } });
    expect(useBuilderStore.getState().flow.id).toBe('child');

    // The retrying Subflow node pops its failed child AND re-enters a new
    // child run in the same composite step.
    await step({ done: false, exited: true, entered: { workflowId: 'child', nodeId: 'sub' } });
    const s = useBuilderStore.getState();
    expect(s.flow.id).toBe('child');
    expect(s.stepDrill).toHaveLength(1);
    expect(s.stepDrill[0].savedFlow.id).toBe('parent');
    // Fresh synthetic child run for the retry attempt.
    expect(s.run?.workflowId).toBe('child');
    expect(s.run?.nodeStates).toEqual({});

    await step({ done: false, exited: true });
    expect(useBuilderStore.getState().flow.id).toBe('parent');
    expect(useBuilderStore.getState().stepDrill).toHaveLength(0);
  });

  it('exited plus done pops the drill and ends the live run', async () => {
    await step({ done: false, entered: { workflowId: 'child', nodeId: 'sub' } });
    await step({ done: true, exited: true });
    const s = useBuilderStore.getState();
    expect(s.flow.id).toBe('parent');
    expect(s.stepDrill).toHaveLength(0);
    expect(s.activeServerRunId).toBeNull();
  });

  it('peek shows an ancestor without popping; child states during the peek still land on the child run', async () => {
    await step({ done: false, entered: { workflowId: 'child', nodeId: 'sub' } });

    useBuilderStore.getState().peekDrill(0);
    let s = useBuilderStore.getState();
    expect(s.drillPeek).toBe(0);
    // View-only: the drill stack and the live (deepest) level are untouched —
    // the runbook derives the peeked flow/run from stepDrill[drillPeek].
    expect(s.stepDrill).toHaveLength(1);
    expect(s.flow.id).toBe('child');
    expect(s.stepDrill[0].savedFlow.id).toBe('parent');

    // Child states arriving during the peek land on the child's (live) run.
    handlers!.onNodeState('child', 'c1', { status: 'succeeded' });
    expect(useBuilderStore.getState().run?.nodeStates.c1?.status).toBe('succeeded');
    // Parent states still land on the stashed parent run.
    handlers!.onNodeState('parent', 'sub', { status: 'running' });
    expect(useBuilderStore.getState().stepDrill[0].savedRun?.nodeStates.sub?.status).toBe('running');

    // The last crumb returns to the deepest level.
    useBuilderStore.getState().peekDrill(null);
    expect(useBuilderStore.getState().drillPeek).toBeNull();

    // Out-of-range peek indexes clear rather than dangle.
    useBuilderStore.getState().peekDrill(7);
    expect(useBuilderStore.getState().drillPeek).toBeNull();
  });

  it('a further entered while peeking resets the peek to the new deepest level', async () => {
    await step({ done: false, entered: { workflowId: 'child', nodeId: 'sub' } });
    useBuilderStore.getState().peekDrill(0);
    await step({ done: false, entered: { workflowId: 'grandchild', nodeId: 'c2' } });
    const s = useBuilderStore.getState();
    expect(s.drillPeek).toBeNull();
    expect(s.flow.id).toBe('grandchild');
    expect(s.stepDrill).toHaveLength(2);
  });

  it('the finished SSE event unwinds any remaining drill before recording the root run', async () => {
    await step({ done: false, entered: { workflowId: 'child', nodeId: 'sub' } });
    handlers!.onFinished({
      id: 'run-d',
      workflowId: 'parent',
      status: 'failed',
      startedAt: '2026-07-13T10:00:00Z',
      completedAt: '2026-07-13T10:00:01Z',
      nodeStates: {},
    });
    const s = useBuilderStore.getState();
    expect(s.flow.id).toBe('parent');
    expect(s.stepDrill).toHaveLength(0);
    expect(s.run?.id).toBe('run-d');
    expect(s.run?.workflowId).toBe('parent');
    expect(s.runHistory[0]?.id).toBe('run-d');
  });
});

describe('builderStore.askAboutFailure', () => {
  beforeEach(() => {
    vi.mocked(agentClient.startAgent).mockClear().mockResolvedValue('run-1');
    useBuilderStore.setState({
      agentChoice: {},
      agentRun: null,
      agentPanelOpen: false,
      flow: {
        id: 'billing/charge',
        name: 'Charge',
        version: 1,
        nodes: [
          { id: 'x', type: 'Noop', label: 'Charge card', position: { x: 0, y: 0 }, config: {} },
        ],
        edges: [],
        createdAt: '2026-07-13T00:00:00Z',
        updatedAt: '2026-07-13T00:00:00Z',
      },
      run: {
        id: 'run-1',
        workflowId: 'billing/charge',
        status: 'failed',
        startedAt: '2026-07-13T00:00:00Z',
        nodeStates: { x: { status: 'failed', error: 'boom' } },
      },
    });
  });

  it('composes an ask instruction from the failed node + error and opens the agent panel', () => {
    useBuilderStore.getState().askAboutFailure('x');

    expect(useBuilderStore.getState().agentPanelOpen).toBe(true);
    expect(agentClient.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ask',
        flowId: 'billing/charge',
        instruction: expect.stringContaining('id: x'),
      }),
      expect.anything(),
    );
    const instruction = vi.mocked(agentClient.startAgent).mock.calls[0][0] as { instruction: string };
    expect(instruction.instruction).toContain('Charge card');
    expect(instruction.instruction).toContain('boom');
  });

  it('does not start a new agent run while one is already running', () => {
    useBuilderStore.setState({
      agentRun: { id: 'run-existing', status: 'running', events: [] },
    });

    useBuilderStore.getState().askAboutFailure('x');

    expect(agentClient.startAgent).not.toHaveBeenCalled();
  });
});
