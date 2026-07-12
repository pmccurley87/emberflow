import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../nodes';
import { runOutput, startRun, validateFlow } from '../engine';
import type { StartRunOptions, WorkflowDefinition } from '../engine';
import { createPradarFlows } from './pradar-flows';

const registry = createDefaultRegistry(0);
const flows = createPradarFlows();

const EXPECTED_IDS = ['ev-evaluate-cycle', 'ev-threshold-intelligence', 'ev-night-charge'];
const NIGHT = '2026-07-02T23:30:00Z'; // hour 23, night window (mirrors pradar-flows.ts)

function flow(id: string): WorkflowDefinition {
  const f = flows.find((x) => x.id === id);
  if (!f) throw new Error(`no flow ${id}`);
  return f;
}
function scenarioInput(id: string, name: string): Record<string, unknown> {
  const scn = flow(id).scenarios!.find((s) => s.name === name);
  if (!scn) throw new Error(`no scenario ${name} in ${id}`);
  return scn.input;
}
function branchOf(run: Awaited<ReturnType<ReturnType<typeof startRun>['runToEnd']>>, nodeId: string): string | undefined {
  return (run.nodeStates[nodeId]?.output as { $branch?: string } | undefined)?.$branch;
}

describe('EV Demo flows', () => {
  it('exports the three expected flows with stable ids + folder', () => {
    expect(flows.map((f) => f.id)).toEqual(EXPECTED_IDS);
    for (const f of flows) {
      expect(f.folder).toBe('EV Charging Demo');
      expect(f.createdAt).toBe('2026-07-03T00:00:00Z');
    }
  });

  for (const f of flows) {
    describe(f.name, () => {
      it('validates with no errors', () => {
        const errors = validateFlow(f, registry).filter((i) => i.severity === 'error');
        expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
      });
      it('uses only registered node types', () => {
        for (const node of f.nodes) expect(registry.has(node.type), `${f.id}: ${node.type}`).toBe(true);
      });
    });
  }

  // ── Evaluate Cycle: drive representative scenarios end-to-end ──────────────
  async function runCycle(name: string) {
    return startRun({ flow: flow('ev-evaluate-cycle'), registry, input: scenarioInput('ev-evaluate-cycle', name) }).runToEnd();
  }

  it('sunny-start → charge decision starts and Start Charge dry-runs', async () => {
    const run = await runCycle('sunny-start');
    expect(run.status).toBe('succeeded');
    expect(branchOf(run, 'thresholds')).toBe('ok');
    expect(branchOf(run, 'target')).toBe('belowTarget');
    expect(branchOf(run, 'decision')).toBe('start');
    expect(run.nodeStates.startCharge.status).toBe('succeeded');
    expect((run.nodeStates.startCharge.output as { sent: boolean; wouldSend: string }).sent).toBe(false);
    expect((run.nodeStates.startCharge.output as { wouldSend: string }).wouldSend).toBe('start');
    expect(run.nodeStates.stopCharge.status).toBe('skipped');
  });

  it('not-worth-it → thresholds skip branch, no target check', async () => {
    const run = await runCycle('not-worth-it');
    expect(run.status).toBe('succeeded');
    expect(branchOf(run, 'thresholds')).toBe('skip');
    expect(run.nodeStates.resultSkip.status).toBe('succeeded');
    expect(run.nodeStates.target.status).toBe('skipped');
  });

  it('charging-stop → charge decision stops', async () => {
    const run = await runCycle('charging-stop');
    expect(branchOf(run, 'decision')).toBe('stop');
    expect(run.nodeStates.stopCharge.status).toBe('succeeded');
    expect(run.nodeStates.startCharge.status).toBe('skipped');
  });

  it('unscheduled-stop → guard stops the unscheduled charge', async () => {
    const run = await runCycle('unscheduled-stop');
    expect(branchOf(run, 'guard')).toBe('stop');
    expect(run.nodeStates.stopUnsched.status).toBe('succeeded');
    expect(run.nodeStates.decision.status).toBe('skipped');
  });

  it('reconcile-adopt → guard continues, reconcile adopts', async () => {
    const run = await runCycle('reconcile-adopt');
    expect(branchOf(run, 'guard')).toBe('continue');
    expect(branchOf(run, 'reconcile')).toBe('adopt');
    expect(run.nodeStates.resultAdopt.status).toBe('succeeded');
    expect(run.nodeStates.decision.status).toBe('skipped');
  });

  it('ev-at-target → target atTarget, stop at target', async () => {
    const run = await runCycle('ev-at-target');
    expect(branchOf(run, 'target')).toBe('atTarget');
    expect(run.nodeStates.stopAtTarget.status).toBe('succeeded');
    expect(run.nodeStates.guard.status).toBe('skipped');
  });

  it('unplugged → target notPlugged', async () => {
    const run = await runCycle('unplugged');
    expect(branchOf(run, 'target')).toBe('notPlugged');
    expect(run.nodeStates.resultNotPlugged.status).toBe('succeeded');
  });

  it('sunset-stop → off-hours branch stops the charge', async () => {
    const run = await runCycle('sunset-stop');
    expect(branchOf(run, 'condSolar')).toBe('off');
    expect(branchOf(run, 'condNight')).toBe('notNight');
    expect(branchOf(run, 'condOffCharging')).toBe('stop');
    expect(run.nodeStates.offStop.status).toBe('succeeded');
    expect(run.nodeStates.surplus.status).toBe('skipped');
  });

  it('trend-rising → trend override lowers start, decision starts', async () => {
    const run = await runCycle('trend-rising');
    expect((run.nodeStates.trend.output as { surplusTrend: number }).surplusTrend).toBe(300);
    expect((run.nodeStates.thresholds.output as { startW: number }).startW).toBe(1000);
    expect(branchOf(run, 'decision')).toBe('start');
  });

  it('charging-continue → holds the charging session', async () => {
    const run = await runCycle('charging-continue');
    expect(branchOf(run, 'decision')).toBe('hold_charging');
    expect(run.nodeStates.resultHoldCharging.status).toBe('succeeded');
  });

  // A host subflow runner that resolves child flows from this flow set and runs
  // them on the same registry — the test-side mirror of the browser/server host.
  const hostRunner: NonNullable<StartRunOptions['subflowRunner']> = async (workflowId, input) => {
    const child = flows.find((f) => f.id === workflowId);
    if (!child) return { status: 'failed', error: `Unknown workflow: ${workflowId}` };
    const childRun = await startRun({ flow: child, registry, input, subflowRunner: hostRunner }).runToEnd();
    if (childRun.status !== 'succeeded') return { status: 'failed', error: childRun.status };
    return { status: 'succeeded', output: runOutput(childRun, child) };
  };

  it('night-charge → routes the night window through the Night Charge subflow', async () => {
    const run = await startRun({
      flow: flow('ev-evaluate-cycle'),
      registry,
      input: scenarioInput('ev-evaluate-cycle', 'night-charge'),
      subflowRunner: hostRunner,
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(branchOf(run, 'condSolar')).toBe('off');
    expect(branchOf(run, 'condNight')).toBe('night');
    expect(run.nodeStates.subflowNight.status).toBe('succeeded');

    // The subflow's decision matches running Night Charge standalone with the
    // same derived snapshot (EV 30% at 23:30, plugged in) — a critical charge.
    const childInput = { evBattery: 30, pluggedIn: true, tomorrowKwh: 24, now: NIGHT };
    const standalone = await startRun({ flow: flow('ev-night-charge'), registry, input: childInput }).runToEnd();
    expect(branchOf(standalone, 'night')).toBe('charge');
    expect(run.nodeStates.subflowNight.output).toEqual(runOutput(standalone, flow('ev-night-charge')));
    expect((run.nodeStates.resultNight.output as { data: unknown }).data).toEqual(
      runOutput(standalone, flow('ev-night-charge')),
    );
  });

  // ── Night Charge ──────────────────────────────────────────────────────────
  async function runNight(name: string) {
    return startRun({ flow: flow('ev-night-charge'), registry, input: scenarioInput('ev-night-charge', name) }).runToEnd();
  }

  it('critical-35 → charges', async () => {
    const run = await runNight('critical-35');
    expect(branchOf(run, 'night')).toBe('charge');
    expect(run.nodeStates.startCharge.status).toBe('succeeded');
  });
  it('moderate-good-forecast → skips', async () => {
    const run = await runNight('moderate-good-forecast');
    expect(branchOf(run, 'night')).toBe('skip');
    expect(run.nodeStates.startCharge.status).toBe('skipped');
  });
  it('wrong-hour → skips on the night-window gate', async () => {
    const run = await runNight('wrong-hour');
    expect(branchOf(run, 'night')).toBe('skip');
    expect((run.nodeStates.night.output as { gateReason: string }).gateReason).toContain('night window');
  });
  it('unplugged-night → skips on the plugged-in gate', async () => {
    const run = await runNight('unplugged-night');
    expect(branchOf(run, 'night')).toBe('skip');
    expect((run.nodeStates.night.output as { gateReason: string }).gateReason).toContain('plugged');
  });

  // ── Threshold Intelligence ──────────────────────────────────────────────
  async function runThresh(name: string) {
    return startRun({ flow: flow('ev-threshold-intelligence'), registry, input: scenarioInput('ev-threshold-intelligence', name) }).runToEnd();
  }
  it('predictive export → 500/200', async () => {
    const run = await runThresh('predictive export');
    const out = run.nodeStates.thresholds.output as { startW: number; stopW: number };
    expect(out.startW).toBe(500);
    expect(out.stopW).toBe(200);
  });
  it('worth-it skip → skip branch + estimate not worth it', async () => {
    const run = await runThresh('worth-it skip');
    expect(branchOf(run, 'thresholds')).toBe('skip');
    expect((run.nodeStates.estimate.output as { worthIt: boolean }).worthIt).toBe(false);
  });
});
