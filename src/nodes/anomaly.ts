import type { NodeExecutionContext, NodeRegistry } from '../engine';

/**
 * Anomaly Detection API nodes.
 *
 * A demo integration for time-series anomaly detection backed by a pluggable
 * local service. Detection nodes POST to that service (default
 * http://localhost:8091, overridable per environment); in the browser they go
 * through the Vite dev proxy at /anomaly to keep requests same-origin.
 *
 * The quota / API-key nodes are self-contained business-logic examples: they
 * only compute and return values (no persistence, no outbound writes), so none
 * are declared `effects: 'mutation'`. `DetectEntireSeries` /
 * `DetectLastPoint` / `DetectAttributed` POST to the detection service, but
 * only to run detection (a read), not to create or change a resource.
 */

/**
 * Resolves the anomaly-detector service base URL. Prefers the run's
 * environment (`ctx.vars.ANOMALY_API_URL`, set per-environment by the
 * runner); falls back to the pre-environments resolution (browser: Vite
 * proxy at /anomaly; Node: ANOMALY_API_URL process env, else localhost).
 */
function resolveApiBase(ctx: NodeExecutionContext): string {
  if (ctx.vars.ANOMALY_API_URL) return ctx.vars.ANOMALY_API_URL;
  if (typeof window !== 'undefined') return '/anomaly';
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.ANOMALY_API_URL ?? 'http://localhost:8091';
}

interface SeriesPoint {
  timestamp: string;
  value: number;
  dims?: Record<string, Record<string, number>>;
}

async function postJson(
  ctx: NodeExecutionContext,
  path: string,
  apiKey: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const base = resolveApiBase(ctx);
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} from ${path}: ${text.slice(0, 200)}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function hourlyTimestamps(count: number): string[] {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * 3_600_000).toISOString(),
  );
}

/** Plan catalog: monthly quota + price by plan code. */
const PLANS: Record<string, { name: string; quota: number; priceUsd: number }> = {
  anomaly_free: { name: 'Free', quota: 1_000, priceUsd: 0 },
  anomaly_starter: { name: 'Starter', quota: 50_000, priceUsd: 29 },
  anomaly_pro: { name: 'Pro', quota: 500_000, priceUsd: 99 },
};

