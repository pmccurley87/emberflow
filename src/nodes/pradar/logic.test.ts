import { describe, expect, it } from 'vitest';
import {
  checkTarget,
  computeSurplus,
  computeTrendWindow,
  decideCharge,
  estimateSessionKwh,
  evKwhNeeded,
  getCooldownMs,
  getNightChargeDecision,
  getThresholds,
  getTrend,
  morningSummary,
  nightChargeEstimate,
  reconcile,
  shouldStopUnscheduledCharge,
  sunTimes,
  type Reading,
} from './logic';

// Demo location (Berlin). Instants below fall in solar / golden / night windows.
const DAY = '2026-07-02T13:00:00Z'; // solar hours, ~7h to sunset
const GOLDEN = '2026-07-02T19:06:00Z'; // ~1h to sunset
const AFTER_SUNSET = '2026-07-02T22:00:00Z'; // dark, hour 22 (not night window)
const NIGHT = '2026-07-02T23:30:00Z'; // hour 23, night window
const DAY_HOUR = '2026-07-02T14:00:00Z'; // hour 14, day

describe('sunTimes', () => {
  it('reports solar hours mid-afternoon', () => {
    const c = sunTimes(DAY);
    expect(c.isSolarHours).toBe(true);
    expect(c.isNightWindow).toBe(false);
    expect(c.hoursUntilSunset).toBeGreaterThan(6);
    expect(c.hoursUntilSunset).toBeLessThan(8);
  });

  it('flags the golden hour (≤2h to sunset) while still in solar hours', () => {
    const c = sunTimes(GOLDEN);
    expect(c.isSolarHours).toBe(true);
    expect(c.hoursUntilSunset).toBeGreaterThan(0);
    expect(c.hoursUntilSunset).toBeLessThanOrEqual(2);
  });

  it('is outside solar hours after sunset without being in the night window at 22:00', () => {
    const c = sunTimes(AFTER_SUNSET);
    expect(c.isSolarHours).toBe(false);
    expect(c.hour).toBe(22);
    expect(c.isNightWindow).toBe(false);
    expect(c.hoursUntilSunset).toBe(0);
  });

  it('enters the night window at 23:30 and stays in it before 05:00', () => {
    expect(sunTimes(NIGHT).isNightWindow).toBe(true);
    expect(sunTimes('2026-07-02T04:30:00Z').isNightWindow).toBe(true);
    expect(sunTimes(DAY_HOUR).isNightWindow).toBe(false);
  });
});

describe('computeSurplus', () => {
  it('uses grid export when exporting', () => {
    expect(computeSurplus(3000, 500, 1200)).toEqual({ surplus: 1200, branch: 'export' });
  });
  it('falls back to ppv−load when not exporting', () => {
    expect(computeSurplus(3000, 500, 0)).toEqual({ surplus: 2500, branch: 'ppv-load' });
  });
  it('clamps ppv−load at zero', () => {
    expect(computeSurplus(200, 900, 0)).toEqual({ surplus: 0, branch: 'ppv-load' });
  });
});

describe('evKwhNeeded / estimateSessionKwh', () => {
  it('kWh needed scales from the 77.4kWh pack', () => {
    expect(evKwhNeeded(60)).toBeCloseTo((20 / 100) * 77.4, 5); // to 80%
    expect(evKwhNeeded(90, 90)).toBe(0);
    expect(evKwhNeeded(95, 90)).toBe(0); // never negative
  });
  it('forecast path caps remaining kWh by charge rate over hours left', () => {
    expect(estimateSessionKwh(9999, 4, { remainingKwh: 5, strongHoursLeft: 3 })).toBe(5);
    expect(estimateSessionKwh(9999, 1, { remainingKwh: 5, strongHoursLeft: 3 })).toBeCloseTo(2.3, 5);
  });
  it('naive path assumes current surplus sustains, capped at charge rate', () => {
    expect(estimateSessionKwh(1000, 2, null)).toBeCloseTo(2, 5); // 1kW*2h
    expect(estimateSessionKwh(5000, 2, null)).toBeCloseTo(4.6, 5); // capped at 2.3kW
  });
});

