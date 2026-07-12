import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapTickTelemetry, type GrowattStatusJson, type KiaStatusJson } from './nodes';
import { createDefaultRegistry } from '../index';
import { startRun } from '../../engine';
import { createPradarFlows } from '../../flows/pradar-flows';

// Sample JSON as the EV Demo status endpoints return them.
const GROWATT_SUNNY: GrowattStatusJson = { soc: 80, ppv: 3000, loadPower: 500, gridExport: 2500 };
const KIA_PLUGGED: KiaStatusJson = {
  resMsg: { vehicleStatusInfo: { vehicleStatus: { evStatus: { batteryStatus: 60, batteryPlugin: 2, batteryCharge: false } } } },
};

describe('mapTickTelemetry (Growatt + Kia → tick fields)', () => {
  it('maps live growatt+kia JSON to the tick fields verbatim to the scheduler', () => {
    expect(mapTickTelemetry(GROWATT_SUNNY, KIA_PLUGGED)).toEqual({
      ppv: 3000, loadPower: 500, gridExport: 2500, homeSoc: 80,
      evBattery: 60, pluggedIn: true, charging: false,
    });
  });

  it('derives pluggedIn from batteryPlugin > 0 and charging from batteryCharge === true', () => {
    const kia: KiaStatusJson = {
      resMsg: { vehicleStatusInfo: { vehicleStatus: { evStatus: { batteryStatus: 42, batteryPlugin: 0, batteryCharge: true } } } },
    };
    const out = mapTickTelemetry({ soc: 55, ppv: 0, loadPower: 400, gridExport: 0 }, kia);
    expect(out.pluggedIn).toBe(false); // batteryPlugin 0 → not plugged
    expect(out.charging).toBe(true); // batteryCharge true
    expect(out.evBattery).toBe(42);
    expect(out.homeSoc).toBe(55);
  });

  it('tolerates a missing evStatus path (evBattery null, not plugged, not charging)', () => {
    const out = mapTickTelemetry({ soc: 30, ppv: 100, loadPower: 900, gridExport: 0 }, {});
    expect(out).toEqual({ ppv: 100, loadPower: 900, gridExport: 0, homeSoc: 30, evBattery: null, pluggedIn: false, charging: false });
  });
});

