import { describe, expect, it } from 'vitest';
import { iterationSummary, projectRunbook, runProvenance, runSourceLabel } from './runbookProjection';
import { buildRunbook, type RunbookDoc, type RunbookItem } from './runbookModel';
import { NodeRegistry, type ExecutionRecord, type LogLine, type WorkflowDefinition, type WorkflowRun } from '../engine';
import type { RunHistoryEntry } from '../store/builderStore';
import evEvaluateCycle from '../../workflows/apis/default/ev-evaluate-cycle.json';

const FLOW_ID = 'test-flow';

function step(nodeId: string, typeName = 'Http'): RunbookItem {
  return {
    kind: 'step',
    nodeId,
    number: '1',
    depth: 0,
    label: nodeId,
    typeName,
    description: '',
    simpleDescription: '',
    mutation: false,
    subflow: false,
  };
}

/**
 * Synthetic doc: cond branches into onArm (member onStep) / offArm (member
 * offStep), plus a 3-iteration loop (fe1/co1) with body step body1.
 */
function makeDoc(): RunbookDoc {
  const items: RunbookItem[] = [
    step('cond', 'If'),
    {
      kind: 'branch',
      ownerId: 'cond',
      arm: 'onArm',
      number: '1.1',
      depth: 1,
      items: [step('onStep')],
    },
    {
      kind: 'branch',
      ownerId: 'cond',
      arm: 'offArm',
      number: '1.2',
      depth: 1,
      items: [step('offStep')],
    },
    {
      kind: 'loop',
      forEachId: 'fe1',
      collectId: 'co1',
      number: '2',
      depth: 0,
      label: 'Loop',
      items: [step('body1', 'Transform')],
    },
  ];

  const guards = new Map<string, Array<{ ownerId: string; arm: string }>>([
    ['cond', []],
    ['onStep', [{ ownerId: 'cond', arm: 'onArm' }]],
    ['offStep', [{ ownerId: 'cond', arm: 'offArm' }]],
    ['body1', []],
  ]);

  const arms = [
    { ownerId: 'cond', arm: 'onArm' },
    { ownerId: 'cond', arm: 'offArm' },
  ];

  return { items, guards, arms };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    workflowId: FLOW_ID,
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    nodeStates: {},
    ...overrides,
  };
}

