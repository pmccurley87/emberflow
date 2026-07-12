import type { FieldMapping, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '../engine';

/**
 * EV Charging Demo — three executable example flows for a solar/EV charge
 * scheduler. Each flow drives the pure decision logic (src/nodes/pradar/logic.ts)
 * as a graph; the vehicle / push-notification effect nodes are SIMULATED (dry-run
 * by default). Every scenario pins `now` (UTC) so the sun-clock + time gates are
 * reproducible.
 *
 * Wiring convention: a branch-gated node gets ONLY its branch edge (sourceHandle
 * = the taken branch); its data is pulled via inputMap from ancestors through the
 * branch chain. Non-gated backbone nodes use ordinary data/order edges.
 *
 * SNAPSHOT NOTE: a run reads an inverter status ({soc, ppv, loadPower,
 * gridExport}) and a vehicle status (evStatus.batteryStatus / batteryPlugin /
 * batteryCharge). The Input node is that combined snapshot, flattened for wiring
 * — homeSoc = growatt.soc, pluggedIn = (batteryPlugin ?? 0) > 0, charging =
 * batteryCharge === true, evBattery = batteryStatus.
 */

const FOLDER = 'EV Charging Demo';
const CREATED = '2026-07-03T00:00:00Z';

// Demo location (Berlin). Instants below fall in solar / golden / night windows.
const DAY = '2026-07-02T13:00:00Z'; // solar hours, ~7h to sunset
const GOLDEN = '2026-07-02T19:06:00Z'; // ~1h to sunset (golden hour)
const AFTER_SUNSET = '2026-07-02T22:00:00Z'; // dark, hour 22 (not night window)
const NIGHT = '2026-07-02T23:30:00Z'; // hour 23, night window
const DAY_HOUR = '2026-07-02T14:00:00Z'; // hour 14, day

const from = (sourceNodeId: string, sourceField: string): FieldMapping => ({ sourceNodeId, sourceField });

interface NodeSpec {
  id: string;
  type: string;
  label: string;
  x: number;
  y: number;
  config?: Record<string, unknown>;
  inputMap?: Record<string, FieldMapping>;
}

function dataEdge(id: string, source: string, target: string, targetHandle: string): WorkflowEdge {
  return { id, source, target, targetHandle };
}
function branchEdge(id: string, source: string, target: string, sourceHandle: string): WorkflowEdge {
  return { id, source, target, sourceHandle };
}
function orderEdge(id: string, source: string, target: string): WorkflowEdge {
  return { id, source, target };
}

function buildFlow(
  id: string,
  name: string,
  specs: NodeSpec[],
  edges: WorkflowEdge[],
  scenarios: WorkflowDefinition['scenarios'],
): WorkflowDefinition {
  const nodes: WorkflowNode[] = specs.map((s) => ({
    id: s.id,
    type: s.type,
    label: s.label,
    position: { x: s.x, y: s.y },
    config: s.config ?? {},
    ...(s.inputMap ? { inputMap: s.inputMap } : {}),
  }));
  return {
    id,
    name,
    version: 1,
    folder: FOLDER,
    nodes,
    edges: withMappingEdges(nodes, edges),
    scenarios,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

/**
 * Every input mapping gets a visible edge. The engine resolves inputMap with
 * or without one, but an edgeless mapping renders as a floating node and —
 * worse — the topological order can't see the data dependency. Edges make
 * the canvas honest and the ordering correct.
 */
function withMappingEdges(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowEdge[] {
  const ids = new Set(nodes.map((n) => n.id));
  const out = [...edges];
  const covered = new Set(out.map((e) => `${e.source}→${e.target}::${e.targetHandle ?? ''}`));
  const connected = new Set(out.flatMap((e) => [`${e.source}→${e.target}`]));
  for (const node of nodes) {
    for (const [field, mapping] of Object.entries(node.inputMap ?? {})) {
      if (!ids.has(mapping.sourceNodeId)) continue;
      const key = `${mapping.sourceNodeId}→${node.id}::${field}`;
      // Skip when this exact field edge exists, or a branch/select edge
      // already links the pair (gating edges double as the visual link).
      if (covered.has(key) || connected.has(`${mapping.sourceNodeId}→${node.id}`)) continue;
      covered.add(key);
      out.push({ id: `m-${node.id}-${field}`, source: mapping.sourceNodeId, target: node.id, targetHandle: field });
    }
  }
  return out;
}

// ============================================================================
// 1. EV · Evaluate Cycle — the full 5-min tick as a graph
// ============================================================================
export function createEvaluateCycleFlow(): WorkflowDefinition {
  return buildFlow(
    'ev-evaluate-cycle',
    'EV · Evaluate Cycle',
    [
      {
        id: 'input',
        type: 'Input',
        label: 'Tick Snapshot',
        x: -40,
        y: 400,
        config: {
          fields: [
            { name: 'ppv', type: 'number', required: true },
            { name: 'loadPower', type: 'number', required: true },
            { name: 'gridExport', type: 'number', required: true },
            { name: 'homeSoc', type: 'number', required: true },
            { name: 'evBattery', type: 'number' },
            { name: 'pluggedIn', type: 'boolean', required: true },
            { name: 'charging', type: 'boolean', required: true },
            { name: 'forecast', type: 'object' },
            { name: 'readings', type: 'array' },
            { name: 'state', type: 'enum', enumValues: ['idle', 'waiting', 'charging'], required: true },
            { name: 'now', type: 'datetime', required: true },
          ],
          defaults: {
            ppv: 3000, loadPower: 500, gridExport: 2500, homeSoc: 80, evBattery: 60,
            pluggedIn: true, charging: false, state: 'idle', readings: [], now: DAY,
            forecast: { remainingKwh: 20, strongHoursLeft: 5, tomorrowKwh: 25 },
          },
        },
      },
      // Env-aware live telemetry: prod pulls real inverter + vehicle readings from
      // the EV Demo service; every other env passes the scenario snapshot through. The
      // downstream nodes read the LIVE tick fields (ppv/loadPower/gridExport/
      // homeSoc/evBattery/pluggedIn/charging) from here; now/forecast/readings/
      // state stay on 'input' (not exposed per-tick by the status endpoints).
      {
        id: 'load', type: 'EvLoadTickSnapshot', label: 'Load Tick', x: 200, y: 220, inputMap: {
          ppv: from('input', 'ppv'), loadPower: from('input', 'loadPower'), gridExport: from('input', 'gridExport'),
          homeSoc: from('input', 'homeSoc'), evBattery: from('input', 'evBattery'),
          pluggedIn: from('input', 'pluggedIn'), charging: from('input', 'charging'),
          forecast: from('input', 'forecast'), readings: from('input', 'readings'),
          state: from('input', 'state'), now: from('input', 'now'),
        },
      },
      { id: 'sun', type: 'EvSunClock', label: 'Sun Clock', x: 200, y: 400, inputMap: { now: from('input', 'now') } },
      // ── top branch: solar hours vs off-hours ──
      { id: 'condSolar', type: 'Conditional', label: 'Solar Hours?', x: 440, y: 400, config: { branches: [{ name: 'solar', op: 'truthy' }], fallback: 'off' }, inputMap: { value: from('sun', 'isSolarHours') } },
      // off-hours sub-branch: night window vs stop-any-charge
      { id: 'condNight', type: 'Conditional', label: 'Night Window?', x: 680, y: 700, config: { branches: [{ name: 'night', op: 'truthy' }], fallback: 'notNight' }, inputMap: { value: from('sun', 'isNightWindow') } },
      // Night window → hand off to the standalone Night Charge flow as a subflow.
      { id: 'subflowNight', type: 'Subflow', label: 'Night Charge', x: 920, y: 820, config: { workflowId: 'ev-night-charge' }, inputMap: { evBattery: from('load', 'evBattery'), pluggedIn: from('load', 'pluggedIn'), tomorrowKwh: from('input', 'forecast.tomorrowKwh'), now: from('input', 'now') } },
      { id: 'resultNight', type: 'Result', label: 'Night Charge Result', x: 1160, y: 820, inputMap: { data: from('subflowNight', '$') } },
      { id: 'condOffCharging', type: 'Conditional', label: 'Charging Off-Hours?', x: 920, y: 640, config: { branches: [{ name: 'stop', op: 'truthy' }], fallback: 'idle' }, inputMap: { value: from('load', 'charging') } },
      { id: 'offStop', type: 'EvStopCharge', label: 'Stop Charge (sun set)', x: 1160, y: 580, config: { commit: false }, inputMap: {} },
      { id: 'notifyOff', type: 'EvNotify', label: 'Notify (sun set)', x: 1400, y: 580, config: { commit: false }, inputMap: { title: from('offStop', 'reason'), message: from('offStop', 'command') } },
      { id: 'resultOffStop', type: 'Result', label: 'Off-Hours Stop', x: 1640, y: 580, inputMap: { data: from('notifyOff', '$') } },
      { id: 'resultOffIdle', type: 'Result', label: 'Off-Hours Idle', x: 1160, y: 720, inputMap: { data: from('sun', '$') } },
      // ── solar backbone ──
      { id: 'surplus', type: 'EvComputeSurplus', label: 'Compute Surplus', x: 680, y: 360, inputMap: { ppv: from('load', 'ppv'), loadPower: from('load', 'loadPower'), gridExport: from('load', 'gridExport') } },
      { id: 'trend', type: 'EvTrendWindow', label: 'Trend Window', x: 920, y: 360, inputMap: { readings: from('input', 'readings') } },
      {
        id: 'thresholds', type: 'EvThresholds', label: 'Thresholds', x: 1160, y: 360, inputMap: {
          homeSoc: from('load', 'homeSoc'), ppv: from('load', 'ppv'), sunHoursLeft: from('sun', 'hoursUntilSunset'),
          evBattery: from('load', 'evBattery'), forecast: from('input', 'forecast'),
          surplusTrend: from('trend', 'surplusTrend'), socTrend: from('trend', 'socTrend'),
        },
      },
      { id: 'resultSkip', type: 'Result', label: 'Holding Off (skip)', x: 1400, y: 200, inputMap: { data: from('thresholds', '$') } },
      {
        id: 'target', type: 'EvTargetCheck', label: 'Target Check', x: 1400, y: 360, inputMap: {
          pluggedIn: from('load', 'pluggedIn'), evBattery: from('load', 'evBattery'),
          isSolarHours: from('sun', 'isSolarHours'), charging: from('load', 'charging'),
        },
      },
      { id: 'resultNotPlugged', type: 'Result', label: 'Not Plugged In', x: 1640, y: 160, inputMap: { data: from('target', '$') } },
      // atTarget → stop + notify
      { id: 'stopAtTarget', type: 'EvStopCharge', label: 'Stop (at target)', x: 1640, y: 280, config: { commit: false }, inputMap: { reason: from('target', 'reason') } },
      { id: 'notifyAtTarget', type: 'EvNotify', label: 'Notify (at target)', x: 1880, y: 280, config: { commit: false }, inputMap: { title: from('stopAtTarget', 'reason'), message: from('stopAtTarget', 'command') } },
      { id: 'resultAtTarget', type: 'Result', label: 'EV At Target', x: 2120, y: 280, inputMap: { data: from('notifyAtTarget', '$') } },
      // belowTarget → unscheduled guard
      {
        id: 'guard', type: 'EvUnscheduledGuard', label: 'Unscheduled Guard', x: 1640, y: 440, inputMap: {
          charging: from('load', 'charging'), state: from('input', 'state'), surplus: from('surplus', 'surplus'),
          startW: from('thresholds', 'startW'), skipReason: from('thresholds', 'skipReason'), homeSoc: from('load', 'homeSoc'),
        },
      },
      // guard stop → stop + notify
      { id: 'stopUnsched', type: 'EvStopCharge', label: 'Stop (unscheduled)', x: 1880, y: 560, config: { commit: false }, inputMap: { reason: from('guard', 'reason') } },
      { id: 'notifyUnsched', type: 'EvNotify', label: 'Notify (unscheduled)', x: 2120, y: 560, config: { commit: false }, inputMap: { title: from('stopUnsched', 'reason'), message: from('stopUnsched', 'command') } },
      { id: 'resultUnsched', type: 'Result', label: 'Unscheduled Stopped', x: 2360, y: 560, inputMap: { data: from('notifyUnsched', '$') } },
      // guard continue → reconcile
      { id: 'reconcile', type: 'EvReconcile', label: 'Reconcile', x: 1880, y: 440, inputMap: { charging: from('load', 'charging'), state: from('input', 'state') } },
      { id: 'resultAdopt', type: 'Result', label: 'Adopted (charging continues)', x: 2120, y: 380, inputMap: { data: from('reconcile', '$') } },
      // reconcile hold → charge decision
      {
        id: 'decision', type: 'EvChargeDecision', label: 'Charge Decision', x: 2120, y: 460, inputMap: {
          state: from('input', 'state'), surplus: from('surplus', 'surplus'), startW: from('thresholds', 'startW'),
          stopW: from('thresholds', 'stopW'), homeSoc: from('load', 'homeSoc'), skipReason: from('thresholds', 'skipReason'),
        },
      },
      // decision start → start + notify
      { id: 'startCharge', type: 'EvStartCharge', label: 'Start Charge', x: 2360, y: 300, config: { commit: false }, inputMap: { reason: from('decision', 'reason') } },
      { id: 'notifyStart', type: 'EvNotify', label: 'Notify (start)', x: 2600, y: 300, config: { commit: false }, inputMap: { title: from('startCharge', 'reason'), message: from('startCharge', 'command') } },
      { id: 'resultStart', type: 'Result', label: 'Charge Started', x: 2840, y: 300, inputMap: { data: from('notifyStart', '$') } },
      // decision stop → stop + notify
      { id: 'stopCharge', type: 'EvStopCharge', label: 'Stop Charge', x: 2360, y: 440, config: { commit: false }, inputMap: { reason: from('decision', 'reason') } },
      { id: 'notifyStop', type: 'EvNotify', label: 'Notify (stop)', x: 2600, y: 440, config: { commit: false }, inputMap: { title: from('stopCharge', 'reason'), message: from('stopCharge', 'command') } },
      { id: 'resultStop', type: 'Result', label: 'Charge Stopped', x: 2840, y: 440, inputMap: { data: from('notifyStop', '$') } },
      // decision holds
      { id: 'resultHoldWaiting', type: 'Result', label: 'Hold (waiting)', x: 2360, y: 560, inputMap: { data: from('decision', '$') } },
      { id: 'resultHoldCharging', type: 'Result', label: 'Hold (charging)', x: 2360, y: 660, inputMap: { data: from('decision', '$') } },
    ],
    [
      orderEdge('eLoad', 'input', 'load'),
      dataEdge('e0', 'input', 'sun', 'now'),
      dataEdge('e1', 'sun', 'condSolar', 'value'),
      // off-hours
      branchEdge('e2', 'condSolar', 'condNight', 'off'),
      dataEdge('e3', 'sun', 'condNight', 'value'),
      branchEdge('e4', 'condNight', 'subflowNight', 'night'),
      dataEdge('e4b', 'subflowNight', 'resultNight', 'data'),
      branchEdge('e5', 'condNight', 'condOffCharging', 'notNight'),
      dataEdge('e6', 'load', 'condOffCharging', 'value'),
      branchEdge('e7', 'condOffCharging', 'offStop', 'stop'),
      dataEdge('e8', 'offStop', 'notifyOff', 'title'),
      dataEdge('e9', 'notifyOff', 'resultOffStop', 'data'),
      branchEdge('e10', 'condOffCharging', 'resultOffIdle', 'idle'),
      // solar backbone
      branchEdge('e11', 'condSolar', 'surplus', 'solar'),
      dataEdge('e11b', 'load', 'surplus', 'ppv'),
      orderEdge('e12', 'surplus', 'trend'),
      orderEdge('e13', 'trend', 'thresholds'),
      // thresholds skip/ok
      branchEdge('e14', 'thresholds', 'resultSkip', 'skip'),
      branchEdge('e15', 'thresholds', 'target', 'ok'),
      // target branches
      branchEdge('e16', 'target', 'resultNotPlugged', 'notPlugged'),
      branchEdge('e17', 'target', 'stopAtTarget', 'atTarget'),
      dataEdge('e18', 'stopAtTarget', 'notifyAtTarget', 'title'),
      dataEdge('e19', 'notifyAtTarget', 'resultAtTarget', 'data'),
      branchEdge('e20', 'target', 'guard', 'belowTarget'),
      // guard branches
      branchEdge('e21', 'guard', 'stopUnsched', 'stop'),
      dataEdge('e22', 'stopUnsched', 'notifyUnsched', 'title'),
      dataEdge('e23', 'notifyUnsched', 'resultUnsched', 'data'),
      branchEdge('e24', 'guard', 'reconcile', 'continue'),
      // reconcile branches
      branchEdge('e25', 'reconcile', 'resultAdopt', 'adopt'),
      branchEdge('e26', 'reconcile', 'decision', 'hold'),
      // decision branches
      branchEdge('e27', 'decision', 'startCharge', 'start'),
      dataEdge('e28', 'startCharge', 'notifyStart', 'title'),
      dataEdge('e29', 'notifyStart', 'resultStart', 'data'),
      branchEdge('e30', 'decision', 'stopCharge', 'stop'),
      dataEdge('e31', 'stopCharge', 'notifyStop', 'title'),
      dataEdge('e32', 'notifyStop', 'resultStop', 'data'),
      branchEdge('e33', 'decision', 'resultHoldWaiting', 'hold_waiting'),
      branchEdge('e34', 'decision', 'resultHoldCharging', 'hold_charging'),
    ],
    [
      { id: 'scn-sunny-start', name: 'sunny-start', description: 'Strong export (2500W), home 80%, EV 60% → start charge.', input: { now: DAY, ppv: 3000, loadPower: 500, gridExport: 2500, homeSoc: 80, evBattery: 60, pluggedIn: true, charging: false, state: 'idle', readings: [], forecast: { remainingKwh: 20, strongHoursLeft: 5, tomorrowKwh: 25 } } },
      { id: 'scn-cloudy-hold', name: 'cloudy-hold', description: 'Flat 900W surplus below the 1200W buffer start → hold waiting.', input: { now: DAY, ppv: 1400, loadPower: 500, gridExport: 0, homeSoc: 50, evBattery: 60, pluggedIn: true, charging: false, state: 'waiting', readings: [], forecast: { remainingKwh: 8, strongHoursLeft: 2, tomorrowKwh: 15 } } },
      { id: 'scn-golden-hour-start', name: 'golden-hour-start', description: '~1h to sunset pulls start to 800W; 900W surplus → start.', input: { now: GOLDEN, ppv: 1000, loadPower: 100, gridExport: 0, homeSoc: 50, evBattery: 60, pluggedIn: true, charging: false, state: 'idle', readings: [], forecast: { remainingKwh: 2, strongHoursLeft: 1, tomorrowKwh: 15 } } },
      { id: 'scn-predictive-export', name: 'predictive-export', description: 'Home 95% + ppv 3000W → predictive 500W start; 600W surplus → start.', input: { now: DAY, ppv: 3000, loadPower: 200, gridExport: 600, homeSoc: 95, evBattery: 60, pluggedIn: true, charging: false, state: 'idle', readings: [], forecast: { remainingKwh: 20, strongHoursLeft: 5, tomorrowKwh: 25 } } },
      { id: 'scn-urgent-ev', name: 'urgent-ev', description: 'EV 40% (<50) → urgent 1200W start; 1300W surplus → start.', input: { now: DAY, ppv: 1800, loadPower: 500, gridExport: 0, homeSoc: 50, evBattery: 40, pluggedIn: true, charging: false, state: 'idle', readings: [], forecast: { remainingKwh: 15, strongHoursLeft: 4, tomorrowKwh: 20 } } },
      { id: 'scn-flat-home-blocked', name: 'flat-home-blocked', description: 'Flat home 10% keeps 2000W start; 1500W surplus → hold waiting.', input: { now: DAY, ppv: 2000, loadPower: 500, gridExport: 0, homeSoc: 10, evBattery: 60, pluggedIn: true, charging: false, state: 'waiting', readings: [], forecast: { remainingKwh: 15, strongHoursLeft: 4, tomorrowKwh: 20 } } },
      { id: 'scn-not-worth-it', name: 'not-worth-it', description: 'EV 70% with only ~0.8kWh solar left → worth-it skip.', input: { now: DAY, ppv: 800, loadPower: 300, gridExport: 0, homeSoc: 50, evBattery: 70, pluggedIn: true, charging: false, state: 'idle', readings: [], forecast: { remainingKwh: 0.8, strongHoursLeft: 0, tomorrowKwh: 20 } } },
      { id: 'scn-charging-continue', name: 'charging-continue', description: 'Already charging, 900W above the 400W stop → hold charging.', input: { now: DAY, ppv: 1400, loadPower: 500, gridExport: 0, homeSoc: 50, evBattery: 60, pluggedIn: true, charging: true, state: 'charging', readings: [], forecast: { remainingKwh: 8, strongHoursLeft: 2, tomorrowKwh: 15 } } },
      { id: 'scn-charging-stop', name: 'charging-stop', description: 'Charging but surplus fell to 300W (<400 stop) → stop charge.', input: { now: DAY, ppv: 800, loadPower: 500, gridExport: 0, homeSoc: 50, evBattery: 60, pluggedIn: true, charging: true, state: 'charging', readings: [], forecast: { remainingKwh: 6, strongHoursLeft: 1, tomorrowKwh: 15 } } },
      { id: 'scn-unscheduled-stop', name: 'unscheduled-stop', description: 'Car charging but state idle and 700W < 1200W start → unscheduled stop.', input: { now: DAY, ppv: 1200, loadPower: 500, gridExport: 0, homeSoc: 80, evBattery: 60, pluggedIn: true, charging: true, state: 'idle', readings: [], forecast: { remainingKwh: 10, strongHoursLeft: 3, tomorrowKwh: 15 } } },
      { id: 'scn-reconcile-adopt', name: 'reconcile-adopt', description: 'Car charging, state waiting, 2500W clears start → adopt the session.', input: { now: DAY, ppv: 3000, loadPower: 500, gridExport: 2500, homeSoc: 80, evBattery: 60, pluggedIn: true, charging: true, state: 'waiting', readings: [], forecast: { remainingKwh: 20, strongHoursLeft: 5, tomorrowKwh: 25 } } },
      { id: 'scn-ev-at-target', name: 'ev-at-target', description: 'EV 91% ≥ 90% solar target → at-target stop.', input: { now: DAY, ppv: 2000, loadPower: 500, gridExport: 0, homeSoc: 80, evBattery: 91, pluggedIn: true, charging: false, state: 'idle', readings: [], forecast: null } },
      { id: 'scn-unplugged', name: 'unplugged', description: 'EV not plugged in → notPlugged.', input: { now: DAY, ppv: 2000, loadPower: 500, gridExport: 0, homeSoc: 80, evBattery: 60, pluggedIn: false, charging: false, state: 'idle', readings: [], forecast: null } },
      { id: 'scn-sunset-stop', name: 'sunset-stop', description: 'now 22:00 (sun set), charging → off-hours stop.', input: { now: AFTER_SUNSET, ppv: 0, loadPower: 400, gridExport: 0, homeSoc: 50, evBattery: 60, pluggedIn: true, charging: true, state: 'charging', readings: [], forecast: null } },
      { id: 'scn-trend-rising', name: 'trend-rising', description: 'Readings ramp +300W/cycle → trend override lowers start to 1000W; 1100W surplus → start.', input: { now: DAY, ppv: 1600, loadPower: 500, gridExport: 0, homeSoc: 10, evBattery: 60, pluggedIn: true, charging: false, state: 'idle', readings: [{ surplus: 200, homeSoc: 10, ppv: 800 }, { surplus: 500, homeSoc: 10, ppv: 1100 }, { surplus: 800, homeSoc: 10, ppv: 1400 }, { surplus: 1100, homeSoc: 10, ppv: 1600 }], forecast: { remainingKwh: 15, strongHoursLeft: 4, tomorrowKwh: 20 } } },
      { id: 'scn-night-charge', name: 'night-charge', description: 'now 23:30 (night window), EV 30% (<35) → Night Charge subflow charges.', input: { now: NIGHT, ppv: 0, loadPower: 400, gridExport: 0, homeSoc: 50, evBattery: 30, pluggedIn: true, charging: false, state: 'idle', readings: [], forecast: { remainingKwh: 0, strongHoursLeft: 0, tomorrowKwh: 24 } } },
    ],
  );
}

// ============================================================================
// 2. EV · Threshold Intelligence — the intelligence layers, isolated
// ============================================================================
export function createThresholdIntelligenceFlow(): WorkflowDefinition {
  return buildFlow(
    'ev-threshold-intelligence',
    'EV · Threshold Intelligence',
    [
      {
        id: 'input',
        type: 'Input',
        label: 'Intelligence Inputs',
        x: -40,
        y: 240,
        config: {
          fields: [
            { name: 'homeSoc', type: 'number', required: true },
            { name: 'ppv', type: 'number', required: true },
            { name: 'sunHoursLeft', type: 'number', required: true },
            { name: 'evBattery', type: 'number' },
            { name: 'forecast', type: 'object' },
            { name: 'surplusTrend', type: 'number' },
            { name: 'socTrend', type: 'number' },
            { name: 'target', type: 'number' },
          ],
          // sunHoursLeft is supplied directly (no sun clock) so this focused flow
          // stays deterministic without pinning a `now`.
          defaults: { homeSoc: 50, ppv: 1500, sunHoursLeft: 4, evBattery: 60, surplusTrend: 0, socTrend: 0, target: 80, forecast: { remainingKwh: 15, strongHoursLeft: 4 } },
        },
      },
      {
        id: 'thresholds', type: 'EvThresholds', label: 'Thresholds', x: 220, y: 160, inputMap: {
          homeSoc: from('input', 'homeSoc'), ppv: from('input', 'ppv'), sunHoursLeft: from('input', 'sunHoursLeft'),
          evBattery: from('input', 'evBattery'), forecast: from('input', 'forecast'),
          surplusTrend: from('input', 'surplusTrend'), socTrend: from('input', 'socTrend'),
        },
      },
      { id: 'resultOk', type: 'Result', label: 'Thresholds (ok)', x: 460, y: 60, inputMap: { data: from('thresholds', '$') } },
      { id: 'resultSkip', type: 'Result', label: 'Thresholds (skip)', x: 460, y: 200, inputMap: { data: from('thresholds', '$') } },
      {
        id: 'estimate', type: 'EvSessionEstimate', label: 'Session Estimate', x: 220, y: 360, inputMap: {
          evBattery: from('input', 'evBattery'), target: from('input', 'target'), ppv: from('input', 'ppv'),
          sunHoursLeft: from('input', 'sunHoursLeft'), forecast: from('input', 'forecast'),
        },
      },
      { id: 'resultEstimate', type: 'Result', label: 'Worth-It Estimate', x: 460, y: 360, inputMap: { data: from('estimate', '$') } },
    ],
    [
      dataEdge('e0', 'input', 'thresholds', 'homeSoc'),
      branchEdge('e1', 'thresholds', 'resultOk', 'ok'),
      branchEdge('e2', 'thresholds', 'resultSkip', 'skip'),
      dataEdge('e3', 'input', 'estimate', 'evBattery'),
      dataEdge('e4', 'estimate', 'resultEstimate', 'data'),
    ],
    [
      { id: 'scn-urgent', name: 'urgent (EV <50%)', description: 'EV 40% → urgent band 1200/400.', input: { homeSoc: 20, ppv: 1500, sunHoursLeft: 4, evBattery: 40, forecast: { remainingKwh: 15, strongHoursLeft: 4 }, surplusTrend: 0, socTrend: 0, target: 80 } },
      { id: 'scn-buffer', name: 'home buffer', description: 'Home 60% (≥30) → buffer band 1200/400.', input: { homeSoc: 60, ppv: 300, sunHoursLeft: 4, evBattery: 60, forecast: { remainingKwh: 15, strongHoursLeft: 4 }, surplusTrend: 0, socTrend: 0, target: 80 } },
      { id: 'scn-flat', name: 'flat home', description: 'Home 10% flat, EV not urgent → default 2000/800.', input: { homeSoc: 10, ppv: 1500, sunHoursLeft: 4, evBattery: 70, forecast: { remainingKwh: 15, strongHoursLeft: 4 }, surplusTrend: 0, socTrend: 0, target: 80 } },
      { id: 'scn-predictive', name: 'predictive export', description: 'Home 95% + ppv 2200W → predictive 500/200.', input: { homeSoc: 95, ppv: 2200, sunHoursLeft: 4, evBattery: 60, forecast: { remainingKwh: 15, strongHoursLeft: 4 }, surplusTrend: 0, socTrend: 0, target: 80 } },
      { id: 'scn-golden', name: 'golden hour', description: '1.5h to sunset → golden hour ≤800/200.', input: { homeSoc: 10, ppv: 900, sunHoursLeft: 1.5, evBattery: 60, forecast: { remainingKwh: 3, strongHoursLeft: 1 }, surplusTrend: 0, socTrend: 0, target: 80 } },
      { id: 'scn-worth-it-skip', name: 'worth-it skip', description: 'EV 70% with 0.8kWh remaining → skip branch.', input: { homeSoc: 50, ppv: 300, sunHoursLeft: 1, evBattery: 70, forecast: { remainingKwh: 0.8, strongHoursLeft: 0 }, surplusTrend: 0, socTrend: 0, target: 90 } },
      { id: 'scn-trend-surplus', name: 'trend: surplus rising', description: 'surplusTrend 300 → start ≤1000.', input: { homeSoc: 10, ppv: 1500, sunHoursLeft: 4, evBattery: 60, forecast: { remainingKwh: 15, strongHoursLeft: 4 }, surplusTrend: 300, socTrend: 0, target: 80 } },
      { id: 'scn-trend-soc', name: 'trend: SOC rising', description: 'socTrend 3 with home 80% → start ≤600.', input: { homeSoc: 80, ppv: 1500, sunHoursLeft: 4, evBattery: 60, forecast: { remainingKwh: 15, strongHoursLeft: 4 }, surplusTrend: 0, socTrend: 3, target: 80 } },
    ],
  );
}

// ============================================================================
// 3. EV · Night Charge — the overnight grid-charge decision
// ============================================================================
export function createNightChargeFlow(): WorkflowDefinition {
  return buildFlow(
    'ev-night-charge',
    'EV · Night Charge',
    [
      {
        id: 'input',
        type: 'Input',
        label: 'Night Snapshot',
        x: -40,
        y: 240,
        config: {
          fields: [
            { name: 'evBattery', type: 'number', required: true },
            { name: 'pluggedIn', type: 'boolean', required: true },
            { name: 'tomorrowKwh', type: 'number' },
            { name: 'alreadyTriggeredToday', type: 'boolean' },
            { name: 'now', type: 'datetime', required: true },
          ],
          defaults: { evBattery: 30, pluggedIn: true, tomorrowKwh: 24, alreadyTriggeredToday: false, now: NIGHT },
        },
      },
      { id: 'sun', type: 'EvSunClock', label: 'Sun Clock', x: 220, y: 240, inputMap: { now: from('input', 'now') } },
      {
        id: 'night', type: 'EvNightChargeDecision', label: 'Night Charge Decision', x: 460, y: 240, inputMap: {
          evBattery: from('input', 'evBattery'), pluggedIn: from('input', 'pluggedIn'),
          tomorrowKwh: from('input', 'tomorrowKwh'), hour: from('sun', 'hour'),
          alreadyTriggeredToday: from('input', 'alreadyTriggeredToday'),
        },
      },
      { id: 'resultSkip', type: 'Result', label: 'Skip Night Charge', x: 700, y: 380, inputMap: { data: from('night', '$') } },
      // charge branch: start → notify
      { id: 'startCharge', type: 'EvStartCharge', label: 'Start Charge (grid)', x: 700, y: 160, config: { commit: false }, inputMap: {} },
      { id: 'notify', type: 'EvNotify', label: 'Notify (night charge)', x: 940, y: 160, config: { commit: false }, inputMap: { title: from('startCharge', 'reason'), message: from('startCharge', 'command') } },
      { id: 'result', type: 'Result', label: 'Night Charge Started', x: 1180, y: 160, inputMap: { data: from('notify', '$') } },
    ],
    [
      dataEdge('e0', 'input', 'sun', 'now'),
      orderEdge('e1', 'sun', 'night'),
      dataEdge('e2', 'sun', 'night', 'hour'),
      branchEdge('e3', 'night', 'startCharge', 'charge'),
      dataEdge('e4', 'startCharge', 'notify', 'title'),
      dataEdge('e5', 'notify', 'result', 'data'),
      branchEdge('e6', 'night', 'resultSkip', 'skip'),
    ],
    [
      { id: 'scn-critical-35', name: 'critical-35', description: 'EV 30% (<35) at 23:30 → charge regardless of forecast.', input: { evBattery: 30, pluggedIn: true, tomorrowKwh: 24, alreadyTriggeredToday: false, now: NIGHT } },
      { id: 'scn-moderate-poor-forecast', name: 'moderate-poor-forecast', description: 'EV 55% with poor tomorrow (6kWh) at night → charge.', input: { evBattery: 55, pluggedIn: true, tomorrowKwh: 6, alreadyTriggeredToday: false, now: NIGHT } },
      { id: 'scn-moderate-good-forecast', name: 'moderate-good-forecast', description: 'EV 55% with good tomorrow (20kWh) → skip.', input: { evBattery: 55, pluggedIn: true, tomorrowKwh: 20, alreadyTriggeredToday: false, now: NIGHT } },
      { id: 'scn-wrong-hour', name: 'wrong-hour', description: 'EV 30% but 14:00 (outside 23–05) → skip.', input: { evBattery: 30, pluggedIn: true, tomorrowKwh: 6, alreadyTriggeredToday: false, now: DAY_HOUR } },
      { id: 'scn-already-triggered', name: 'already-triggered', description: 'EV 30% at night but already triggered today → skip.', input: { evBattery: 30, pluggedIn: true, tomorrowKwh: 6, alreadyTriggeredToday: true, now: NIGHT } },
      { id: 'scn-unplugged-night', name: 'unplugged-night', description: 'EV 30% at night but not plugged in → skip.', input: { evBattery: 30, pluggedIn: false, tomorrowKwh: 6, alreadyTriggeredToday: false, now: NIGHT } },
    ],
  );
}

export function createPradarFlows(): WorkflowDefinition[] {
  return [createEvaluateCycleFlow(), createThresholdIntelligenceFlow(), createNightChargeFlow()];
}