describe('getThresholds — bands (verbatim)', () => {
  it('flat home battery (no buffer, EV not urgent) keeps the 2000/800 default', () => {
    const t = getThresholds(10, 1500, 4, 70, null);
    expect(t.startW).toBe(2000);
    expect(t.stopW).toBe(800);
    expect(t.skipReason).toBeNull();
    expect(t.reasons[0]).toContain('flat');
  });

  it('home buffer → 1200/400 (ported case)', () => {
    const t = getThresholds(99, 300, 4, 60, null);
    expect(t.startW).toBe(1200);
    expect(t.stopW).toBe(400);
    expect(t.reasons).toEqual(['home 99% has buffer — EV priority, home tops up EV shortfall']);
  });

  it('EV urgent (<50%) → 1200/400 accepting grid', () => {
    const t = getThresholds(10, 1500, 4, 40, null);
    expect(t.startW).toBe(1200);
    expect(t.stopW).toBe(400);
    expect(t.reasons[0]).toContain('ev urgent');
  });

  it('predictive: full battery + strong ppv → 500/200 (ported case)', () => {
    const t = getThresholds(99, 2200, 4, 60, null);
    expect(t.startW).toBe(500);
    expect(t.stopW).toBe(200);
    expect(t.reasons).toEqual([
      'home 99% has buffer — EV priority, home tops up EV shortfall',
      'predictive: home SOC 99% + ppv 2200W → export imminent',
    ]);
  });

  it('golden hour (≤2h to sunset) pulls thresholds to ≤800/200', () => {
    const t = getThresholds(10, 500, 1.5, 70, null);
    expect(t.startW).toBe(800);
    expect(t.stopW).toBe(200);
    expect(t.reasons.some((r) => r.startsWith('golden hour'))).toBe(true);
  });

  it('worth-it skip: tiny remaining solar with real need', () => {
    const t = getThresholds(50, 100, 0.1, 60, { remainingKwh: 0.2, strongHoursLeft: 0 });
    expect(t.skipReason).toContain('not worth it');
  });

  it('worth-it skip: EV ≥65% with <1.5kWh remaining', () => {
    const t = getThresholds(50, 100, 1, 70, { remainingKwh: 1.0, strongHoursLeft: 0 });
    expect(t.skipReason).toContain('not worth a session');
  });

  it('trend override: surplus rising fast → start ≤1000', () => {
    const t = getThresholds(10, 1500, 4, 70, null, { surplusTrend: 300, socTrend: 0 });
    expect(t.startW).toBe(1000);
    expect(t.reasons.some((r) => r.startsWith('trend: surplus rising'))).toBe(true);
  });

  it('trend override: home SOC climbing fast above 75% → start ≤600', () => {
    const t = getThresholds(80, 1500, 4, 70, null, { surplusTrend: 0, socTrend: 3 });
    expect(t.startW).toBe(600);
    expect(t.reasons.some((r) => r.startsWith('trend: home SOC rising'))).toBe(true);
  });
});

describe('shouldStopUnscheduledCharge (verbatim, ported cases)', () => {
  const base = { charging: true, state: 'idle' as const, surplus: 700, startW: 1200, skipReason: null, homeSoc: 80, effectiveMinSoc: 0 };
  it('stops an unscheduled charge when start conditions are not met', () => {
    expect(shouldStopUnscheduledCharge(base)).toBe(true);
  });
  it('never touches a scheduler-owned charging session (hysteresis)', () => {
    expect(shouldStopUnscheduledCharge({ ...base, state: 'charging' })).toBe(false);
  });
  it('leaves it alone when not charging', () => {
    expect(shouldStopUnscheduledCharge({ ...base, charging: false })).toBe(false);
  });
  it('stops on a skip reason even when surplus clears the start threshold', () => {
    expect(shouldStopUnscheduledCharge({ ...base, surplus: 5000, skipReason: 'not worth it' })).toBe(true);
  });
  it('stops when home SOC is below the effective min', () => {
    expect(shouldStopUnscheduledCharge({ ...base, surplus: 5000, homeSoc: 5, effectiveMinSoc: 10 })).toBe(true);
  });
});

describe('getNightChargeDecision (verbatim, ported cases)', () => {
  it('does not charge a moderate battery with a useful forecast', () => {
    expect(getNightChargeDecision(50, 24)).toEqual({ shouldCharge: false, factors: [] });
    expect(getNightChargeDecision(40, 24)).toEqual({ shouldCharge: false, factors: [] });
  });
  it('charges below 35% regardless of forecast', () => {
    expect(getNightChargeDecision(34, 24)).toEqual({ shouldCharge: true, factors: ['EV critically low at 34% (< 35%)'] });
  });
  it('charges a moderate battery only with a poor forecast', () => {
    expect(getNightChargeDecision(50, 8)).toEqual({ shouldCharge: true, factors: ['EV at 50% with poor forecast tomorrow (8.0kWh)'] });
  });
  it('treats a null forecast as not-poor (moderate battery skips)', () => {
    expect(getNightChargeDecision(50, null).shouldCharge).toBe(false);
  });
  it('sizes the session at the 2.3kW home rate', () => {
    const est = nightChargeEstimate(30);
    expect(est.neededKwh).toBeCloseTo((50 / 100) * 77.4, 5);
    expect(est.hoursToCharge).toBeCloseTo(est.neededKwh / 2.3, 5);
  });
});

