import * as SunCalc from 'suncalc';

/**
 * EV charge scheduler — pure decision logic for a demo solar/EV charging flow.
 * Every decision is a pure function so an Emberflow flow can drive it
 * deterministically (constants, formulas, thresholds, priorities, edge cases).
 *
 * Two notes on shape:
 *  1. `getThresholds` takes trends as an explicit parameter rather than reading
 *     a module-level rolling-reading window.
 *  2. Time-dependent helpers take a `now` ISO string (default: current time) and
 *     resolve the wall-clock HOUR from UTC (`getUTCHours`) so scenarios pinned
 *     with a `now` (…Z) are reproducible on any machine. Sunrise/sunset come
 *     from suncalc as absolute UTC instants, so `isSolarHours` /
 *     `hoursUntilSunset` are machine-independent.
 */

// Demo location (Berlin). Overridable per call.
export const LAT = 52.52;
export const LON = 13.405;

// EV constants (verbatim)
export const EV_TARGET_BATTERY = 80; // Target for night/grid charging
export const EV_SOLAR_TARGET = 90; // Target for solar excess charging (AC is gentle, free energy)
export const EV_CAPACITY_KWH = 77.4; // EV6 Long Range usable capacity
export const EV_CHARGE_RATE_KW = 2.3; // Home EVSE charge rate (10A single phase)
export const EV_LOW_BATTERY = 50; // Below this, EV gets priority over home battery
export const EV_NIGHT_CHARGE_BELOW = 35; // Below this at night, force a grid charge to 80%

// Thresholds (watts) — reactive mode (verbatim)
export const START_SURPLUS_W = 1500;
export const STOP_SURPLUS_W = 500;
export const START_MIN_SOC = 30;
export const STOP_MIN_SOC = 20;
export const COOLDOWN_MS = 10 * 60_000;

// Predictive thresholds (verbatim)
export const PREDICTIVE_BATTERY_SOC = 90;
export const PREDICTIVE_MIN_PPV = 2000;
export const SUNSET_HOURS_THRESHOLD = 2;
export const GOLDEN_HOUR_START_W = 800;
export const GOLDEN_HOUR_STOP_W = 200;

// Worth-it calculation: minimum kWh a session must deliver to justify the wake +
// command overhead (~13 min at 2.3kW — below this it's not worth the wear).
export const MIN_SESSION_KWH = 0.5;

// Trend tracking — rolling window of last N readings (verbatim).
export const TREND_WINDOW = 6;

export type EvChargeState = 'idle' | 'waiting' | 'charging' | 'cooldown' | 'night_charging';

export interface Reading {
  time?: number;
  surplus: number;
  homeSoc: number;
  ppv: number;
}

export interface Forecast {
  remainingKwh: number;
  strongHoursLeft: number;
}

// ============================================================================
// Sun times — suncalc, with a `now` override for determinism.
// ============================================================================

export interface SunClock {
  isSolarHours: boolean;
  hoursUntilSunset: number;
  sunrise: string;
  sunset: string;
  /** UTC wall-clock hour (0–23). */
  hour: number;
  /** True inside the 23:00–05:00 night-charge window. */
  isNightWindow: boolean;
}

function resolveNow(now?: string): Date {
  return now ? new Date(now) : new Date();
}

/** Sun position + derived time flags for the given instant/location. */
export function sunTimes(now?: string, lat: number = LAT, lon: number = LON): SunClock {
  const d = resolveNow(now);
  const times = SunCalc.getTimes(d, lat, lon);
  // @types/suncalc types sunrise/sunset as possibly null (polar edge cases);
  // for this latitude they are always present. Fall back to the instant itself.
  const sunrise = times.sunrise ?? d;
  const sunset = times.sunset ?? d;
  const isSolarHours = d > sunrise && d < sunset;
  const hoursUntilSunset = Math.max(0, (sunset.getTime() - d.getTime()) / 3_600_000);
  const hour = d.getUTCHours();
  // Verbatim night gate: production returns early "outside night" when
  // `hour >= 5 && hour < 23`, i.e. the night window is hour >= 23 || hour < 5.
  const isNightWindow = hour >= 23 || hour < 5;
  return {
    isSolarHours,
    hoursUntilSunset,
    sunrise: sunrise.toISOString(),
    sunset: sunset.toISOString(),
    hour,
    isNightWindow,
  };
}

// ============================================================================
// Surplus, kWh math (verbatim)
// ============================================================================

export interface SurplusResult {
  surplus: number;
  /** 'export' when grid export is positive, else 'ppv-load'. */
  branch: 'export' | 'ppv-load';
}