export function registerAnomalyNodes(registry: NodeRegistry): void {
  // ── Series sources ────────────────────────────────────────────────

  registry.register(
    {
      type: 'BuildSeries',
      label: 'Build Series',
      description: 'Generates an hourly metric series with a configurable injected spike.',
      category: 'anomaly',
      traceKind: 'compute',
      // Parameters are declared as inputs too, so upstream nodes (e.g. an
      // Input entry node) can drive them; config remains the fallback
      // (resolveInput copies config values for declared input fields).
      inputSchema: {
        fields: [
          { name: 'points', type: 'number' },
          { name: 'baseValue', type: 'number' },
          { name: 'spikeIndex', type: 'number' },
          { name: 'spikeFactor', type: 'number' },
        ],
      },
      configSchema: {
        fields: [
          { name: 'points', type: 'number' },
          { name: 'baseValue', type: 'number' },
          { name: 'spikeIndex', type: 'number' },
          { name: 'spikeFactor', type: 'number' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'series', type: 'array' },
          { name: 'pointCount', type: 'number' },
        ],
      },
    },
    async (ctx) => {
      const points = Number(ctx.input.points ?? 24);
      const base = Number(ctx.input.baseValue ?? 100);
      const spikeIndex = ctx.input.spikeIndex === undefined ? -1 : Number(ctx.input.spikeIndex);
      const spikeFactor = Number(ctx.input.spikeFactor ?? 3);
      const timestamps = hourlyTimestamps(points);
      const series: SeriesPoint[] = timestamps.map((timestamp, i) => {
        // Deterministic gentle wave so the series is realistic but replayable.
        let value = base + Math.round(Math.sin(i / 3) * base * 0.08);
        if (i === (spikeIndex < 0 ? -999 : spikeIndex)) value = Math.round(value * spikeFactor);
        return { timestamp, value };
      });
      ctx.log('info', `Built ${points}-point hourly series${spikeIndex >= 0 ? `, spike ×${spikeFactor} at index ${spikeIndex}` : ''}`);
      return { series, pointCount: points };
    },
  );

  registry.register(
    {
      type: 'BuildDimensionalSeries',
      label: 'Build Dimensional Series',
      description: 'Generates a series with per-point channel dimensions; the spike is driven by one slice (for RCA).',
      category: 'anomaly',
      traceKind: 'compute',
      configSchema: {
        fields: [
          { name: 'points', type: 'number', required: true },
          { name: 'baseValue', type: 'number', required: true },
          { name: 'spikeIndex', type: 'number', required: true },
          { name: 'culpritSlice', type: 'enum', enumValues: ['organic', 'paid'], required: true },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'series', type: 'array' },
          { name: 'culpritSlice', type: 'string' },
        ],
      },
    },
    async (ctx) => {
      const points = Number(ctx.config.points ?? 14);
      const base = Number(ctx.config.baseValue ?? 100);
      const spikeIndex = Number(ctx.config.spikeIndex ?? points - 2);
      const culprit = String(ctx.config.culpritSlice ?? 'paid');
      const timestamps = hourlyTimestamps(points);
      const series: SeriesPoint[] = timestamps.map((timestamp, i) => {
        const value = base;
        let organic = Math.round(value * 0.6);
        let paid = value - organic;
        if (i === spikeIndex) {
          // Triple the culprit slice only — Adtributor should name it.
          if (culprit === 'paid') paid *= 3;
          else organic *= 3;
        }
        return {
          timestamp,
          value: organic + paid,
          dims: { channel: { organic, paid } },
        };
      });
      ctx.log('info', `Built ${points}-point dimensional series, ${culprit} spike at index ${spikeIndex}`);
      return { series, culpritSlice: culprit };
    },
  );

  // ── Live detection calls (real service via /anomaly proxy) ────────

  registry.register(
    {
      type: 'DetectEntireSeries',
      label: 'Detect · Entire Series',
      description: 'POST /timeseries/entire/detect — STL decomposition + residual-band flagging over the whole series.',
      simpleDescription: 'Scans the whole series for unusual spikes or dips',
      category: 'anomaly',
      traceKind: 'http',
      traceDetail: 'POST {ANOMALY_API_URL}/timeseries/entire/detect (browser: /anomaly proxy → localhost:8091)',
      inputSchema: {
        fields: [{ name: 'series', type: 'array', required: true }],
      },
      configSchema: {
        fields: [
          { name: 'apiKey', type: 'string' },
          { name: 'sensitivity', type: 'number' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'isAnomaly', type: 'array' },
          { name: 'expectedValues', type: 'array' },
          { name: 'upperMargins', type: 'array' },
          { name: 'lowerMargins', type: 'array' },
          { name: 'period', type: 'number' },
        ],
      },
    },
    async (ctx) => {
      const series = ctx.input.series as SeriesPoint[];
      const apiKey = ctx.secrets.ANOMALY_API_KEY ?? String(ctx.config.apiKey ?? '');
      if (!apiKey) throw new Error('No API key: set secret ANOMALY_API_KEY or config apiKey');
      ctx.log('info', `POST ${resolveApiBase(ctx)}/timeseries/entire/detect (${series.length} points)`);
      const data = await postJson(ctx, '/timeseries/entire/detect', apiKey, {
        series,
        sensitivity: Number(ctx.config.sensitivity ?? 80),
      });
      const flags = (data.isAnomaly as boolean[]) ?? [];
      ctx.log('info', `Service flagged ${flags.filter(Boolean).length}/${flags.length} points, period=${String(data.period)}`);
      return data;
    },
  );

  registry.register(
    {
      type: 'DetectLastPoint',
      label: 'Detect · Last Point',
      description: 'POST /timeseries/last/detect — streaming-style verdict for the latest point only.',
      simpleDescription: 'Checks whether the newest data point looks unusual',
      category: 'anomaly',
      traceKind: 'http',
      traceDetail: 'POST {ANOMALY_API_URL}/timeseries/last/detect (browser: /anomaly proxy → localhost:8091)',
      inputSchema: {
        fields: [{ name: 'series', type: 'array', required: true }],
      },
      configSchema: {
        fields: [
          { name: 'apiKey', type: 'string' },
          { name: 'sensitivity', type: 'number' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'isAnomaly', type: 'boolean' },
          { name: 'isPositiveAnomaly', type: 'boolean' },
          { name: 'expectedValue', type: 'number' },
          { name: 'upperMargin', type: 'number' },
          { name: 'lowerMargin', type: 'number' },
          { name: 'suggestedWindow', type: 'number' },
        ],
      },
    },
    async (ctx) => {
      const series = ctx.input.series as SeriesPoint[];
      const apiKey = ctx.secrets.ANOMALY_API_KEY ?? String(ctx.config.apiKey ?? '');
      if (!apiKey) throw new Error('No API key: set secret ANOMALY_API_KEY or config apiKey');
      ctx.log('info', `POST ${resolveApiBase(ctx)}/timeseries/last/detect (${series.length} points)`);
      const data = await postJson(ctx, '/timeseries/last/detect', apiKey, {
        series,
        sensitivity: Number(ctx.config.sensitivity ?? 80),
      });
      ctx.log('info', `Last point anomaly=${String(data.isAnomaly)} (expected ${String(data.expectedValue)})`);
      return data;
    },
  );

  registry.register(
    {
      type: 'DetectAttributed',
      label: 'Detect · Attributed (RCA)',
      description: 'POST /detect/attributed — detection plus Adtributor root-cause analysis over dimensions.',
      simpleDescription: 'Finds anomalies and which dimension caused them',
      category: 'anomaly',
      traceKind: 'http',
      traceDetail: 'POST {ANOMALY_API_URL}/detect/attributed (browser: /anomaly proxy → localhost:8091)',
      inputSchema: {
        fields: [{ name: 'series', type: 'array', required: true }],
      },
      configSchema: {
        fields: [
          { name: 'apiKey', type: 'string' },
          { name: 'sensitivity', type: 'number' },
          { name: 'topK', type: 'number' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'rca', type: 'array' },
          { name: 'response', type: 'object' },
          { name: 'warnings', type: 'array' },
        ],
      },
    },
    async (ctx) => {
      const series = ctx.input.series as SeriesPoint[];
      const apiKey = ctx.secrets.ANOMALY_API_KEY ?? String(ctx.config.apiKey ?? '');
      if (!apiKey) throw new Error('No API key: set secret ANOMALY_API_KEY or config apiKey');
      ctx.log('info', `POST ${resolveApiBase(ctx)}/detect/attributed (${series.length} points)`);
      const data = await postJson(ctx, '/detect/attributed', apiKey, {
        series,
        sensitivity: Number(ctx.config.sensitivity ?? 80),
        topK: Number(ctx.config.topK ?? 3),
      });
      const rca = (data.rca as unknown[]) ?? [];
      ctx.log('info', `RCA returned ${rca.length} attributed anomal${rca.length === 1 ? 'y' : 'ies'}`);
      return data;
    },
  );

  // ── Post-processing ───────────────────────────────────────────────

  registry.register(
    {
      type: 'SummarizeAnomalies',
      label: 'Summarize Anomalies',
      description: 'Reduces per-point anomaly flags to indices, count, and a headline.',
      simpleDescription: 'Summarizes how many anomalies were found',
      category: 'anomaly',
      traceKind: 'compute',
      inputSchema: {
        fields: [
          { name: 'isAnomaly', type: 'array', required: true },
          { name: 'series', type: 'array', required: true },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'anomalyCount', type: 'number' },
          { name: 'anomalyIndices', type: 'array' },
          { name: 'headline', type: 'string' },
        ],
      },
    },
    async (ctx) => {
      const flags = (ctx.input.isAnomaly as boolean[]) ?? [];
      const series = (ctx.input.series as SeriesPoint[]) ?? [];
      const anomalyIndices = flags.flatMap((f, i) => (f ? [i] : []));
      const detail = anomalyIndices
        .map((i) => `#${i} (${series[i]?.timestamp ?? '?'} → ${series[i]?.value ?? '?'})`)
        .join(', ');
      const headline =
        anomalyIndices.length === 0
          ? `No anomalies across ${flags.length} points`
          : `${anomalyIndices.length} anomal${anomalyIndices.length === 1 ? 'y' : 'ies'} in ${flags.length} points: ${detail}`;
      ctx.log('info', headline);
      return { anomalyCount: anomalyIndices.length, anomalyIndices, headline };
    },
  );

  registry.register(
    {
      type: 'ExtractRootCause',
      label: 'Extract Root Cause',
      description: 'Pulls the top attributed dimension slice out of an RCA response.',
      simpleDescription: 'Finds the main cause of the anomaly',
      category: 'anomaly',
      traceKind: 'compute',
      inputSchema: {
        fields: [{ name: 'rca', type: 'array', required: true }],
      },
      outputSchema: {
        fields: [
          { name: 'anomalyCount', type: 'number' },
          { name: 'topDimension', type: 'string' },
          { name: 'topSlice', type: 'string' },
          { name: 'contributionScore', type: 'number' },
          { name: 'confidence', type: 'number' },
          { name: 'headline', type: 'string' },
        ],
      },
    },
    async (ctx) => {
      const rca = (ctx.input.rca ?? []) as Array<{
        timestamp: string;
        rootCause: {
          confidence: number;
          dimensions: Array<{
            name: string;
            topValues: Array<{ value: string; contributionScore: number }>;
          }>;
        };
      }>;
      if (rca.length === 0) {
        ctx.log('warn', 'RCA list empty — nothing to attribute');
        return { anomalyCount: 0, topDimension: '—', topSlice: '—', contributionScore: 0, confidence: 0, headline: 'No attributed anomalies' };
      }
      const first = rca[0];
      const dimension = first.rootCause.dimensions[0];
      const slice = dimension?.topValues[0];
      const headline = `Anomaly at ${first.timestamp}: ${dimension?.name}=${slice?.value} (contribution ${(slice?.contributionScore ?? 0).toFixed(2)}, confidence ${first.rootCause.confidence.toFixed(2)})`;
      ctx.log('info', headline);
      return {
        anomalyCount: rca.length,
        topDimension: dimension?.name ?? '—',
        topSlice: slice?.value ?? '—',
        contributionScore: slice?.contributionScore ?? 0,
        confidence: first.rootCause.confidence,
        headline,
      };
    },
  );

  registry.register(
    {
      type: 'ClassifySeverity',
      label: 'Classify Severity',
      description: 'Routes on whether the series carried any anomalies (anomalous vs clean).',
      category: 'anomaly',
      traceKind: 'compute',
      tags: ['branching'],
      inputSchema: {
        fields: [{ name: 'anomalyCount', type: 'number', required: true }],
      },
      outputSchema: {
        fields: [
          { name: 'severity', type: 'enum', enumValues: ['anomalous', 'clean'] },
          { name: 'anomalyCount', type: 'number' },
        ],
      },
    },
    async (ctx) => {
      const anomalyCount = Number(ctx.input.anomalyCount ?? 0);
      const severity = anomalyCount >= 1 ? 'anomalous' : 'clean';
      ctx.log('info', `Severity ${severity} (${anomalyCount} anomal${anomalyCount === 1 ? 'y' : 'ies'})`);
      return { severity, anomalyCount };
    },
  );

  registry.register(
    {
      type: 'ComposeIncident',
      label: 'Compose Incident',
      description: 'Builds an incident record with a priority derived from the anomaly count.',
      category: 'anomaly',
      traceKind: 'compute',
      inputSchema: {
        fields: [
          { name: 'headline', type: 'string', required: true },
          { name: 'anomalyCount', type: 'number' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'incident', type: 'string' },
          { name: 'priority', type: 'enum', enumValues: ['P1', 'P2'] },
        ],
      },
    },
    async (ctx) => {
      const headline = String(ctx.input.headline ?? 'Anomalies detected');
      const anomalyCount = Number(ctx.input.anomalyCount ?? 0);
      const priority = anomalyCount >= 3 ? 'P1' : 'P2';
      const incident = `[${priority}] ${headline}`;
      ctx.log('info', `Raised ${priority} incident: ${headline}`);
      return { incident, priority };
    },
  );

  // ── Quota & plans ─────────────────────────────────────────────────

  registry.register(
    {
      type: 'PlanCatalog',
      label: 'Plan Catalog',
      description: 'Resolves a plan code to quota and price (unknown codes fail safe to Free).',
      simpleDescription: 'Looks up a plan’s quota and price',
      category: 'anomaly-ops',
      traceKind: 'compute',
      configSchema: {
        fields: [
          {
            name: 'planCode',
            type: 'enum',
            enumValues: ['anomaly_free', 'anomaly_starter', 'anomaly_pro'],
            required: true,
          },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'planCode', type: 'string' },
          { name: 'name', type: 'string' },
          { name: 'quota', type: 'number' },
          { name: 'priceUsd', type: 'number' },
        ],
      },
    },
    async (ctx) => {
      const requested = String(ctx.config.planCode ?? 'anomaly_free');
      const plan = PLANS[requested] ?? PLANS.anomaly_free;
      const planCode = PLANS[requested] ? requested : 'anomaly_free';
      ctx.log('info', `Plan ${planCode}: ${plan.quota.toLocaleString()} calls/mo, $${plan.priceUsd}`);
      return { planCode, ...plan };
    },
  );

  registry.register(
    {
      type: 'UsageState',
      label: 'Usage State',
      description: 'Computes percentUsed / warn80 / overQuota for the current period.',
      simpleDescription: 'Checks how much of the plan’s quota has been used',
      category: 'anomaly-ops',
      traceKind: 'compute',
      inputSchema: {
        fields: [
          { name: 'calls', type: 'number', required: true },
          { name: 'quota', type: 'number', required: true },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'period', type: 'string' },
          { name: 'calls', type: 'number' },
          { name: 'percentUsed', type: 'number' },
          { name: 'warn80', type: 'boolean' },
          { name: 'overQuota', type: 'boolean' },
        ],
      },
    },
    async (ctx) => {
      const calls = Number(ctx.input.calls);
      const quota = Number(ctx.input.quota);
      const percentUsed = Math.round((calls / quota) * 1000) / 10;
      const overQuota = calls >= quota;
      const warn80 = calls >= 0.8 * quota;
      const period = new Date().toISOString().slice(0, 7);
      ctx.log('info', `${period}: ${calls}/${quota} calls (${percentUsed}%) warn80=${warn80} overQuota=${overQuota}`);
      return { period, calls, percentUsed, warn80, overQuota };
    },
  );

  registry.register(
    {
      type: 'ClassifyQuotaEmail',
      label: 'Classify Quota Email',
      description: 'Decides exceeded / warning / none for the 5-minute email sweep.',
      simpleDescription: 'Decides whether to send a quota warning email',
      category: 'anomaly-ops',
      traceKind: 'compute',
      inputSchema: {
        fields: [
          { name: 'warn80', type: 'boolean', required: true },
          { name: 'overQuota', type: 'boolean', required: true },
        ],
      },
      configSchema: {
        fields: [
          { name: 'alreadyWarned', type: 'boolean' },
          { name: 'alreadyNotifiedExceeded', type: 'boolean' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'action', type: 'enum', enumValues: ['exceeded', 'warning', 'none'] },
          { name: 'reason', type: 'string' },
        ],
      },
    },
    async (ctx) => {
      const overQuota = Boolean(ctx.input.overQuota);
      const warn80 = Boolean(ctx.input.warn80);
      const warnedAt = Boolean(ctx.config.alreadyWarned);
      const exceededNotifiedAt = Boolean(ctx.config.alreadyNotifiedExceeded);
      let action: 'exceeded' | 'warning' | 'none' = 'none';
      let reason = 'below warning threshold or already notified';
      if (overQuota && !exceededNotifiedAt) {
        action = 'exceeded';
        reason = 'over quota and exceeded email not yet sent';
      } else if (warn80 && !overQuota && !warnedAt) {
        action = 'warning';
        reason = 'past 80% of quota and warning email not yet sent';
      }
      ctx.log('info', `Email action: ${action} — ${reason}`);
      return { action, reason };
    },
  );

  // ── API keys ─────────────────────────────────────────────────────

  registry.register(
    {
      type: 'GenerateApiKey',
      label: 'Generate API Key',
      description: 'Issues an ef_ak_ key, SHA-256 hashed at rest, 15-char display prefix.',
      simpleDescription: 'Creates a new API key',
      category: 'anomaly-ops',
      traceKind: 'compute',
      configSchema: {
        fields: [{ name: 'label', type: 'string' }],
      },
      outputSchema: {
        fields: [
          { name: 'rawKey', type: 'string' },
          { name: 'keyPrefix', type: 'string' },
          { name: 'hash', type: 'string' },
          { name: 'label', type: 'string' },
        ],
      },
    },
    async (ctx) => {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      const rawKey = `ef_ak_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawKey));
      const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      const keyPrefix = rawKey.slice(0, 15);
      ctx.log('info', `Issued key ${keyPrefix}… (raw key shown once; only the hash is stored)`);
      return { rawKey, keyPrefix, hash, label: String(ctx.config.label ?? 'default') };
    },
  );

  registry.register(
    {
      type: 'EnforceKeyLimit',
      label: 'Enforce Key Limit',
      description: 'Rejects issuance when the user already has 5 active keys (set activeKeyCount to 5 to see the failure path).',
      simpleDescription: 'Blocks new keys once the limit is reached',
      category: 'anomaly-ops',
      traceKind: 'compute',
      inputSchema: {
        fields: [{ name: 'keyPrefix', type: 'string', required: true }],
      },
      configSchema: {
        fields: [{ name: 'activeKeyCount', type: 'number', required: true }],
      },
      outputSchema: {
        fields: [
          { name: 'allowed', type: 'boolean' },
          { name: 'keyPrefix', type: 'string' },
          { name: 'remainingSlots', type: 'number' },
        ],
      },
    },
    async (ctx) => {
      const activeKeyCount = Number(ctx.config.activeKeyCount ?? 0);
      if (activeKeyCount >= 5) {
        throw new Error('KEY_LIMIT_REACHED: user already has 5 active keys');
      }
      const remainingSlots = 5 - activeKeyCount - 1;
      ctx.log('info', `Key ${String(ctx.input.keyPrefix)}… accepted (${remainingSlots} slots left)`);
      return { allowed: true, keyPrefix: ctx.input.keyPrefix, remainingSlots };
    },
  );
}