describe('projectRunbook', () => {
  it('status: comes straight from run.nodeStates, mapped per status', () => {
    const doc = makeDoc();
    const run = makeRun({
      nodeStates: {
        onStep: { status: 'running' },
        offStep: { status: 'skipped' },
        body1: { status: 'succeeded' },
      },
    });
    const proj = projectRunbook(doc, run, [], [], FLOW_ID);
    expect(proj.steps.get('onStep')!.status).toBe('active');
    expect(proj.steps.get('offStep')!.status).toBe('skipped');
    expect(proj.steps.get('body1')!.status).toBe('ran');
    expect(proj.steps.get('cond')!.status).toBe('idle'); // absent from nodeStates
  });

  it('status is idle for every step when run is null', () => {
    const doc = makeDoc();
    const proj = projectRunbook(doc, null, [], [], FLOW_ID);
    for (const id of ['cond', 'onStep', 'offStep', 'body1']) {
      expect(proj.steps.get(id)!.status).toBe('idle');
    }
  });

  it('outcome: the LAST info-level log line for the node wins', () => {
    const doc = makeDoc();
    const run = makeRun({ nodeStates: { onStep: { status: 'succeeded' } } });
    const logs: LogLine[] = [
      { timestamp: 't1', level: 'info', runId: 'run-1', nodeId: 'onStep', message: 'first message' },
      { timestamp: 't2', level: 'debug', runId: 'run-1', nodeId: 'onStep', message: 'ignored debug' },
      { timestamp: 't3', level: 'info', runId: 'run-1', nodeId: 'onStep', message: 'second message' },
    ];
    const proj = projectRunbook(doc, run, logs, [], FLOW_ID);
    expect(proj.steps.get('onStep')!.outcome).toBe('second message');
  });

  it('outcome is empty string when there is no info log for the node', () => {
    const doc = makeDoc();
    const proj = projectRunbook(doc, makeRun(), [], [], FLOW_ID);
    expect(proj.steps.get('onStep')!.outcome).toBe('');
  });

  it('tech line: typeName · durationMs · in[...] -> out[...] when ran; bare typeName otherwise', () => {
    const doc = makeDoc();
    const run = makeRun({
      nodeStates: {
        onStep: {
          status: 'succeeded',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:01.500Z',
          input: { a: 1, b: 2, c: 3, d: 4, e: 5 },
          output: { x: 1, y: 2 },
        },
        offStep: { status: 'idle' },
      },
    });
    const proj = projectRunbook(doc, run, [], [], FLOW_ID);
    expect(proj.steps.get('onStep')!.tech).toBe('Http · 1500ms · in[a,b,c,d,…] → out[x,y]');
    expect(proj.steps.get('onStep')!.durationMs).toBe(1500);
    expect(proj.steps.get('offStep')!.tech).toBe('Http');
    expect(proj.steps.get('offStep')!.durationMs).toBeNull();
  });

  it('tech line: prefixes #N from the ordered execution receipt (latest wins)', () => {
    const doc = makeDoc();
    const run = makeRun({
      nodeStates: {
        onStep: {
          status: 'succeeded',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:00.200Z',
          input: { a: 1 },
          output: { x: 1 },
        },
      },
    });
    const logs: LogLine[] = [
      { timestamp: 't1', level: 'debug', runId: 'run-1', nodeId: 'onStep', message: '#3 ▶ execute' },
      // a later, unrelated debug line must not clobber the receipt seq
      { timestamp: 't2', level: 'debug', runId: 'run-1', nodeId: 'onStep', message: 'validating input' },
    ];
    const proj = projectRunbook(doc, run, logs, [], FLOW_ID);
    expect(proj.steps.get('onStep')!.tech).toBe('#3 Http · 200ms · in[a] → out[x]');
  });

  it('tech line: a loop-body node uses its LATEST receipt seq', () => {
    const doc = makeDoc();
    const run = makeRun({
      nodeStates: {
        body1: {
          status: 'succeeded',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:00.100Z',
          input: { i: 1 },
          output: { o: 1 },
        },
      },
    });
    const logs: LogLine[] = [
      { timestamp: 't1', level: 'debug', runId: 'run-1', nodeId: 'body1', message: '#5 ▶ execute (iteration 1/3)' },
      { timestamp: 't2', level: 'debug', runId: 'run-1', nodeId: 'body1', message: '#7 ▶ execute (iteration 2/3)' },
    ];
    const proj = projectRunbook(doc, run, logs, [], FLOW_ID);
    expect(proj.steps.get('body1')!.tech).toBe('#7 Transform · 100ms · in[i] → out[o]');
  });

  it('tech line: failed form is `[#N ]typeName · ms · ERROR: <first 80 chars>`', () => {
    const doc = makeDoc();
    const longError = 'x'.repeat(120);
    const run = makeRun({
      nodeStates: {
        onStep: {
          status: 'failed',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:00.050Z',
          error: longError,
        },
      },
    });
    const logs: LogLine[] = [
      { timestamp: 't1', level: 'debug', runId: 'run-1', nodeId: 'onStep', message: '#2 ▶ execute' },
    ];
    const proj = projectRunbook(doc, run, logs, [], FLOW_ID);
    expect(proj.steps.get('onStep')!.tech).toBe(`#2 Http · 50ms · ERROR: ${'x'.repeat(80)}`);
  });

  it('drilled view: outcome and receipt match caller-prefixed child log ids (`caller/nodeId`); undrilled does not', () => {
    const doc = makeDoc();
    const run = makeRun({
      nodeStates: {
        onStep: {
          status: 'succeeded',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:00.100Z',
          input: { a: 1 },
          output: { x: 1 },
        },
      },
    });
    // How a drilled subflow child's logs arrive: nodeId prefixed with the
    // caller chain (`sub/onStep`, nested per level).
    const logs: LogLine[] = [
      { timestamp: 't1', level: 'debug', runId: 'run-1', nodeId: 'sub/onStep', message: '#4 ▶ execute' },
      { timestamp: 't2', level: 'info', runId: 'run-1', nodeId: 'sub/onStep', message: 'child outcome' },
    ];

    const drilled = projectRunbook(doc, run, logs, [], FLOW_ID, true);
    expect(drilled.steps.get('onStep')!.outcome).toBe('child outcome');
    expect(drilled.steps.get('onStep')!.tech).toBe('#4 Http · 100ms · in[a] → out[x]');

    // Undrilled: suffix matching stays off so a parent node can never pick
    // up a same-named child's prefixed lines.
    const plain = projectRunbook(doc, run, logs, [], FLOW_ID);
    expect(plain.steps.get('onStep')!.outcome).toBe('');
    expect(plain.steps.get('onStep')!.tech).toBe('Http · 100ms · in[a] → out[x]');
  });

  it('drilled view: a plain (unprefixed) id must not suffix-match another node ending with the same segment', () => {
    const doc = makeDoc();
    const logs: LogLine[] = [
      // `sub/onStep` ends with `/onStep` but NOT with `/Step` etc.; also an
      // exact-id line for a different node must not bleed over.
      { timestamp: 't1', level: 'info', runId: 'run-1', nodeId: 'cond', message: 'cond outcome' },
    ];
    const drilled = projectRunbook(doc, makeRun(), logs, [], FLOW_ID, true);
    expect(drilled.steps.get('onStep')!.outcome).toBe('');
    expect(drilled.steps.get('cond')!.outcome).toBe('cond outcome');
  });

  it('tech line: no receipt yet means no #N prefix', () => {
    const doc = makeDoc();
    const run = makeRun({ nodeStates: { onStep: { status: 'idle' } } });
    const proj = projectRunbook(doc, run, [], [], FLOW_ID);
    expect(proj.steps.get('onStep')!.tech).toBe('Http');
  });

  it('reviewer note: a step whose guard says arm A still projects status "ran" from its own nodeState, independent of arm bookkeeping', () => {
    // onStep is a gated member of cond::onArm per doc.guards (rendered under
    // that arm for readability), but here it succeeds in a run driven by the
    // OTHER arm (offArm) — e.g. reached via a mapping edge, per Task 1's
    // reviewer note that guard inference and executor reachability diverge.
    // status must reflect the node's own run state, never be suppressed
    // because the "wrong" arm looks taken.
    const doc = makeDoc();
    const run = makeRun({
      nodeStates: {
        offStep: { status: 'succeeded' },
        onStep: { status: 'succeeded' },
      },
    });
    const proj = projectRunbook(doc, run, [], [], FLOW_ID);
    expect(proj.steps.get('onStep')!.status).toBe('ran');
  });

  it('arm takenNow: true when any gated member ran/failed/succeeded in the current run', () => {
    const doc = makeDoc();
    const run = makeRun({ nodeStates: { onStep: { status: 'succeeded' } } });
    const proj = projectRunbook(doc, run, [], [], FLOW_ID);
    expect(proj.arms.get('cond::onArm')!.takenNow).toBe(true);
    expect(proj.arms.get('cond::offArm')!.takenNow).toBe(false);
  });

  it('arm takenNow: true from the OWNER decision alone when the arm has no gated members (join downstream)', () => {
    // cond::joinArm has no entry in doc.guards pointing at it — its only
    // downstream node is a join whose guard set got intersected away
    // (mirrors target::belowTarget / reconcile::hold in ev-evaluate-cycle).
    const doc = makeDoc();
    doc.arms.push({ ownerId: 'cond', arm: 'joinArm' });
    const run = makeRun({ nodeStates: { cond: { status: 'succeeded', output: { $branch: 'joinArm' } } } });
    const proj = projectRunbook(doc, run, [], [], FLOW_ID);
    expect(proj.arms.get('cond::joinArm')!.takenNow).toBe(true);
  });

  it('arm coveredBy: covered via history when the owner output.$branch matches, even with no gated members', () => {
    const doc = makeDoc();
    doc.arms.push({ ownerId: 'cond', arm: 'joinArm' });
    const history: RunHistoryEntry[] = [
      {
        id: 'hist-1',
        workflowId: FLOW_ID,
        status: 'succeeded',
        startedAt: 't0',
        nodeStates: { cond: { status: 'succeeded', output: { $branch: 'joinArm' } } },
        scenarioName: 'join-scenario',
      },
    ];
    const proj = projectRunbook(doc, makeRun(), [], history, FLOW_ID);
    expect(proj.arms.get('cond::joinArm')!.coveredBy).toEqual(['join-scenario']);
    expect(proj.coverage).toEqual({ covered: 1, total: 3 });
  });

  it('coverage + coveredBy: history entries cover an arm whose member succeeded/failed there, dedup + name fallback', () => {
    const doc = makeDoc();
    const history: RunHistoryEntry[] = [
      {
        id: 'hist-1',
        workflowId: FLOW_ID,
        status: 'succeeded',
        startedAt: 't0',
        nodeStates: { offStep: { status: 'succeeded' } },
        scenarioName: 'sunset-stop',
      },
      {
        id: 'hist-2',
        workflowId: FLOW_ID,
        status: 'succeeded',
        startedAt: 't0',
        nodeStates: { offStep: { status: 'failed' } },
        scenarioName: 'sunset-stop', // dedupe
      },
      {
        id: 'hist-3',
        workflowId: 'other-flow',
        status: 'succeeded',
        startedAt: 't0',
        nodeStates: { onStep: { status: 'succeeded' } },
      },
    ];
    // current run takes neither arm
    const proj = projectRunbook(doc, makeRun(), [], history, FLOW_ID);
    expect(proj.arms.get('cond::offArm')!.coveredBy).toEqual(['sunset-stop']);
    expect(proj.arms.get('cond::onArm')!.coveredBy).toEqual([]);
    expect(proj.coverage).toEqual({ covered: 1, total: 2 });
  });

  it('coveredBy caps at 3 distinct scenario names and falls back to "manual run" when unnamed', () => {
    const doc = makeDoc();
    const history: RunHistoryEntry[] = [
      { id: 'h1', workflowId: FLOW_ID, status: 'succeeded', startedAt: 't', nodeStates: { onStep: { status: 'succeeded' } }, scenarioName: 'a' },
      { id: 'h2', workflowId: FLOW_ID, status: 'succeeded', startedAt: 't', nodeStates: { onStep: { status: 'succeeded' } }, scenarioName: 'b' },
      { id: 'h3', workflowId: FLOW_ID, status: 'succeeded', startedAt: 't', nodeStates: { onStep: { status: 'succeeded' } } },
      { id: 'h4', workflowId: FLOW_ID, status: 'succeeded', startedAt: 't', nodeStates: { onStep: { status: 'succeeded' } }, scenarioName: 'd' },
    ];
    const proj = projectRunbook(doc, makeRun(), [], history, FLOW_ID);
    expect(proj.arms.get('cond::onArm')!.coveredBy).toEqual(['a', 'b', 'manual run']);
  });

  it('loops: per-iteration status from ForEach executions, plus a running body node marks its index running', () => {
    const doc = makeDoc();
    const run = makeRun({
      nodeStates: {
        fe1: {
          status: 'running',
          executions: [
            { iteration: { index: 0, total: 3 }, status: 'succeeded' },
            { iteration: { index: 1, total: 3 }, status: 'failed' },
          ],
        },
        body1: { status: 'running', iteration: { index: 2, total: 3 } },
      },
    });
    const proj = projectRunbook(doc, run, [], [], FLOW_ID);
    expect(proj.loops.get('fe1')).toEqual({ statuses: ['done', 'failed', 'running'], count: 3 });
  });

  it('loops: no run yields an empty loop projection', () => {
    const doc = makeDoc();
    const proj = projectRunbook(doc, null, [], [], FLOW_ID);
    expect(proj.loops.get('fe1')).toEqual({ statuses: [], count: 0 });
  });

  it('iteration field is set on a loop-body step projection from its NodeRunState.iteration', () => {
    const doc = makeDoc();
    const run = makeRun({ nodeStates: { body1: { status: 'running', iteration: { index: 1, total: 3 } } } });
    const proj = projectRunbook(doc, run, [], [], FLOW_ID);
    expect(proj.steps.get('body1')!.iteration).toEqual({ index: 1, total: 3 });
    expect(proj.steps.get('onStep')!.iteration).toBeUndefined();
  });

  it('outcome on a failed node is the node error, not a stale info log', () => {
    const doc = makeDoc();
    const run = makeRun({ nodeStates: { onStep: { status: 'failed', error: 'connection refused' } } });
    const logs: LogLine[] = [
      { timestamp: 't1', level: 'info', runId: 'run-1', nodeId: 'onStep', message: 'stale success message' },
    ];
    const proj = projectRunbook(doc, run, logs, [], FLOW_ID);
    expect(proj.steps.get('onStep')!.outcome).toBe('connection refused');
  });

  it('outcome on a failed node falls back to the last info log when there is no error text', () => {
    const doc = makeDoc();
    const run = makeRun({ nodeStates: { onStep: { status: 'failed' } } });
    const logs: LogLine[] = [
      { timestamp: 't1', level: 'info', runId: 'run-1', nodeId: 'onStep', message: 'partial progress' },
    ];
    const proj = projectRunbook(doc, run, logs, [], FLOW_ID);
    expect(proj.steps.get('onStep')!.outcome).toBe('partial progress');
  });
});