/**
 * Verbatim surplus calc (evaluateCharge):
 *   surplus = gridExport > 0 ? gridExport : max(0, ppv - loadPower)
 */
export function computeSurplus(ppv: number, loadPower: number, gridExport: number): SurplusResult {
  if (gridExport > 0) return { surplus: gridExport, branch: 'export' };
  return { surplus: Math.max(0, ppv - loadPower), branch: 'ppv-load' };
}

/** How many kWh the EV needs to reach target (verbatim evKwhNeeded). */
export function evKwhNeeded(currentPct: number, target: number = EV_TARGET_BATTERY): number {
  const pctNeeded = target - currentPct;
  if (pctNeeded <= 0) return 0;
  return (pctNeeded / 100) * EV_CAPACITY_KWH;
}

/**
 * Estimate deliverable kWh from remaining solar (verbatim estimateSessionKwh).
 * With a forecast: remaining kWh capped by charge rate over the hours left.
 * Without: assume current surplus sustains for the remaining sun hours.
 */
export function estimateSessionKwh(
  surplusW: number,
  sunHoursLeft: number,
  forecast: Forecast | null,
): number {
  if (forecast) {
    return Math.min(forecast.remainingKwh, EV_CHARGE_RATE_KW * sunHoursLeft);
  }
  return (Math.min(surplusW, EV_CHARGE_RATE_KW * 1000) / 1000) * sunHoursLeft;
}

// ============================================================================
// Trends + dynamic cooldown (verbatim getTrend / getCooldownMs)
// ============================================================================

/** Per-cycle slope of `key` across the reading window (verbatim getTrend). */
export function getTrend(readings: Reading[], key: 'surplus' | 'homeSoc' | 'ppv'): number {
  if (readings.length < 2) return 0;
  const first = readings[0];
  const last = readings[readings.length - 1];
  const cycles = readings.length - 1;
  return (last[key] - first[key]) / cycles;
}

export interface TrendWindow {
  surplusTrend: number;
  socTrend: number;
  ppvTrend: number;
  stdDev: number;
  cooldownMs: number;
}

/**
 * Dynamic cooldown from surplus volatility (verbatim getCooldownMs):
 *   < 3 readings → default 10 min
 *   stdDev < 200 → stable → 5 min
 *   stdDev > 800 → volatile → 15 min
 *   else → default 10 min
 */
export function getCooldownMs(readings: Reading[]): number {
  if (readings.length < 3) return COOLDOWN_MS;
  const surpluses = readings.map((r) => r.surplus);
  const mean = surpluses.reduce((a, b) => a + b, 0) / surpluses.length;
  const variance = surpluses.reduce((sum, s) => sum + (s - mean) ** 2, 0) / surpluses.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev < 200) return 5 * 60_000;
  if (stdDev > 800) return 15 * 60_000;
  return COOLDOWN_MS;
}

/** stdDev of surplus across the window (0 for <3 readings, mirroring the cooldown gate). */
export function surplusStdDev(readings: Reading[]): number {
  if (readings.length < 1) return 0;
  const surpluses = readings.map((r) => r.surplus);
  const mean = surpluses.reduce((a, b) => a + b, 0) / surpluses.length;
  const variance = surpluses.reduce((sum, s) => sum + (s - mean) ** 2, 0) / surpluses.length;
  return Math.sqrt(variance);
}

/** Bundle the trend-window derivations one Trend Window node emits. */
export function computeTrendWindow(readings: Reading[]): TrendWindow {
  return {
    surplusTrend: getTrend(readings, 'surplus'),
    socTrend: getTrend(readings, 'homeSoc'),
    ppvTrend: getTrend(readings, 'ppv'),
    stdDev: surplusStdDev(readings),
    cooldownMs: getCooldownMs(readings),
  };
}

// ============================================================================
// Thresholds (verbatim getThresholds; trends made an explicit param)
// ============================================================================

export interface Trends {
  surplusTrend: number;
  socTrend: number;
}

export interface ThresholdResult {
  startW: number;
  stopW: number;
  skipReason: string | null;
  reasons: string[];
}

/**
 * Verbatim port of getThresholds. The ONLY change: `trends` (surplus + home-SOC
 * per-cycle slopes) is passed in explicitly instead of read from module state
 * via `getTrend(...)`. Defaults to zero slopes (no trend override), matching a
 * cold start with fewer than two readings.
 */
