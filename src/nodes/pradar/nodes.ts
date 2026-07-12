import type { NodeExecutionContext, NodeRegistry } from '../../engine';
import {
  checkTarget,
  computeSurplus,
  computeTrendWindow,
  decideCharge,
  estimateSessionKwh,
  evKwhNeeded,
  EV_TARGET_BATTERY,
  getNightChargeDecision,
  getThresholds,
  MIN_SESSION_KWH,
  morningSummary,
  nightChargeEstimate,
  reconcile,
  shouldStopUnscheduledCharge,
  sunTimes,
  type EvChargeState,
  type Forecast,
  type Reading,
} from './logic';

/**
 * EV charge scheduler — Emberflow registry nodes for the EV charging demo. Each
 * node wraps a pure function from ./logic and echoes its salient inputs back
 * through its output so downstream nodes stay attributable in the run trace.
 * Branching nodes emit `$branch` directly (like Route/Conditional) so a flow can
 * gate the next node on the decision without a separate Conditional.
 *
 * Nothing here talks to real hardware: the vehicle / push-notification effect
 * nodes are SIMULATED (see each PORT NOTE).
 */

// ── coercion helpers ────────────────────────────────────────────────────────
function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(v: unknown): boolean {
  return v === true || v === 'true';
}
function asForecast(v: unknown): Forecast | null {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.remainingKwh !== undefined || o.strongHoursLeft !== undefined) {
      return { remainingKwh: num(o.remainingKwh), strongHoursLeft: num(o.strongHoursLeft) };
    }
  }
  return null;
}
function asReadings(v: unknown): Reading[] {
  if (!Array.isArray(v)) return [];
  return v.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return { surplus: num(o.surplus), homeSoc: num(o.homeSoc), ppv: num(o.ppv), time: o.time as number | undefined };
  });
}

// ── live telemetry (EvLoadTickSnapshot) ─────────────────────────────────────
/**
 * Reads the run's secret or throws an actionable error — live telemetry needs
 * the EV Demo base URL and only the server runner has it.
 */
function requireSecret(ctx: NodeExecutionContext, name: string): string {
  const value = ctx.secrets[name];
  if (!value) {
    throw new Error(
      `Missing secret ${name} — select an environment that provides it (e.g. production) and run on the server. Live EV telemetry needs the EV Demo base URL; the browser and the local environment don't have ${name}.`,
    );
  }
  return value;
}

/** prod and production are both treated as the live-telemetry environment. */
const isLivePradarEnv = (env?: string): boolean => env === 'prod' || env === 'production';

/** Shape of {EV_DEMO_BASE_URL}/api/growatt/status we consume (inverter status endpoint). */
export interface GrowattStatusJson {
  soc?: number;
  ppv?: number;
  loadPower?: number;
  gridExport?: number;
}

/** Shape of {EV_DEMO_BASE_URL}/api/vehicle/status we consume. */
export interface KiaStatusJson {
  resMsg?: {
    vehicleStatusInfo?: {
      vehicleStatus?: {
        evStatus?: {
          batteryStatus?: number;
          batteryPlugin?: number;
          batteryCharge?: boolean;
        };
      };
    };
  };
}

/** The live tick fields the scheduler derives before running the decision logic. */
export interface EvTickLiveFields {
  ppv: number;
  loadPower: number;
  gridExport: number;
  homeSoc: number;
  evBattery: number | null;
  pluggedIn: boolean;
  charging: boolean;
}

/**
 * Maps a Growatt status + Kia vehicle status into the flow's live tick fields,
 * homeSoc = growatt.soc, ppv/loadPower/gridExport straight off GrowattStatus
 * (loadPower is already mapped from sd.pLocalLoad inside getGrowattStatus), and
 * evStatus at resMsg.vehicleStatusInfo.vehicleStatus.evStatus →
 * batteryStatus→evBattery, (batteryPlugin ?? 0) > 0→pluggedIn,
 * batteryCharge === true→charging. Pure so it's unit-testable without fetch.
 */
export function mapTickTelemetry(growatt: GrowattStatusJson | undefined, kia: KiaStatusJson | undefined): EvTickLiveFields {
  const ev = kia?.resMsg?.vehicleStatusInfo?.vehicleStatus?.evStatus ?? {};
  return {
    ppv: num(growatt?.ppv),
    loadPower: num(growatt?.loadPower),
    gridExport: num(growatt?.gridExport),
    homeSoc: num(growatt?.soc),
    evBattery: ev.batteryStatus ?? null,
    pluggedIn: (ev.batteryPlugin ?? 0) > 0,
    charging: ev.batteryCharge === true,
  };
}