describe('projectRunbook against a real flow (ev-evaluate-cycle)', () => {
  it('coverage reaches total when every branching owner has a history entry for each of its arms (incl. join-only arms like target::belowTarget / reconcile::hold)', () => {
    const doc = buildRunbook(evEvaluateCycle as unknown as WorkflowDefinition, new NodeRegistry());

    // One history entry per (ownerId, arm), recording only the owner's own
    // decision — no gated-member nodeStates at all. Before the fix,
    // target::belowTarget and reconcile::hold have zero gated members (their
    // only downstream node, `decision`, is a join whose guard set was
    // intersected away in buildGuardMap), so they could never be covered.
    const history: RunHistoryEntry[] = doc.arms.map(({ ownerId, arm }, i) => ({
      id: `hist-${i}`,
      workflowId: 'ev-evaluate-cycle',
      status: 'succeeded',
      startedAt: 't0',
      nodeStates: { [ownerId]: { status: 'succeeded', output: { $branch: arm } } },
      scenarioName: `${ownerId}::${arm}`,
    }));

    const proj = projectRunbook(doc, null, [], history, 'ev-evaluate-cycle');
    expect(proj.coverage.covered).toBe(proj.coverage.total);
    expect(proj.arms.get('target::belowTarget')!.coveredBy).toEqual(['target::belowTarget']);
    expect(proj.arms.get('reconcile::hold')!.coveredBy).toEqual(['reconcile::hold']);
  });
});