export function getThresholds(
  homeSoc: number,
  ppv: number,
  sunHoursLeft: number,
  evBattery: number | null,
  forecast: Forecast | null,
  trends: Trends = { surplusTrend: 0, socTrend: 0 },
): ThresholdResult {
  const reasons: string[] = [];
  // Default thresholds must cover the EV charge rate (2.3kW) so we don't
  // primarily import from grid. Home battery can buffer the small shortfall.
  let startW = 2000;
  let stopW = 800;
  let skipReason: string | null = null;

  const evUrgent = evBattery !== null && evBattery < EV_LOW_BATTERY;
  const homeHasBuffer = homeSoc >= 30;

  if (evUrgent) {
    startW = 1200;
    stopW = 400;
    reasons.push(`ev urgent: ${evBattery}% < ${EV_LOW_BATTERY}%, accepting some grid`);
  } else if (homeHasBuffer) {
    startW = 1200;
    stopW = 400;
    reasons.push(`home ${homeSoc}% has buffer — EV priority, home tops up EV shortfall`);
  } else {
    reasons.push(`home ${homeSoc}% flat — need ${startW}W solar to avoid grid import`);
  }

  // --- Predictive: battery nearly full + strong production → export imminent ---
  if (homeSoc >= PREDICTIVE_BATTERY_SOC && ppv >= PREDICTIVE_MIN_PPV) {
    startW = Math.min(startW, 500);
    stopW = Math.min(stopW, 200);
    reasons.push(`predictive: home SOC ${homeSoc}% + ppv ${Math.round(ppv)}W → export imminent`);
  }

  // --- Golden hour: sun setting soon, capture remaining solar ---
  if (sunHoursLeft > 0 && sunHoursLeft <= SUNSET_HOURS_THRESHOLD && !skipReason) {
    startW = Math.min(startW, GOLDEN_HOUR_START_W);
    stopW = Math.min(stopW, GOLDEN_HOUR_STOP_W);
    reasons.push(`golden hour: ${sunHoursLeft.toFixed(1)}h until sunset`);
  }

  // --- Worth-it check: is the remaining solar enough to justify a session? ---
  const inBonusZone = evBattery !== null && evBattery >= EV_TARGET_BATTERY && evBattery < EV_SOLAR_TARGET;
  if (evBattery !== null && forecast && !skipReason) {
    const estimatedKwh = estimateSessionKwh(ppv, sunHoursLeft, forecast);
    const target = inBonusZone ? EV_SOLAR_TARGET : EV_TARGET_BATTERY;
    const needed = evKwhNeeded(evBattery, target);
    if (estimatedKwh < MIN_SESSION_KWH && needed > 2) {
      skipReason = `not worth it: ~${estimatedKwh.toFixed(1)}kWh available vs ${needed.toFixed(0)}kWh needed`;
      reasons.push(skipReason);
    }
    if (evBattery >= 65 && estimatedKwh < 1.5) {
      skipReason = `EV at ${evBattery}%, only ~${estimatedKwh.toFixed(1)}kWh solar remaining — not worth a session`;
      reasons.push(skipReason);
    }
  }

  // --- Trend-aware: surplus rising fast → be more aggressive ---
  const surplusTrend = trends.surplusTrend;
  if (surplusTrend > 200) {
    startW = Math.min(startW, 1000);
    reasons.push(`trend: surplus rising ${Math.round(surplusTrend)}W/cycle`);
  }

  // --- SOC climbing fast → battery about to fill ---
  const socTrend = trends.socTrend;
  if (socTrend > 2 && homeSoc > 75) {
    startW = Math.min(startW, 600);
    reasons.push(`trend: home SOC rising ${socTrend.toFixed(1)}%/cycle from ${homeSoc}%`);
  }

  return { startW, stopW, skipReason, reasons };
}

// ============================================================================
// Unscheduled-charge guard (verbatim shouldStopUnscheduledCharge)
// ============================================================================

export interface UnscheduledGuardInput {
  charging: boolean;
  state: EvChargeState;
  surplus: number;
  startW: number;
  skipReason: string | null;
  homeSoc: number;
  effectiveMinSoc: number;
}

export function shouldStopUnscheduledCharge({
  charging,
  state,
  surplus,
  startW,
  skipReason,
  homeSoc,
  effectiveMinSoc,
}: UnscheduledGuardInput): boolean {
  if (!charging) return false;
  if (state === 'charging' || state === 'cooldown' || state === 'night_charging') return false;
  if (skipReason) return true;
  if (surplus < startW) return true;
  if (homeSoc < effectiveMinSoc) return true;
  return false;
}

