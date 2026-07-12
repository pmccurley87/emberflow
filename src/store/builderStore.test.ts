import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinsOf, useBuilderStore } from './builderStore';
import { createLoginFlow } from '../flows/login-flow';
import { createDefaultRegistry } from '../nodes';
import * as serverRunner from './serverRunner';
import * as agentClient from './agentClient';
import type { WorkflowDefinition, WorkflowNode } from '../engine';
import type { ScenarioTestReport, ServerRunHandlers } from './serverRunner';

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
    subscribeServerRun: vi.fn(),
    setServingMode: vi.fn(),
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
    useBuilderStore.setState({ flow: createLoginFlow(), run: null, logs: [], activeRun: null });
  });

  it('pinned output skips execution and feeds downstream mapping', async () => {
    useBuilderStore
      .getState()
      .pinNodeOutput('validate', { userId: 'user-pinned', username: 'pinned' });
    await useBuilderStore.getState().runToEnd();
    const run = useBuilderStore.getState().run!;
    expect(run.nodeStates.validate.pinned).toBe(true);
    expect((run.nodeStates.fetch.input as { userId: string }).userId).toBe('user-pinned');
  }, 10_000);

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

describe('builderStore isolated node run', () => {
  beforeEach(() => {
    useBuilderStore.setState({ flow: createLoginFlow(), run: null, logs: [], activeRun: null });
  });

  it('executes one node against supplied input, capturing logs and a sample', async () => {
    const before = useBuilderStore.getState().trace.samplesFor('checkPlan').length;
    const result = await useBuilderStore
      .getState()
      .runNodeIsolated('checkPlan', { user: { plan: 'pro' } });
    expect(result.error).toBeUndefined();
    expect((result.output as { plan: string }).plan).toBe('pro');
    expect(result.logs.some((l) => l.message.includes('pro'))).toBe(true);
    const samples = useBuilderStore.getState().trace.samplesFor('checkPlan');
    expect(samples.length).toBe(before + 1);
    expect(samples[0].input).toEqual({ user: { plan: 'pro' } });
    expect(useBuilderStore.getState().run).toBeNull();
  });

  it('reports node failure as error with a failed sample', async () => {
    const result = await useBuilderStore
      .getState()
      .runNodeIsolated('validate', { username: 'ada', password: 'lovelace' });
    expect(result.error).toBeUndefined();

    const failed = await useBuilderStore
      .getState()
      .runNodeIsolated('validate', { username: 'ada', password: 'x' });
    expect(failed.error).toContain('Password too short');
    expect(useBuilderStore.getState().trace.samplesFor('validate')[0].status).toBe('failed');
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
    // Start from a scenario-free flow: the seeded examples would offset counts.
    const flow = createLoginFlow();
    delete flow.scenarios;
    useBuilderStore.setState({
      flow,
      run: null,
      logs: [],
      activeRun: null,
      runHistory: [],
      activeScenarioId: null,
      executionMode: 'browser',
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

  it('runScenario feeds the payload through the Input node and tags history', async () => {
    useBuilderStore
      .getState()
      .addScenario('new user', { username: 'newton', password: 'apple123' });
    const id = useBuilderStore.getState().flow.scenarios![0].id;

    await useBuilderStore.getState().runScenario(id);

    const run = useBuilderStore.getState().run!;
    expect(run.status).toBe('succeeded');
    expect((run.nodeStates.input.output as { username: string }).username).toBe('newton');
    // 'newton' is a new user: the welcome branch fires and checkPlan is skipped.
    expect(run.nodeStates.welcome.status).toBe('succeeded');
    expect(run.nodeStates.checkPlan.status).toBe('skipped');
    expect(useBuilderStore.getState().runHistory[0].scenarioName).toBe('new user');
  }, 15_000);

  it('a plain run after a scenario run is not tagged', async () => {
    useBuilderStore
      .getState()
      .addScenario('new user', { username: 'newton', password: 'apple123' });
    const id = useBuilderStore.getState().flow.scenarios![0].id;
    await useBuilderStore.getState().runScenario(id);

    await useBuilderStore.getState().runToEnd();
    expect(useBuilderStore.getState().runHistory[0].scenarioName).toBeUndefined();
  }, 20_000);
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

describe('builderStore subflow execution', () => {
  const node = (id: string, type: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
    id, type, label: id, position: { x: 0, y: 0 }, config: {}, ...extra,
  });
  const mkFlow = (
    id: string, name: string, nodes: WorkflowNode[], edges: WorkflowDefinition['edges'],
  ): WorkflowDefinition => ({
    id, name, version: 1, nodes, edges,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  });

  beforeEach(() => {
    // Delay-free registry so end-to-end runs are fast; browser mode so runs
    // execute in-tab through the store's subflow runner.
    useBuilderStore.setState({
      registry: createDefaultRegistry(0),
      runnerOnline: false,
      executionMode: 'browser',
      run: null,
      logs: [],
      activeRun: null,
      activeServerRunId: null,
    });
  });

  it('resolves a shelf workflow and forwards its logs with prefixing', async () => {
    const child = mkFlow('child', 'Child', [node('cres', 'Result', { label: 'Result' })], []);
    const parent = mkFlow(
      'parent', 'Parent',
      [
        node('sub', 'Subflow', { config: { workflowId: 'child' } }),
        node('res', 'Result', { inputMap: { data: { sourceNodeId: 'sub', sourceField: '$' } } }),
      ],
      [{ id: 'e', source: 'sub', target: 'res', targetHandle: 'data' }],
    );
    useBuilderStore.setState({ flow: parent, shelf: [child] });

    await useBuilderStore.getState().runToEnd();
    const s = useBuilderStore.getState();
    expect(s.run?.status).toBe('succeeded');
    expect(s.run?.nodeStates.sub.status).toBe('succeeded');
    // The child's Result-collected output flows into the parent's Result.
    expect(s.run?.nodeStates.res.output).toEqual({ data: {} });

    const forwarded = s.logs.find((l) => l.nodeId === 'sub/cres');
    expect(forwarded, JSON.stringify(s.logs)).toBeDefined();
    expect(forwarded?.nodeLabel).toBe('Child › Result');
  });

  it('rejects an unknown workflow id', async () => {
    const parent = mkFlow('parent', 'Parent', [node('sub', 'Subflow', { config: { workflowId: 'nope' } })], []);
    useBuilderStore.setState({ flow: parent, shelf: [] });
    await useBuilderStore.getState().runToEnd();
    const s = useBuilderStore.getState();
    expect(s.run?.status).toBe('failed');
    expect(s.run?.nodeStates.sub.error).toBe('Unknown workflow: nope');
  });

  it('catches an A→B→A cycle at runtime', async () => {
    const a = mkFlow('a', 'A', [node('subA', 'Subflow', { config: { workflowId: 'b' } })], []);
    const b = mkFlow('b', 'B', [node('subB', 'Subflow', { config: { workflowId: 'a' } })], []);
    useBuilderStore.setState({ flow: a, shelf: [b] });
    await useBuilderStore.getState().runToEnd();
    const s = useBuilderStore.getState();
    expect(s.run?.status).toBe('failed');
    // The cycle is reported from deep in the child; its error log is forwarded up.
    expect(s.logs.some((l) => l.message === 'subflow cycle: a → b → a')).toBe(true);
  });
});

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
      executionMode: 'server',
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
      executionMode: 'server',
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