describe('EvLoadTickSnapshot node (env-aware)', () => {
  const flows = createPradarFlows();
  const cycle = flows.find((f) => f.id === 'ev-evaluate-cycle')!;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Pin the wall-clock so prod's real-`now` (new Date()) is deterministic in
   *  tests. Only Date is faked — the fetch's AbortSignal.timeout timers stay real. */
  function pinClock(iso: string): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  function stubPradarFetch() {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const body = url.includes('/api/growatt/status') ? GROWATT_SUNNY : KIA_PLUGGED;
        return { ok: true, status: 200, json: async () => body, text: async () => '' } as Response;
      }),
    );
    return urls;
  }

  it('non-prod passes the scenario snapshot through unchanged with source=test', async () => {
    const registry = createDefaultRegistry(0);
    const run = await startRun({
      flow: cycle, registry, environment: 'dev',
      input: { now: '2026-07-02T13:00:00Z', ppv: 3000, loadPower: 500, gridExport: 2500, homeSoc: 80, evBattery: 60, pluggedIn: true, charging: false, state: 'idle', readings: [], forecast: { remainingKwh: 20, strongHoursLeft: 5, tomorrowKwh: 25 } },
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    const out = run.nodeStates.load.output as Record<string, unknown>;
    expect(out.source).toBe('test');
    expect(out).toMatchObject({ ppv: 3000, loadPower: 500, gridExport: 2500, homeSoc: 80, evBattery: 60, pluggedIn: true, charging: false });
    // routing unchanged: sunny-export still reaches the start-charge path
    expect((run.nodeStates.decision.output as { $branch?: string }).$branch).toBe('start');
    expect(run.nodeStates.startCharge.status).toBe('succeeded');
  });

  it('prod fetches EV Demo and the mapped live telemetry reaches the decision nodes (start-charge)', async () => {
    pinClock('2026-07-02T13:00:00.000Z'); // deterministic sun-clock for prod's real `now`
    const urls = stubPradarFetch();
    const registry = createDefaultRegistry(0);
    const run = await startRun({
      flow: cycle, registry, environment: 'prod', safeMode: true,
      secrets: { EV_DEMO_BASE_URL: 'https://pradar.example.com/' },
      // Live telemetry is IGNORED in prod (fetched); forecast/readings/state/now pass through.
      input: { now: '2026-07-02T13:00:00Z', ppv: 0, loadPower: 0, gridExport: 0, homeSoc: 0, evBattery: 0, pluggedIn: false, charging: false, state: 'idle', readings: [], forecast: { remainingKwh: 20, strongHoursLeft: 5, tomorrowKwh: 25 } },
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    // both status endpoints were hit (base URL trailing slash normalized)
    expect(urls).toEqual([
      'https://pradar.example.com/api/growatt/status',
      'https://pradar.example.com/api/kia/status',
    ]);
    const out = run.nodeStates.load.output as Record<string, unknown>;
    expect(out.source).toBe('prod-pradar');
    // live values (from stubbed JSON, NOT the zeroed input) reached the load node
    expect(out).toMatchObject({ ppv: 3000, loadPower: 500, gridExport: 2500, homeSoc: 80, evBattery: 60, pluggedIn: true, charging: false });
    // and flowed to the decision nodes: sunny export → belowTarget → start
    expect((run.nodeStates.surplus.output as { surplus: number }).surplus).toBe(2500);
    expect((run.nodeStates.target.output as { $branch?: string }).$branch).toBe('belowTarget');
    expect((run.nodeStates.decision.output as { $branch?: string }).$branch).toBe('start');
  });

  it('production fetches EV Demo and the mapped live telemetry reaches the decision nodes (start-charge)', async () => {
    pinClock('2026-07-02T13:00:00.000Z'); // prod uses the REAL clock, not input.now
    const urls = stubPradarFetch();
    const registry = createDefaultRegistry(0);
    const run = await startRun({
      flow: cycle, registry, environment: 'production', safeMode: true,
      secrets: { EV_DEMO_BASE_URL: 'https://pradar.example.com/' },
      // input.now is DELIBERATELY a stale/wrong instant — prod must ignore it and
      // use the live wall-clock (pinned above), so the sun-clock reflects NOW.
      input: { now: '2020-01-01T00:00:00Z', ppv: 0, loadPower: 0, gridExport: 0, homeSoc: 0, evBattery: 0, pluggedIn: false, charging: false, state: 'idle', readings: [], forecast: { remainingKwh: 20, strongHoursLeft: 5, tomorrowKwh: 25 } },
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    // prod overrode `now` with the real clock (the pinned instant), NOT input.now.
    expect((run.nodeStates.load.output as { now: string }).now).toBe('2026-07-02T13:00:00.000Z');
    // both status endpoints were hit (base URL trailing slash normalized)
    expect(urls).toEqual([
      'https://pradar.example.com/api/growatt/status',
      'https://pradar.example.com/api/kia/status',
    ]);
    const out = run.nodeStates.load.output as Record<string, unknown>;
    expect(out.source).toBe('prod-pradar');
    // live values (from stubbed JSON, NOT the zeroed input) reached the load node
    expect(out).toMatchObject({ ppv: 3000, loadPower: 500, gridExport: 2500, homeSoc: 80, evBattery: 60, pluggedIn: true, charging: false });
    // and flowed to the decision nodes: sunny export → belowTarget → start
    expect((run.nodeStates.surplus.output as { surplus: number }).surplus).toBe(2500);
    expect((run.nodeStates.target.output as { $branch?: string }).$branch).toBe('belowTarget');
    expect((run.nodeStates.decision.output as { $branch?: string }).$branch).toBe('start');
  });

  it('prod throws a clear error when EV_DEMO_BASE_URL is missing', async () => {
    const registry = createDefaultRegistry(0);
    const run = await startRun({
      flow: cycle, registry, environment: 'prod', secrets: {},
      input: { now: '2026-07-02T13:00:00Z', state: 'idle', readings: [], forecast: {} },
    }).runToEnd();
    expect(run.status).toBe('failed');
    expect(run.nodeStates.load.error).toContain('EV_DEMO_BASE_URL');
  });
});