// ============================================================================
// Night charge decision (verbatim getNightChargeDecision)
// ============================================================================

export interface NightChargeDecision {
  shouldCharge: boolean;
  factors: string[];
}

export function getNightChargeDecision(
  evBattery: number,
  tomorrowKwh: number | null,
): NightChargeDecision {
  const factors: string[] = [];
  const criticallyLow = evBattery < EV_NIGHT_CHARGE_BELOW;
  const poorForecast = tomorrowKwh !== null && tomorrowKwh < 10; // < 10kWh expected = poor day
  const evModerate = evBattery < 65;

  if (criticallyLow) {
    factors.push(`EV critically low at ${evBattery}% (< ${EV_NIGHT_CHARGE_BELOW}%)`);
  } else if (evModerate && poorForecast) {
    factors.push(`EV at ${evBattery}% with poor forecast tomorrow (${tomorrowKwh?.toFixed(1)}kWh)`);
  }

  return { shouldCharge: factors.length > 0, factors };
}

// ============================================================================
// Charge decision — verbatim branch logic of evaluateCharge (lines 629–705).
// ============================================================================

export type ChargeAction = 'start' | 'stop' | 'hold_waiting' | 'hold_charging';

export interface ChargeDecisionInput {
  state: 'idle' | 'waiting' | 'charging';
  surplus: number;
  startW: number;
  stopW: number;
  homeSoc: number;
  skipReason: string | null;
}

export interface ChargeDecisionResult {
  action: ChargeAction;
  nextState: EvChargeState;
  reason: string;
}

/**
 * Verbatim port of evaluateCharge's idle/waiting/charging branch (lines
 * 629–705). effectiveMinSoc and effectiveStopSoc are both 0 in production
 * (morning home SOC near 0% is normal after overnight discharge — the surplus
 * threshold already prevents grid import), so the SOC comparisons never trip
 * here; they are preserved verbatim for fidelity.
 */
export function decideCharge({
  state,
  surplus,
  startW,
  stopW,
  homeSoc,
  skipReason,
}: ChargeDecisionInput): ChargeDecisionResult {
  const effectiveMinSoc = 0;
  const effectiveStopSoc = 0;

  if (state === 'idle' || state === 'waiting') {
    if (skipReason) {
      return { action: 'hold_waiting', nextState: 'waiting', reason: skipReason };
    }
    if (surplus >= startW && homeSoc >= effectiveMinSoc) {
      return {
        action: 'start',
        nextState: 'cooldown',
        reason: `surplus ${Math.round(surplus)}W ≥ ${startW}W threshold, starting charge`,
      };
    }
    if (surplus < startW) {
      return {
        action: 'hold_waiting',
        nextState: 'waiting',
        reason: `surplus ${Math.round(surplus)}W < ${startW}W threshold`,
      };
    }
    return {
      action: 'hold_waiting',
      nextState: 'waiting',
      reason: `home SOC ${homeSoc}% < ${effectiveMinSoc}% threshold`,
    };
  }

  // state === 'charging'
  if (surplus < stopW || homeSoc < effectiveStopSoc) {
    const reason =
      surplus < stopW
        ? `surplus ${Math.round(surplus)}W < ${stopW}W, stopping charge`
        : `home SOC ${homeSoc}% < ${effectiveStopSoc}%, stopping charge`;
    return { action: 'stop', nextState: 'cooldown', reason };
  }
  return {
    action: 'hold_charging',
    nextState: 'charging',
    reason: `charging — surplus ${Math.round(surplus)}W, home SOC ${homeSoc}%`,
  };
}

// ============================================================================
// Target check — verbatim "EV not plugged in or at target" gate (lines 553–572)
// ============================================================================

export type TargetBranch = 'notPlugged' | 'atTarget' | 'belowTarget';

export interface TargetCheckResult {
  branch: TargetBranch;
  effectiveTarget: number;
  reason: string;
}

/**
 * Verbatim port of the plugged-in / at-target gate. Effective target is the
 * solar target (90%) during solar hours, else the grid target (80%).
 */
export function checkTarget(
  pluggedIn: boolean,
  evBattery: number | null,
  isSolarHours: boolean,
): TargetCheckResult {
  const effectiveTarget = isSolarHours ? EV_SOLAR_TARGET : EV_TARGET_BATTERY;
  if (!pluggedIn) {
    return { branch: 'notPlugged', effectiveTarget, reason: 'not plugged in' };
  }
  if (evBattery !== null && evBattery >= effectiveTarget) {
    return {
      branch: 'atTarget',
      effectiveTarget,
      reason: `battery at ${evBattery}% (target ${effectiveTarget}%)`,
    };
  }
  return {
    branch: 'belowTarget',
    effectiveTarget,
    reason: `battery at ${evBattery ?? '?'}% below target ${effectiveTarget}%`,
  };
}