describe('iterationSummary', () => {
  it('returns the error text when the iteration failed', () => {
    const exec: ExecutionRecord = { iteration: { index: 0, total: 2 }, status: 'failed', error: 'timeout' };
    expect(iterationSummary(exec)).toBe('timeout');
  });

  it('summarizes output field names (capped at 4) when the iteration succeeded', () => {
    const exec: ExecutionRecord = {
      iteration: { index: 0, total: 2 },
      status: 'succeeded',
      output: { a: 1, b: 2, c: 3, d: 4, e: 5 },
    };
    expect(iterationSummary(exec)).toBe('→ out[a, b, c, d]');
  });

  it('summarizes an empty/missing output as an empty field list', () => {
    const exec: ExecutionRecord = { iteration: { index: 0, total: 2 }, status: 'succeeded' };
    expect(iterationSummary(exec)).toBe('→ out[]');
  });
});

describe('runSourceLabel', () => {
  it('says example data for mock runs and names the environment otherwise', () => {
    expect(runSourceLabel(true, 'dev')).toBe('on example data — nothing real executed');
    expect(runSourceLabel(false, 'dev')).toBe('against dev');
    expect(runSourceLabel(false, '')).toBe('against the default environment');
  });
});

describe('runProvenance', () => {
  function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
    return {
      id: 'run-1',
      workflowId: FLOW_ID,
      status: 'succeeded',
      startedAt: new Date().toISOString(),
      nodeStates: {},
      ...overrides,
    };
  }

  it('falls back to the live mock/environment flags for the live run (no history entry yet)', () => {
    const run = makeRun({ id: 'live-run' });
    expect(runProvenance(run, undefined, true, 'prod')).toEqual({ mock: true, environment: 'prod' });
    expect(runProvenance(run, undefined, false, 'staging')).toEqual({ mock: false, environment: 'staging' });
  });

  it('reports mock:true for a historical mocked run even while the live session is now on prod', () => {
    // Repro: run in mock mode, switch env to prod, run for real, then open
    // the OLD mocked run from history — the footer must still say mocked,
    // not "against prod".
    const run = makeRun({ id: 'old-mocked-run' });
    const historyEntry: RunHistoryEntry = { ...run, mock: true };
    expect(runProvenance(run, historyEntry, /* liveMock */ false, /* liveEnvironment */ 'prod')).toEqual({
      mock: true,
      environment: 'prod', // no environment recorded on the mock run itself — falls back to live
    });
  });

  it('uses the historical real run\'s own recorded environment, not the live selection', () => {
    const run = makeRun({ id: 'old-real-run', environment: 'staging' });
    const historyEntry: RunHistoryEntry = { ...run };
    expect(runProvenance(run, historyEntry, /* liveMock */ false, /* liveEnvironment */ 'prod')).toEqual({
      mock: false,
      environment: 'staging',
    });
  });

  it('returns the live flags when there is no run to display', () => {
    expect(runProvenance(null, undefined, true, 'dev')).toEqual({ mock: true, environment: 'dev' });
  });
});
