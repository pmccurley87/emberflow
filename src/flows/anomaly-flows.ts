import type { FieldMapping, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '../engine';

const FOLDER = 'Anomaly API';
const CREATED = '2026-07-02T00:00:00Z';

interface NodeSpec {
  id: string;
  type: string;
  label: string;
  config?: Record<string, unknown>;
  inputMap?: Record<string, FieldMapping>;
  position?: { x: number; y: number };
}

function makeFlow(
  id: string,
  name: string,
  specs: NodeSpec[],
  edges: WorkflowEdge[],
  scenarios?: WorkflowDefinition['scenarios'],
): WorkflowDefinition {
  const nodes: WorkflowNode[] = specs.map((spec, i) => ({
    id: spec.id,
    type: spec.type,
    label: spec.label,
    position: spec.position ?? { x: 60 + 250 * i, y: 200 },
    config: spec.config ?? {},
    inputMap: spec.inputMap,
  }));
  return {
    id,
    name,
    version: 1,
    folder: FOLDER,
    nodes,
    edges,
    ...(scenarios ? { scenarios } : {}),
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

const from = (sourceNodeId: string, sourceField: string): FieldMapping => ({ sourceNodeId, sourceField });

/**
 * Live call: whole-series detection, then branch on severity.
 *   build → detect → summarize → cond(anomalyCount > 0?)
 *     ├─ anomalous → composeIncident → incidentResult
 *     └─ clean     → cleanResult
 *
 * Deviation from spec: the spec's Conditional has two rules (`gt 3 → P1`,
 * `gt 0 → P2`) feeding three downstream paths, but this flow only ever had
 * two downstream branches (anomalous/clean). Kept the original two-branch
 * shape as a single rule `gt 0 → anomalous`, fallback `clean`, rather than
 * inventing a third P1/P2 branch nothing here consumes.
 */
export function createDetectEntireFlow(): WorkflowDefinition {
  return makeFlow(
    'anomaly-detect-entire',
    'Detect · Entire Series',
    [
      { id: 'input', type: 'Input', label: 'Series Request', config: { fields: [{ name: 'points', type: 'number', required: true }, { name: 'spikeIndex', type: 'number' }], defaults: { points: 24, spikeIndex: 20 } }, position: { x: -180, y: 240 } },
      { id: 'build', type: 'BuildSeries', label: 'Build Series', config: { points: 24, baseValue: 100, spikeIndex: 20, spikeFactor: 3 }, inputMap: { points: from('input', 'points'), spikeIndex: from('input', 'spikeIndex') }, position: { x: 60, y: 240 } },
      { id: 'detect', type: 'DetectEntireSeries', label: 'Detect Entire Series', config: { apiKey: 'dev-emberflow', sensitivity: 80 }, inputMap: { series: from('build', 'series') }, position: { x: 300, y: 240 } },
      { id: 'summarize', type: 'SummarizeAnomalies', label: 'Summarize Anomalies', inputMap: { isAnomaly: from('detect', 'isAnomaly'), series: from('build', 'series') }, position: { x: 540, y: 240 } },
      { id: 'cond', type: 'Conditional', label: 'Severity?', config: { branches: [{ name: 'anomalous', op: 'gt', value: 0 }], fallback: 'clean' }, inputMap: { value: from('summarize', 'anomalyCount') }, position: { x: 1020, y: 240 } },
      { id: 'composeIncident', type: 'ComposeIncident', label: 'Compose Incident', inputMap: { headline: from('summarize', 'headline'), anomalyCount: from('summarize', 'anomalyCount') }, position: { x: 1260, y: 120 } },
      { id: 'incidentResult', type: 'Result', label: 'Incident', inputMap: { data: from('composeIncident', '$') }, position: { x: 1500, y: 120 } },
      { id: 'cleanResult', type: 'Result', label: 'All Clear', inputMap: { data: from('summarize', '$') }, position: { x: 1260, y: 360 } },
    ],
    [
      { id: 'e0', source: 'input', target: 'build', targetHandle: 'points' },
      { id: 'e1', source: 'build', target: 'detect', targetHandle: 'series' },
      { id: 'e2', source: 'detect', target: 'summarize', targetHandle: 'isAnomaly' },
      { id: 'e3', source: 'build', target: 'summarize', targetHandle: 'series' },
      { id: 'e4', source: 'summarize', target: 'cond', targetHandle: 'value' },
      { id: 'e6', source: 'cond', target: 'composeIncident', sourceHandle: 'anomalous' },
      { id: 'e7', source: 'cond', target: 'cleanResult', sourceHandle: 'clean' },
      { id: 'e8', source: 'composeIncident', target: 'incidentResult', targetHandle: 'data' },
    ],
    [
      {
        id: 'scn-spike',
        name: 'spike at 20',
        description: '×3 spike — detector flags it, incident branch fires',
        input: { points: 24, spikeIndex: 20 },
      },
      {
        id: 'scn-flat',
        name: 'flat series',
        description: 'no spike (spikeIndex −1) — clean branch, all clear',
        input: { points: 24, spikeIndex: -1 },
      },
    ],
  );
}

/** Live call: streaming-style last-point verdict. */
export function createDetectLastFlow(): WorkflowDefinition {
  return makeFlow(
    'anomaly-detect-last',
    'Detect · Last Point',
    [
      { id: 'build', type: 'BuildSeries', label: 'Build Series (spike at end)', config: { points: 14, baseValue: 50, spikeIndex: 13, spikeFactor: 4 } },
      { id: 'detect', type: 'DetectLastPoint', label: 'Detect Last Point', config: { apiKey: 'dev-emberflow', sensitivity: 80 }, inputMap: { series: from('build', 'series') } },
      { id: 'result', type: 'Result', label: 'Verdict', inputMap: { data: from('detect', '$') } },
    ],
    [
      { id: 'e1', source: 'build', target: 'detect', targetHandle: 'series' },
      { id: 'e2', source: 'detect', target: 'result', targetHandle: 'data' },
    ],
  );
}

/** Live call: detection + Adtributor root-cause analysis. */
export function createRootCauseFlow(): WorkflowDefinition {
  return makeFlow(
    'anomaly-root-cause',
    'Detect · Root Cause',
    [
      { id: 'build', type: 'BuildDimensionalSeries', label: 'Build Dimensional Series', config: { points: 14, baseValue: 100, spikeIndex: 12, culpritSlice: 'paid' } },
      { id: 'detect', type: 'DetectAttributed', label: 'Detect + Attribute', config: { apiKey: 'dev-emberflow', sensitivity: 80, topK: 3 }, inputMap: { series: from('build', 'series') } },
      { id: 'extract', type: 'ExtractRootCause', label: 'Extract Root Cause', inputMap: { rca: from('detect', 'rca') } },
      { id: 'result', type: 'Result', label: 'Root Cause', inputMap: { data: from('extract', '$') } },
    ],
    [
      { id: 'e1', source: 'build', target: 'detect', targetHandle: 'series' },
      { id: 'e2', source: 'detect', target: 'extract', targetHandle: 'rca' },
      { id: 'e3', source: 'extract', target: 'result', targetHandle: 'data' },
    ],
  );
}

/** Replica of today's quota/email business logic (Clerk-gated server-side). */
export function createQuotaFlow(): WorkflowDefinition {
  return makeFlow(
    'anomaly-quota-emails',
    'Quota · Usage & Emails',
    [
      { id: 'input', type: 'Input', label: 'Usage Snapshot', config: { fields: [{ name: 'calls', type: 'number', required: true }], defaults: { calls: 850 } } },
      { id: 'plan', type: 'PlanCatalog', label: 'Plan Catalog', config: { planCode: 'anomaly_free' } },
      { id: 'usage', type: 'UsageState', label: 'Usage State', config: { calls: 850 }, inputMap: { calls: from('input', 'calls'), quota: from('plan', 'quota') } },
      { id: 'classify', type: 'ClassifyQuotaEmail', label: 'Classify Quota Email', config: { alreadyWarned: false, alreadyNotifiedExceeded: false }, inputMap: { warn80: from('usage', 'warn80'), overQuota: from('usage', 'overQuota') } },
      { id: 'result', type: 'Result', label: 'Sweep Decision', inputMap: { data: from('classify', '$') } },
    ],
    [
      { id: 'e0', source: 'input', target: 'usage', targetHandle: 'calls' },
      { id: 'e1', source: 'plan', target: 'usage', targetHandle: 'quota' },
      { id: 'e2', source: 'usage', target: 'classify', targetHandle: 'warn80' },
      { id: 'e3', source: 'classify', target: 'result', targetHandle: 'data' },
    ],
    // Free plan quota is 1,000 calls: the three scenarios straddle the
    // warn-at-80% and exceeded thresholds in classifyUsageRow().
    [
      {
        id: 'scn-quiet',
        name: 'quiet month',
        description: '400/1000 calls — no email',
        input: { calls: 400 },
      },
      {
        id: 'scn-warn',
        name: 'approaching limit',
        description: '850/1000 calls — 80% warning email',
        input: { calls: 850 },
      },
      {
        id: 'scn-over',
        name: 'over quota',
        description: '1200/1000 calls — exceeded email',
        input: { calls: 1200 },
      },
    ],
  );
}

/** Replica of today's key issuance + 5-key limit guard. */
export function createKeyLifecycleFlow(): WorkflowDefinition {
  return makeFlow(
    'anomaly-key-lifecycle',
    'Keys · Issue & Limit',
    [
      { id: 'generate', type: 'GenerateApiKey', label: 'Generate API Key', config: { label: 'production' } },
      { id: 'enforce', type: 'EnforceKeyLimit', label: 'Enforce Key Limit', config: { activeKeyCount: 3 }, inputMap: { keyPrefix: from('generate', 'keyPrefix') } },
      { id: 'result', type: 'Result', label: 'Issued Key', inputMap: { data: from('enforce', '$') } },
    ],
    [
      { id: 'e1', source: 'generate', target: 'enforce', targetHandle: 'keyPrefix' },
      { id: 'e2', source: 'enforce', target: 'result', targetHandle: 'data' },
    ],
  );
}

export function createAnomalyFlows(): WorkflowDefinition[] {
  return [
    createDetectEntireFlow(),
    createDetectLastFlow(),
    createRootCauseFlow(),
    createQuotaFlow(),
    createKeyLifecycleFlow(),
  ];
}