describe('getCooldownMs / getTrend (verbatim stddev bands)', () => {
  const mk = (surpluses: number[]): Reading[] => surpluses.map((s) => ({ surplus: s, homeSoc: 50, ppv: 1000 }));
  it('defaults to 10min with fewer than 3 readings', () => {
    expect(getCooldownMs(mk([100, 200]))).toBe(10 * 60_000);
  });
  it('stable (stdDev < 200) → 5min', () => {
    expect(getCooldownMs(mk([1000, 1010, 990]))).toBe(5 * 60_000);
  });
  it('volatile (stdDev > 800) → 15min', () => {
    expect(getCooldownMs(mk([0, 2500, 0, 2500]))).toBe(15 * 60_000);
  });
  it('mid-volatility → default 10min', () => {
    expect(getCooldownMs(mk([1000, 1500, 700]))).toBe(10 * 60_000);
  });
  it('getTrend is the per-cycle slope from first to last', () => {
    const r = mk([100, 400, 700]); // +300/cycle over 2 cycles
    expect(getTrend(r, 'surplus')).toBe(300);
    expect(getTrend([], 'surplus')).toBe(0);
  });
  it('computeTrendWindow bundles slopes + cooldown', () => {
    const tw = computeTrendWindow([
      { surplus: 100, homeSoc: 70, ppv: 800 },
      { surplus: 400, homeSoc: 72, ppv: 1100 },
      { surplus: 700, homeSoc: 74, ppv: 1400 },
    ]);
    expect(tw.surplusTrend).toBe(300);
    expect(tw.socTrend).toBe(2);
    expect(tw.ppvTrend).toBe(300);
    expect(tw.cooldownMs).toBe(10 * 60_000); // stdDev of [100,400,700] ≈ 245 → default band
  });
});

describe('decideCharge (verbatim evaluateCharge branch)', () => {
  it('starts from idle when surplus clears startW', () => {
    const d = decideCharge({ state: 'idle', surplus: 2500, startW: 1200, stopW: 400, homeSoc: 80, skipReason: null });
    expect(d.action).toBe('start');
    expect(d.nextState).toBe('cooldown');
  });
  it('holds in waiting when surplus is below startW', () => {
    const d = decideCharge({ state: 'waiting', surplus: 900, startW: 1200, stopW: 400, homeSoc: 80, skipReason: null });
    expect(d.action).toBe('hold_waiting');
  });
  it('a skip reason forces hold_waiting even above startW', () => {
    const d = decideCharge({ state: 'idle', surplus: 5000, startW: 1200, stopW: 400, homeSoc: 80, skipReason: 'not worth it' });
    expect(d.action).toBe('hold_waiting');
    expect(d.reason).toBe('not worth it');
  });
  it('continues charging while surplus stays above stopW', () => {
    const d = decideCharge({ state: 'charging', surplus: 900, startW: 1200, stopW: 400, homeSoc: 80, skipReason: null });
    expect(d.action).toBe('hold_charging');
  });
  it('stops charging once surplus drops below stopW', () => {
    const d = decideCharge({ state: 'charging', surplus: 300, startW: 1200, stopW: 400, homeSoc: 80, skipReason: null });
    expect(d.action).toBe('stop');
    expect(d.nextState).toBe('cooldown');
  });
});

describe('checkTarget (verbatim)', () => {
  it('90% effective target during solar hours, 80% otherwise', () => {
    expect(checkTarget(true, 85, true).branch).toBe('belowTarget');
    expect(checkTarget(true, 85, false).branch).toBe('atTarget');
    expect(checkTarget(true, 91, true).branch).toBe('atTarget');
  });
  it('not plugged in short-circuits', () => {
    expect(checkTarget(false, 20, true).branch).toBe('notPlugged');
  });
});

describe('reconcile (verbatim)', () => {
  it('adopts an external charge when idle/waiting', () => {
    expect(reconcile(true, 'waiting').decision).toBe('adopt');
    expect(reconcile(true, 'idle').decision).toBe('adopt');
  });
  it('holds when already charging or not charging', () => {
    expect(reconcile(true, 'charging').decision).toBe('hold');
    expect(reconcile(false, 'idle').decision).toBe('hold');
    expect(reconcile(true, 'cooldown').decision).toBe('hold');
  });
});

describe('morningSummary (verbatim outlook)', () => {
  it('Good when remaining > need×1.5', () => {
    // EV 60% → need to 90% = 23.22kWh; remaining 40 > 34.8
    expect(morningSummary(80, 60, true, 40, 40, 5).outlook).toBe('good');
  });
  it('Tight when remaining > need but ≤ need×1.5', () => {
    expect(morningSummary(80, 60, true, 25, 25, 3).outlook).toBe('tight');
  });
  it('Unlikely when remaining ≤ need', () => {
    expect(morningSummary(80, 60, true, 10, 10, 1).outlook).toBe('unlikely');
  });
  it('at-target when EV ≥ 90%', () => {
    expect(morningSummary(80, 92, true, 40, 40, 5).outlook).toBe('at-target');
  });
  it('not-applicable when unplugged', () => {
    expect(morningSummary(80, 60, false, 40, 40, 5).outlook).toBe('not-applicable');
  });
});