/** GET one EV Demo status endpoint with a bounded timeout, throwing a clear error on failure. */
async function fetchPradarJson(ctx: NodeExecutionContext, url: string, label: string): Promise<Record<string, unknown>> {
  ctx.log('info', `GET ${url}`);
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(`${label} status fetch failed (${url}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) throw new Error(`${label} status fetch failed: HTTP ${response.status} (${url})`);
  return (await response.json()) as Record<string, unknown>;
}

export function registerPradarNodes(registry: NodeRegistry): void {
  // ==========================================================================
  // EV · Load Tick Snapshot  (env-aware live telemetry)
  // ==========================================================================
  registry.register(
    {
      type: 'EvLoadTickSnapshot',
      label: 'EV · Load Tick',
      description:
        "Loads the 5-min tick snapshot, binding to the run's environment: in PROD it pulls LIVE telemetry from the EV Demo service — GET {EV_DEMO_BASE_URL}/api/growatt/status for solar/battery (soc→homeSoc, ppv, loadPower, gridExport) and GET {EV_DEMO_BASE_URL}/api/kia/status for the EV (resMsg.vehicleStatusInfo.vehicleStatus.evStatus → batteryStatus→evBattery, batteryPlugin>0→pluggedIn, batteryCharge===true→charging); in every other environment it passes the scenario Input snapshot through unchanged. One node, one runbook step — the environment decides the source, no branching in the document. PORT NOTE: prod pulls live Growatt solar/battery + Kia EV telemetry verbatim to the scheduler's snapshot assembly. forecast, readings and state are NOT exposed per-tick by the status endpoints (they are the scheduler's rolling in-memory state + the solar-forecast service), and `now` is the run's clock, so all four pass through from Input on BOTH paths (best-effort in prod). The /api/ev-charge/status endpoint's `state` is deliberately NOT read: its enum (idle|waiting|charging|cooldown|night_charging) does not map cleanly to the flow's idle|waiting|charging, so Input's state is authoritative.",
      simpleDescription: 'Loads the tick snapshot — real telemetry from EV Demo, scenario input otherwise.',
      category: 'pradar',
      traceKind: 'http',
      traceDetail:
        'prod: GET {EV_DEMO_BASE_URL}/api/growatt/status + /api/kia/status · non-prod: scenario snapshot passthrough',
      inputSchema: {
        fields: [
          { name: 'ppv', type: 'number', description: 'Non-prod passthrough — prod reads GrowattStatus.ppv.' },
          { name: 'loadPower', type: 'number', description: 'Non-prod passthrough — prod reads GrowattStatus.loadPower.' },
          { name: 'gridExport', type: 'number', description: 'Non-prod passthrough — prod reads GrowattStatus.gridExport.' },
          { name: 'homeSoc', type: 'number', description: 'Non-prod passthrough — prod reads GrowattStatus.soc.' },
          { name: 'evBattery', type: 'number', description: 'Non-prod passthrough — prod reads Kia evStatus.batteryStatus.' },
          { name: 'pluggedIn', type: 'boolean', description: 'Non-prod passthrough — prod derives from Kia evStatus.batteryPlugin.' },
          { name: 'charging', type: 'boolean', description: 'Non-prod passthrough — prod derives from Kia evStatus.batteryCharge.' },
          { name: 'forecast', type: 'object', description: 'Always from Input — not exposed per-tick by the status endpoints.' },
          { name: 'readings', type: 'array', description: 'Always from Input — the scheduler’s rolling window, not on the status endpoints.' },
          { name: 'state', type: 'enum', enumValues: ['idle', 'waiting', 'charging'], description: 'Always from Input — scheduler-internal state, not read from /api/ev-charge/status.' },
          { name: 'now', type: 'datetime', description: 'Always from Input — the run’s clock.' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'ppv', type: 'number' },
          { name: 'loadPower', type: 'number' },
          { name: 'gridExport', type: 'number' },
          { name: 'homeSoc', type: 'number' },
          { name: 'evBattery', type: 'number' },
          { name: 'pluggedIn', type: 'boolean' },
          { name: 'charging', type: 'boolean' },
          { name: 'forecast', type: 'object' },
          { name: 'readings', type: 'array' },
          { name: 'state', type: 'string' },
          { name: 'now', type: 'string' },
          { name: 'source', type: 'string' },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      // forecast/readings/state are never on the status endpoints — they pass
      // through from Input on both paths (best-effort in prod). `now` passes
      // through in test (scenarios pin it for reproducibility) but is overridden
      // with the real wall-clock in prod below — a live tick is happening NOW,
      // so the sun-clock/night-window gates must reflect the actual moment, not
      // whatever instant a test scenario pinned.
      const passthrough = {
        forecast: ctx.input.forecast,
        readings: ctx.input.readings,
        state: ctx.input.state,
        now: ctx.input.now,
      };
      // Bind to the environment: prod pulls live telemetry from EV Demo, every
      // other env stands in with the scenario snapshot. Downstream nodes decide
      // identically either way, so the flow reads as one "Load Tick" step.
      if (isLivePradarEnv(ctx.environment)) {
        const base = requireSecret(ctx, 'EV_DEMO_BASE_URL').replace(/\/+$/, '');
        const growatt = (await fetchPradarJson(ctx, `${base}/api/growatt/status`, 'Growatt')) as GrowattStatusJson;
        const kia = (await fetchPradarJson(ctx, `${base}/api/kia/status`, 'Kia')) as KiaStatusJson;
        const live = mapTickTelemetry(growatt, kia);
        ctx.log(
          'info',
          `[${ctx.environment}] Live EV Demo telemetry: ppv ${Math.round(live.ppv)}W, load ${Math.round(live.loadPower)}W, ` +
            `export ${Math.round(live.gridExport)}W, home ${live.homeSoc}%, EV ${live.evBattery ?? '—'}% ` +
            `(${live.pluggedIn ? 'plugged in' : 'unplugged'}${live.charging ? ', charging' : ''})`,
        );
        return { ...live, ...passthrough, now: new Date().toISOString(), source: 'prod-pradar' };
      }
      // Non-prod: pass the scenario snapshot through VERBATIM (no coercion — the
      // downstream nodes coerce as before) so existing scenarios route identically.
      ctx.log('info', `[${ctx.environment ?? 'local'}] Tick snapshot passthrough (non-prod stand-in for the live EV Demo load)`);
      return {
        ppv: ctx.input.ppv,
        loadPower: ctx.input.loadPower,
        gridExport: ctx.input.gridExport,
        homeSoc: ctx.input.homeSoc,
        evBattery: ctx.input.evBattery,
        pluggedIn: ctx.input.pluggedIn,
        charging: ctx.input.charging,
        ...passthrough,
        source: 'test',
      };
    },
  );

  // ==========================================================================
  // EV · Sun Clock
  // ==========================================================================
  registry.register(
    {
      type: 'EvSunClock',
      label: 'EV · Sun Clock',
      description:
        'Resolves sun position + time flags for an instant via suncalc. isSolarHours (between sunrise/sunset), hoursUntilSunset, and the 23:00–05:00 night window. PORT NOTE: production used the server\'s local getHours(); this port derives the wall-clock hour from UTC so scenarios pinned with a `now` (…Z) are reproducible on any machine.',
      simpleDescription: 'Figures out sunrise, sunset, and whether it’s nighttime',
      category: 'pradar',
      traceKind: 'compute',
      inputSchema: {
        fields: [
          { name: 'now', type: 'datetime', description: 'ISO instant; defaults to current time.' },
          { name: 'lat', type: 'number' },
          { name: 'lon', type: 'number' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'isSolarHours', type: 'boolean' },
          { name: 'hoursUntilSunset', type: 'number' },
          { name: 'sunrise', type: 'string' },
          { name: 'sunset', type: 'string' },
          { name: 'hour', type: 'number' },
          { name: 'isNightWindow', type: 'boolean' },
          { name: 'now', type: 'string' },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      // In production the tick is happening NOW: use the real wall-clock so the
      // solar/night gates reflect the actual moment, not a scenario's pinned
      // `now`. In test, honour the pinned `now` for reproducible scenarios.
      const now = isLivePradarEnv(ctx.environment)
        ? new Date().toISOString()
        : ctx.input.now
          ? String(ctx.input.now)
          : undefined;
      const lat = ctx.input.lat !== undefined ? num(ctx.input.lat) : undefined;
      const lon = ctx.input.lon !== undefined ? num(ctx.input.lon) : undefined;
      const clock = sunTimes(now, lat, lon);
      ctx.log(
        'info',
        `Sun clock @ ${now ?? 'now'}: ${clock.isSolarHours ? 'solar hours' : 'outside solar hours'}, ` +
          `hour ${clock.hour} (${clock.isNightWindow ? 'night window' : 'day'}), ` +
          `${clock.hoursUntilSunset.toFixed(1)}h until sunset (${clock.sunset})`,
      );
      return { ...clock, now: now ?? new Date().toISOString() };
    },
  );

  // ==========================================================================
  // EV · Compute Surplus
  // ==========================================================================
  registry.register(
    {
      type: 'EvComputeSurplus',
      label: 'EV · Compute Surplus',
      description:
        'Solar surplus watts, verbatim: grid export when exporting, else max(0, ppv − load). Reports which branch produced the figure.',
      simpleDescription: 'Calculates how much extra solar power is available',
      category: 'pradar',
      traceKind: 'compute',
      inputSchema: {
        fields: [
          { name: 'ppv', type: 'number', required: true },
          { name: 'loadPower', type: 'number', required: true },
          { name: 'gridExport', type: 'number', required: true },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'surplus', type: 'number' },
          { name: 'branch', type: 'enum', enumValues: ['export', 'ppv-load'] },
          { name: 'ppv', type: 'number' },
          { name: 'loadPower', type: 'number' },
          { name: 'gridExport', type: 'number' },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      const ppv = num(ctx.input.ppv);
      const loadPower = num(ctx.input.loadPower);
      const gridExport = num(ctx.input.gridExport);
      const { surplus, branch } = computeSurplus(ppv, loadPower, gridExport);
      ctx.log(
        'info',
        branch === 'export'
          ? `Surplus ${Math.round(surplus)}W from grid export (exporting ${Math.round(gridExport)}W)`
          : `Surplus ${Math.round(surplus)}W from ppv−load (${Math.round(ppv)}W − ${Math.round(loadPower)}W, not exporting)`,
      );
      return { surplus, branch, ppv, loadPower, gridExport };
    },
  );

  // ==========================================================================
  // EV · Trend Window
  // ==========================================================================
  registry.register(
    {
      type: 'EvTrendWindow',
      label: 'EV · Trend Window',
      description:
        'Per-cycle surplus/SOC/ppv slopes across the rolling reading window + surplus stdDev and the dynamic cooldown it drives (stable <200 → 5min, volatile >800 → 15min, else 10min). Verbatim getTrend + getCooldownMs.',
      simpleDescription: 'Tracks whether solar and battery levels are rising or falling',
      category: 'pradar',
      traceKind: 'compute',
      inputSchema: {
        fields: [{ name: 'readings', type: 'array', required: true, description: 'Array of {surplus, homeSoc, ppv}.' }],
      },
      outputSchema: {
        fields: [
          { name: 'surplusTrend', type: 'number' },
          { name: 'socTrend', type: 'number' },
          { name: 'ppvTrend', type: 'number' },
          { name: 'stdDev', type: 'number' },
          { name: 'cooldownMs', type: 'number' },
          { name: 'cooldownMin', type: 'number' },
          { name: 'readingCount', type: 'number' },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      const readings = asReadings(ctx.input.readings);
      const tw = computeTrendWindow(readings);
      ctx.log(
        'info',
        `Trend window over ${readings.length} reading(s): surplus ${tw.surplusTrend >= 0 ? '+' : ''}${Math.round(tw.surplusTrend)}W/cycle, ` +
          `SOC ${tw.socTrend >= 0 ? '+' : ''}${tw.socTrend.toFixed(1)}%/cycle, stdDev ${Math.round(tw.stdDev)}W → cooldown ${Math.round(tw.cooldownMs / 60_000)}min`,
      );
      return { ...tw, cooldownMin: tw.cooldownMs / 60_000, readingCount: readings.length };
    },
  );

  // ==========================================================================
  // EV · Thresholds  (branching on skip)
  // ==========================================================================
  registry.register(
    {
      type: 'EvThresholds',
      label: 'EV · Thresholds',
      description:
        'Verbatim getThresholds: layered start/stop watt thresholds from home SOC, ppv, sun-hours-left, EV battery, forecast and trends — urgent/buffer (1200/400), flat (2000/800), predictive (≤500/200), golden hour (≤800/200), worth-it skip (MIN_SESSION_KWH 0.5 + the ≥65%/<1.5kWh gate), trend overrides (1000/600). Emits $branch skip|ok. PORT NOTE: trends are passed in (Trend Window) instead of read from module state.',
      simpleDescription: 'Decides the power levels that should start or stop charging',
      category: 'pradar',
      traceKind: 'compute',
      tags: ['branching'],
      inputSchema: {
        fields: [
          { name: 'homeSoc', type: 'number', required: true },
          { name: 'ppv', type: 'number', required: true },
          { name: 'sunHoursLeft', type: 'number', required: true },
          { name: 'evBattery', type: 'number' },
          { name: 'forecast', type: 'object' },
          { name: 'surplusTrend', type: 'number' },
          { name: 'socTrend', type: 'number' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'startW', type: 'number' },
          { name: 'stopW', type: 'number' },
          { name: 'skipReason', type: 'string' },
          { name: 'reasons', type: 'array' },
          { name: 'homeSoc', type: 'number' },
          { name: 'ppv', type: 'number' },
          { name: 'sunHoursLeft', type: 'number' },
          { name: 'evBattery', type: 'number' },
          { name: '$branch', type: 'string' },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      const homeSoc = num(ctx.input.homeSoc);
      const ppv = num(ctx.input.ppv);
      const sunHoursLeft = num(ctx.input.sunHoursLeft);
      const evBattery = nullableNum(ctx.input.evBattery);
      const forecast = asForecast(ctx.input.forecast);
      const trends = {
        surplusTrend: num(ctx.input.surplusTrend),
        socTrend: num(ctx.input.socTrend),
      };
      const result = getThresholds(homeSoc, ppv, sunHoursLeft, evBattery, forecast, trends);
      const branch = result.skipReason ? 'skip' : 'ok';
      ctx.log(
        'info',
        `Thresholds: start ${result.startW}W / stop ${result.stopW}W${result.skipReason ? ` — SKIP: ${result.skipReason}` : ''}` +
          (result.reasons.length ? ` [${result.reasons.join('; ')}]` : ''),
      );
      return {
        startW: result.startW,
        stopW: result.stopW,
        skipReason: result.skipReason,
        reasons: result.reasons,
        homeSoc,
        ppv,
        sunHoursLeft,
        evBattery,
        $branch: branch,
      };
    },
  );

  // ==========================================================================
  // EV · Target Check  (branching)
  // ==========================================================================
  registry.register(
    {
      type: 'EvTargetCheck',
      label: 'EV · Target Check',
      description:
        'Verbatim plugged-in / at-target gate. Effective target is 90% during solar hours (gentle free AC), else 80%. Emits $branch notPlugged|atTarget|belowTarget.',
      simpleDescription: 'Checks whether the car is plugged in and charged enough',
      category: 'pradar',
      traceKind: 'compute',
      tags: ['branching'],
      inputSchema: {
        fields: [
          { name: 'pluggedIn', type: 'boolean', required: true },
          { name: 'evBattery', type: 'number' },
          { name: 'isSolarHours', type: 'boolean', required: true },
          { name: 'charging', type: 'boolean' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'branch', type: 'enum', enumValues: ['notPlugged', 'atTarget', 'belowTarget'] },
          { name: 'effectiveTarget', type: 'number' },
          { name: 'reason', type: 'string' },
          { name: 'evBattery', type: 'number' },
          { name: 'charging', type: 'boolean' },
          { name: '$branch', type: 'string' },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      const pluggedIn = bool(ctx.input.pluggedIn);
      const evBattery = nullableNum(ctx.input.evBattery);
      const isSolarHours = bool(ctx.input.isSolarHours);
      const charging = bool(ctx.input.charging);
      const result = checkTarget(pluggedIn, evBattery, isSolarHours);
      ctx.log('info', `Target check → ${result.branch}: ${result.reason}`);
      return {
        branch: result.branch,
        effectiveTarget: result.effectiveTarget,
        reason: result.reason,
        evBattery,
        charging,
        $branch: result.branch,
      };
    },
  );

  // ==========================================================================
  // EV · Unscheduled Charge Guard  (branching)
  // ==========================================================================
  registry.register(
    {
      type: 'EvUnscheduledGuard',
      label: 'EV · Unscheduled Charge Guard',
      description:
        'Verbatim shouldStopUnscheduledCharge: stops a charge the scheduler did not start when start conditions are not met (skip reason, surplus below start, or home SOC below min) — but never interferes with a scheduler-owned charging/cooldown/night session. Emits $branch stop|continue. effectiveMinSoc defaults to 0 (production sets it to 0 — morning SOC near 0% is normal).',
      simpleDescription: 'Stops an unscheduled charge when conditions no longer allow it',
      category: 'pradar',
      traceKind: 'compute',
      tags: ['branching'],
      inputSchema: {
        fields: [
          { name: 'charging', type: 'boolean', required: true },
          { name: 'state', type: 'string', required: true },
          { name: 'surplus', type: 'number', required: true },
          { name: 'startW', type: 'number', required: true },
          { name: 'skipReason', type: 'string' },
          { name: 'homeSoc', type: 'number', required: true },
          { name: 'effectiveMinSoc', type: 'number' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'shouldStop', type: 'boolean' },
          { name: 'reason', type: 'string' },
          { name: 'state', type: 'string' },
          { name: '$branch', type: 'string' },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      const charging = bool(ctx.input.charging);
      const state = String(ctx.input.state ?? 'idle') as EvChargeState;
      const surplus = num(ctx.input.surplus);
      const startW = num(ctx.input.startW);
      const skipReason = ctx.input.skipReason ? String(ctx.input.skipReason) : null;
      const homeSoc = num(ctx.input.homeSoc);
      const effectiveMinSoc = ctx.input.effectiveMinSoc === undefined ? 0 : num(ctx.input.effectiveMinSoc);
      const shouldStop = shouldStopUnscheduledCharge({ charging, state, surplus, startW, skipReason, homeSoc, effectiveMinSoc });
      const reason = shouldStop
        ? skipReason || `unscheduled charge: surplus ${Math.round(surplus)}W < ${startW}W start threshold`
        : 'no unscheduled charge to stop';
      ctx.log('info', `Unscheduled guard → ${shouldStop ? 'STOP' : 'continue'}: ${reason}`);
      return { shouldStop, reason, state, $branch: shouldStop ? 'stop' : 'continue' };
    },
  );

  // ==========================================================================
  // EV · Reconcile  (branching)
  // ==========================================================================
  registry.register(
    {
      type: 'EvReconcile',
      label: 'EV · Reconcile',
      description:
        'Verbatim reconcile: adopt a charge that began outside the scheduler when current rules allow it (car charging but state is idle/waiting) — otherwise hold. Emits $branch adopt|hold.',
      simpleDescription: 'Decides whether to take over a charge that started on its own',
      category: 'pradar',
      traceKind: 'compute',
      tags: ['branching'],
      inputSchema: {
        fields: [
          { name: 'charging', type: 'boolean', required: true },
          { name: 'state', type: 'string', required: true },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'decision', type: 'enum', enumValues: ['adopt', 'hold'] },
          { name: 'nextState', type: 'string' },
          { name: 'reason', type: 'string' },
          { name: 'state', type: 'string' },
          { name: '$branch', type: 'string' },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      const charging = bool(ctx.input.charging);
      const state = String(ctx.input.state ?? 'idle') as EvChargeState;
      const result = reconcile(charging, state);
      ctx.log('info', `Reconcile → ${result.decision}: ${result.reason}`);
      return { decision: result.decision, nextState: result.nextState, reason: result.reason, state, $branch: result.decision };
    },
  );

  // ==========================================================================
  // EV · Charge Decision  (branching)
  // ==========================================================================
  registry.register(
    {
      type: 'EvChargeDecision',
      label: 'EV · Charge Decision',
      description:
        'Verbatim evaluateCharge branch (idle/waiting/charging): start when surplus ≥ startW, stop when surplus < stopW, else hold. Emits $branch start|stop|hold_waiting|hold_charging. Note effectiveMinSoc/effectiveStopSoc are 0 in production so the SOC comparisons never trip.',
      simpleDescription: 'Decides whether to start, stop, or keep charging right now',
      category: 'pradar',
      traceKind: 'compute',
      tags: ['branching'],
      inputSchema: {
        fields: [
          { name: 'state', type: 'enum', enumValues: ['idle', 'waiting', 'charging'], required: true },
          { name: 'surplus', type: 'number', required: true },
          { name: 'startW', type: 'number', required: true },
          { name: 'stopW', type: 'number', required: true },
          { name: 'homeSoc', type: 'number', required: true },
          { name: 'skipReason', type: 'string' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'action', type: 'enum', enumValues: ['start', 'stop', 'hold_waiting', 'hold_charging'] },
          { name: 'nextState', type: 'string' },
          { name: 'reason', type: 'string' },
          { name: 'surplus', type: 'number' },
          { name: 'startW', type: 'number' },
          { name: 'stopW', type: 'number' },
          { name: '$branch', type: 'string' },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      const state = String(ctx.input.state ?? 'idle') as 'idle' | 'waiting' | 'charging';
      const surplus = num(ctx.input.surplus);
      const startW = num(ctx.input.startW);
      const stopW = num(ctx.input.stopW);
      const homeSoc = num(ctx.input.homeSoc);
      const skipReason = ctx.input.skipReason ? String(ctx.input.skipReason) : null;
      const result = decideCharge({ state, surplus, startW, stopW, homeSoc, skipReason });
      ctx.log('info', `Charge decision (${state}) → ${result.action}: ${result.reason}`);
      return {
        action: result.action,
        nextState: result.nextState,
        reason: result.reason,
        surplus,
        startW,
        stopW,
        $branch: result.action,
      };
    },
  );

  // ==========================================================================
  // EV · Night Charge Decision  (branching)
  // ==========================================================================
  registry.register(
    {
      type: 'EvNightChargeDecision',
      label: 'EV · Night Charge Decision',
      description:
        'Verbatim night-charge gate: only 23:00–05:00, only when plugged in and not already triggered today. Charges when EV < 35% (critical, any forecast) or EV < 65% with a poor tomorrow forecast (< 10kWh). Emits $branch charge|skip and sizes the session (neededKwh to 80%, hoursToCharge at 2.3kW).',
      simpleDescription: 'Decides whether to top up the battery overnight',
      category: 'pradar',
      traceKind: 'compute',
      tags: ['branching'],
      inputSchema: {
        fields: [
          { name: 'evBattery', type: 'number', required: true },
          { name: 'pluggedIn', type: 'boolean', required: true },
          { name: 'tomorrowKwh', type: 'number' },
          { name: 'hour', type: 'number', required: true },
          { name: 'alreadyTriggeredToday', type: 'boolean' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'shouldCharge', type: 'boolean' },
          { name: 'factors', type: 'array' },
          { name: 'neededKwh', type: 'number' },
          { name: 'hoursToCharge', type: 'number' },
          { name: 'evBattery', type: 'number' },
          { name: 'gateReason', type: 'string' },
          { name: '$branch', type: 'string' },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      const evBattery = num(ctx.input.evBattery);
      const pluggedIn = bool(ctx.input.pluggedIn);
      const tomorrowKwh = nullableNum(ctx.input.tomorrowKwh);
      const hour = num(ctx.input.hour);
      const alreadyTriggeredToday = bool(ctx.input.alreadyTriggeredToday);

      // Verbatim guards, in order: once/day, night window only, must be plugged in.
      const inNightWindow = hour >= 23 || hour < 5;
      let gateReason: string | null = null;
      if (alreadyTriggeredToday) gateReason = 'already triggered today';
      else if (!inNightWindow) gateReason = `hour ${hour} outside 23:00–05:00 night window`;
      else if (!pluggedIn) gateReason = 'not plugged in';

      const { neededKwh, hoursToCharge } = nightChargeEstimate(evBattery);

      if (gateReason) {
        ctx.log('info', `Night charge → skip: ${gateReason}`);
        return { shouldCharge: false, factors: [], neededKwh, hoursToCharge, evBattery, gateReason, $branch: 'skip' };
      }

      const decision = getNightChargeDecision(evBattery, tomorrowKwh);
      const branch = decision.shouldCharge ? 'charge' : 'skip';
      ctx.log(
        'info',
        decision.shouldCharge
          ? `Night charge → CHARGE: ${decision.factors.join('; ')} (needs ${neededKwh.toFixed(1)}kWh, ~${hoursToCharge.toFixed(1)}h to ${EV_TARGET_BATTERY}%)`
          : `Night charge → skip: EV ${evBattery}%${tomorrowKwh !== null ? `, tomorrow ${tomorrowKwh.toFixed(1)}kWh` : ''} — solar should handle it`,
      );
      return {
        shouldCharge: decision.shouldCharge,
        factors: decision.factors,
        neededKwh,
        hoursToCharge,
        evBattery,
        gateReason: null,
        $branch: branch,
      };
    },
  );

  // ==========================================================================
  // EV · Session Estimate
  // ==========================================================================
  registry.register(
    {
      type: 'EvSessionEstimate',
      label: 'EV · Session Estimate',
      description:
        'Verbatim estimateSessionKwh + evKwhNeeded + the worth-it gates: deliverable kWh from remaining solar vs kWh needed to target, and whether a session clears MIN_SESSION_KWH (0.5) / the ≥65%-and-<1.5kWh guard.',
      simpleDescription: 'Estimates whether there’s enough sun left to make charging worthwhile',
      category: 'pradar',
      traceKind: 'compute',
      inputSchema: {
        fields: [
          { name: 'evBattery', type: 'number', required: true },
          { name: 'target', type: 'number' },
          { name: 'ppv', type: 'number' },
          { name: 'surplus', type: 'number' },
          { name: 'sunHoursLeft', type: 'number', required: true },
          { name: 'forecast', type: 'object' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'estimatedKwh', type: 'number' },
          { name: 'neededKwh', type: 'number' },
          { name: 'worthIt', type: 'boolean' },
          { name: 'reason', type: 'string' },
          { name: 'evBattery', type: 'number' },
          { name: 'target', type: 'number' },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      const evBattery = num(ctx.input.evBattery);
      const target = ctx.input.target !== undefined ? num(ctx.input.target) : EV_TARGET_BATTERY;
      const power = ctx.input.ppv !== undefined ? num(ctx.input.ppv) : num(ctx.input.surplus);
      const sunHoursLeft = num(ctx.input.sunHoursLeft);
      const forecast = asForecast(ctx.input.forecast);
      const estimatedKwh = estimateSessionKwh(power, sunHoursLeft, forecast);
      const neededKwh = evKwhNeeded(evBattery, target);

      // Mirror getThresholds' worth-it gates.
      let worthIt = true;
      let reason = `~${estimatedKwh.toFixed(1)}kWh deliverable vs ${neededKwh.toFixed(1)}kWh needed to ${target}%`;
      if (estimatedKwh < MIN_SESSION_KWH && neededKwh > 2) {
        worthIt = false;
        reason = `not worth it: ~${estimatedKwh.toFixed(1)}kWh available vs ${neededKwh.toFixed(0)}kWh needed`;
      }
      if (evBattery >= 65 && estimatedKwh < 1.5) {
        worthIt = false;
        reason = `EV at ${evBattery}%, only ~${estimatedKwh.toFixed(1)}kWh solar remaining — not worth a session`;
      }
      ctx.log('info', `Session estimate: ${reason} → ${worthIt ? 'worth it' : 'skip'}`);
      return { estimatedKwh, neededKwh, worthIt, reason, evBattery, target };
    },
  );

  // ==========================================================================
  // EV · Start Charge  (mutation, simulated)
  // ==========================================================================
  registry.register(
    {
      type: 'EvStartCharge',
      label: 'EV · Start Charge',
      description:
        'SIMULATED start-charge command. Commit (config.commit true, not safe mode) returns {sent:true, command:"start"}; otherwise dry-run returns {sent:false, wouldSend:"start"}. PORT NOTE: production calls the Kia Connect API (startCharge()).',
      simpleDescription: 'Tells the car to start charging',
      category: 'pradar',
      traceKind: 'http',
      traceDetail: 'Kia Connect startCharge() — SIMULATED (no HTTP request emitted; production calls the Kia Connect API)',
      effects: 'mutation',
      inputSchema: {
        fields: [{ name: 'reason', type: 'string' }],
      },
      configSchema: {
        fields: [{ name: 'commit', type: 'boolean' }],
      },
      outputSchema: {
        fields: [
          { name: 'sent', type: 'boolean' },
          { name: 'command', type: 'string' },
          { name: 'wouldSend', type: 'string' },
          { name: 'reason', type: 'string' },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      const reason = ctx.input.reason ? String(ctx.input.reason) : 'start charge';
      const commit = ctx.config.commit === true && !ctx.safeMode;
      if (ctx.config.commit === true && ctx.safeMode) {
        ctx.log('warn', 'EvStartCharge: commit requested — safe mode — command suppressed');
      }
      if (commit) {
        ctx.log('info', `[SIMULATED] Kia startCharge() sent — ${reason}`);
        return { sent: true, command: 'start', reason };
      }
      ctx.log('info', `Dry-run: would send Kia startCharge() — ${reason}`);
      return { sent: false, wouldSend: 'start', reason };
    },
  );

  // ==========================================================================
  // EV · Stop Charge  (mutation, simulated)
  // ==========================================================================
  registry.register(
    {
      type: 'EvStopCharge',
      label: 'EV · Stop Charge',
      description:
        'SIMULATED stop-charge command. Commit (config.commit true, not safe mode) returns {sent:true, command:"stop"}; otherwise dry-run returns {sent:false, wouldSend:"stop"}. PORT NOTE: production calls the Kia Connect API (stopCharge()).',
      simpleDescription: 'Tells the car to stop charging',
      category: 'pradar',
      traceKind: 'http',
      traceDetail: 'Kia Connect stopCharge() — SIMULATED (no HTTP request emitted; production calls the Kia Connect API)',
      effects: 'mutation',
      inputSchema: {
        fields: [{ name: 'reason', type: 'string' }],
      },
      configSchema: {
        fields: [{ name: 'commit', type: 'boolean' }],
      },
      outputSchema: {
        fields: [
          { name: 'sent', type: 'boolean' },
          { name: 'command', type: 'string' },
          { name: 'wouldSend', type: 'string' },
          { name: 'reason', type: 'string' },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      const reason = ctx.input.reason ? String(ctx.input.reason) : 'stop charge';
      const commit = ctx.config.commit === true && !ctx.safeMode;
      if (ctx.config.commit === true && ctx.safeMode) {
        ctx.log('warn', 'EvStopCharge: commit requested — safe mode — command suppressed');
      }
      if (commit) {
        ctx.log('info', `[SIMULATED] Kia stopCharge() sent — ${reason}`);
        return { sent: true, command: 'stop', reason };
      }
      ctx.log('info', `Dry-run: would send Kia stopCharge() — ${reason}`);
      return { sent: false, wouldSend: 'stop', reason };
    },
  );

  // ==========================================================================
  // EV · Notify  (mutation, simulated)
  // ==========================================================================
  registry.register(
    {
      type: 'EvNotify',
      label: 'EV · Notify',
      description:
        'SIMULATED ntfy push. Commit (config.commit true, not safe mode) returns {sent:true}; otherwise dry-run returns {sent:false, wouldSend:{title,message,priority}}. PORT NOTE: production POSTs to ntfy.sh/$NTFY_TOPIC.',
      simpleDescription: 'Sends a push notification',
      category: 'pradar',
      traceKind: 'http',
      traceDetail: 'POST https://ntfy.sh/{NTFY_TOPIC} — SIMULATED (no HTTP request emitted; production POSTs to ntfy.sh)',
      effects: 'mutation',
      inputSchema: {
        fields: [
          { name: 'title', type: 'string', required: true },
          { name: 'message', type: 'string' },
          { name: 'priority', type: 'number' },
        ],
      },
      configSchema: {
        fields: [{ name: 'commit', type: 'boolean' }],
      },
      outputSchema: {
        fields: [
          { name: 'sent', type: 'boolean' },
          { name: 'wouldSend', type: 'object' },
          { name: 'title', type: 'string' },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      const title = String(ctx.input.title ?? 'EV');
      const message = ctx.input.message ? String(ctx.input.message) : '';
      const priority = ctx.input.priority !== undefined ? num(ctx.input.priority, 3) : 3;
      const commit = ctx.config.commit === true && !ctx.safeMode;
      if (ctx.config.commit === true && ctx.safeMode) {
        ctx.log('warn', 'EvNotify: commit requested — safe mode — push suppressed');
      }
      const payload = { title, message, priority };
      if (commit) {
        ctx.log('info', `[SIMULATED] ntfy push — ${title}: ${message}`);
        return { sent: true, title };
      }
      ctx.log('info', `Dry-run: would push ntfy — ${title} (priority ${priority})`);
      return { sent: false, wouldSend: payload, title };
    },
  );

  // ==========================================================================
  // EV · Morning Summary
  // ==========================================================================
  registry.register(
    {
      type: 'EvMorningSummary',
      label: 'EV · Morning Summary',
      description:
        'Verbatim morning-summary outlook lines: Good when remaining solar > EV-need×1.5, Tight when > need, else Unlikely; EV at/above the 90% solar target reports "at target".',
      simpleDescription: 'Writes a plain-English outlook for today’s charging',
      category: 'pradar',
      traceKind: 'compute',
      inputSchema: {
        fields: [
          { name: 'homeSoc', type: 'number' },
          { name: 'evBattery', type: 'number' },
          { name: 'pluggedIn', type: 'boolean' },
          { name: 'todayKwh', type: 'number' },
          { name: 'remainingKwh', type: 'number' },
          { name: 'strongHoursLeft', type: 'number' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'lines', type: 'array' },
          { name: 'summary', type: 'string' },
          { name: 'outlook', type: 'enum', enumValues: ['good', 'tight', 'unlikely', 'at-target', 'not-applicable'] },
        ],
      },
    },
    async (ctx: NodeExecutionContext) => {
      const homeSoc = nullableNum(ctx.input.homeSoc);
      const evBattery = nullableNum(ctx.input.evBattery);
      const pluggedIn = bool(ctx.input.pluggedIn);
      const todayKwh = nullableNum(ctx.input.todayKwh);
      const remainingKwh = nullableNum(ctx.input.remainingKwh);
      const strongHoursLeft = nullableNum(ctx.input.strongHoursLeft);
      const summary = morningSummary(homeSoc, evBattery, pluggedIn, todayKwh, remainingKwh, strongHoursLeft);
      ctx.log('info', `Morning summary (${summary.outlook}):\n${summary.lines.join('\n')}`);
      return { lines: summary.lines, summary: summary.lines.join('\n'), outlook: summary.outlook };
    },
  );
}