// ============================================================================
// Reconcile — verbatim "adopt an externally-started charge" gate (lines 604–610)
// ============================================================================

export type ReconcileDecision = 'adopt' | 'hold';

export interface ReconcileResult {
  decision: ReconcileDecision;
  nextState: EvChargeState;
  reason: string;
}

/**
 * Verbatim port: if the car is charging but the scheduler isn't in a
 * charging/night/cooldown state, and current rules allow it, adopt the session.
 */
export function reconcile(charging: boolean, state: EvChargeState): ReconcileResult {
  if (charging && state !== 'charging' && state !== 'night_charging' && state !== 'cooldown') {
    return {
      decision: 'adopt',
      nextState: 'charging',
      reason: 'reconciled: car was already charging and scheduler conditions are met',
    };
  }
  return { decision: 'hold', nextState: state, reason: 'no reconciliation needed' };
}

// ============================================================================
// Night-charge sizing (verbatim from evaluateNightCharge)
// ============================================================================

export interface NightChargeEstimate {
  neededKwh: number;
  hoursToCharge: number;
}

/** kWh needed to reach the grid target + hours at the home charge rate (verbatim). */
export function nightChargeEstimate(evBattery: number): NightChargeEstimate {
  const neededKwh = evKwhNeeded(evBattery); // target = EV_TARGET_BATTERY (80)
  return { neededKwh, hoursToCharge: neededKwh / EV_CHARGE_RATE_KW };
}

// ============================================================================
// Morning summary outlook (verbatim from the morning-summary block, lines 416–435)
// ============================================================================

export interface MorningSummary {
  lines: string[];
  outlook: 'good' | 'tight' | 'unlikely' | 'at-target' | 'not-applicable';
}

/**
 * Verbatim port of the morning-summary outlook lines. `remainingKwh` is today's
 * remaining solar forecast; `evBattery`/`pluggedIn` come from the Kia snapshot.
 * Outlook thresholds: Good when remaining > needed×1.5, Tight when > needed,
 * else Unlikely; EV at/above the solar target reports "at target".
 */
export function morningSummary(
  homeSoc: number | null,
  evBattery: number | null,
  pluggedIn: boolean,
  todayKwh: number | null,
  remainingKwh: number | null,
  strongHoursLeft: number | null,
): MorningSummary {
  const homeStr = homeSoc ?? '?';
  const evStr = evBattery ?? '?';
  const plugged = pluggedIn ? 'plugged in' : 'not plugged in';
  const todayStr = todayKwh != null ? todayKwh.toFixed(1) : '?';
  const strongStr = strongHoursLeft ?? '?';
  const remainStr = remainingKwh != null ? remainingKwh.toFixed(1) : '?';

  const lines = [
    `Home battery: ${homeStr}%`,
    `EV: ${evStr}% (${plugged})`,
    `Solar forecast: ${todayStr}kWh today (${remainStr}kWh remaining, ${strongStr}h strong sun)`,
  ];

  let outlook: MorningSummary['outlook'] = 'not-applicable';
  if (pluggedIn && typeof evBattery === 'number' && evBattery < EV_SOLAR_TARGET) {
    const needed = evKwhNeeded(evBattery, EV_SOLAR_TARGET);
    const remaining = remainingKwh ?? 0;
    if (remaining > needed * 1.5) {
      outlook = 'good';
      lines.push(`Outlook: Good — ${remaining.toFixed(1)}kWh forecast should cover ${needed.toFixed(1)}kWh EV needs`);
    } else if (remaining > needed) {
      outlook = 'tight';
      lines.push(`Outlook: Tight — ${remaining.toFixed(1)}kWh forecast vs ${needed.toFixed(1)}kWh EV needs (home battery gets priority)`);
    } else {
      outlook = 'unlikely';
      lines.push(`Outlook: Unlikely to fully charge EV today (${remaining.toFixed(1)}kWh forecast vs ${needed.toFixed(1)}kWh needed)`);
    }
  } else if (typeof evBattery === 'number' && evBattery >= EV_SOLAR_TARGET) {
    outlook = 'at-target';
    lines.push(`EV already at target (${EV_SOLAR_TARGET}%) — no charging needed`);
  }

  return { lines, outlook };
}
