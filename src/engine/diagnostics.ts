import { parsePathParams } from '../lib/pathParams';
import type { ScenarioDefinition, WorkflowDefinition } from './types';

export interface OperationDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  nodeId?: string;
  param?: string;
}

function paramDefaultsOf(
  inputNode: WorkflowDefinition['nodes'][number],
): Record<string, unknown> | undefined {
  const defaults = inputNode.config?.defaults as Record<string, unknown> | undefined;
  const params =
    defaults && typeof defaults === 'object' && !Array.isArray(defaults)
      ? (defaults.params as Record<string, unknown> | undefined)
      : undefined;
  return params && typeof params === 'object' && !Array.isArray(params) ? params : undefined;
}

/** Registry-derived facts diagnoseOperation cannot compute on its own — it is
 *  a pure function over (flow, scenarios) and has no node-definition lookup.
 *  Callers that hold a registry (server/index.ts's diagnostics route, the
 *  `doctor` CLI, the studio's client-side registry) derive `infraNodes` by
 *  looking up each flow node's type and keeping the ones whose `traceKind` is
 *  'db' | 'http' | 'llm'. Callers without a registry (or without meta yet)
 *  omit `extras` entirely — `missing-node-mock` simply doesn't fire. */
export interface DiagnoseOperationExtras {
  infraNodes?: Array<{ id: string; traceKind: string }>;
  /** Op-level mocks to check coverage against, when the caller has a more
   *  authoritative source than `flow.mocks` (e.g. an in-progress edit not yet
   *  saved). Falls back to `flow.mocks` when omitted. */
  opMocks?: Record<string, unknown>;
  /** Declared output field names per flow-node id, for `inputmap-schema-mismatch`.
   *  Callers that hold a registry populate this ONLY for nodes whose type is
   *  registered AND whose outputSchema declares fields (an entry's presence is
   *  the "checkable" signal). Nodes absent from the map — unregistered types, or
   *  registered ones with an empty/absent outputSchema (Input, Subflow, …) — are
   *  never flagged, so dynamic-output nodes cannot false-positive. Omitted
   *  entirely → the diagnostic simply doesn't fire. */
  outputFieldsByNode?: Record<string, string[]>;
  /** Implementation source per flow-node id, for `simulated-commit`. Callers
   *  that hold a registry populate this ONLY for nodes whose type is
   *  registered AND whose registered `definition.effects === 'mutation'` AND
   *  whose implementation is a function (`String(implementation)`). A node
   *  absent from the map — unregistered type, non-mutation node, or a native/
   *  bound implementation whose source isn't meaningfully inspectable — is
   *  never flagged. Omitted entirely → the diagnostic simply doesn't fire. */
  mutationSourcesByNode?: Record<string, string>;
  /** Project-level signal for `language-drift`, NOT per-node. Pass this ONLY
   *  when the project config's `language:` field was EXPLICIT and disagrees
   *  with the config file's own extension (e.g. `language: 'javascript'` in
   *  an `emberflow.config.ts`) — inference makes language and extension agree
   *  by construction, so that's the only case worth flagging. Callers that
   *  hold a loaded ProjectConfig (server/index.ts's diagnostics route, the
   *  `doctor` CLI) plumb this from `ProjectConfig.languageDrift`. The studio
   *  doesn't currently have project-language access client-side, so it omits
   *  this and the diagnostic simply doesn't fire there. */
  languageDrift?: { projectLanguage: 'javascript' | 'typescript'; configPathExtension: string };
}

/** Diagnose an operation (a flow with an `http` trigger, plus its scenarios)
 *  for issues a studio user or the `emberflow doctor` CLI should surface
 *  before relying on the operation. Deterministic order: all
 *  `missing-param-default` (path order), then all `param-no-real-scenario`
 *  (path order), then `no-expects`, then `missing-node-mock` (extras order),
 *  then `inputmap-schema-mismatch` (node order), then `simulated-commit`
 *  (node order), then `language-drift` (at most one, project-level). */
export function diagnoseOperation(
  flow: WorkflowDefinition,
  scenarios: ScenarioDefinition[] | undefined,
  extras?: DiagnoseOperationExtras,
): OperationDiagnostic[] {
  const diagnostics: OperationDiagnostic[] = [];
  const scenarioList = scenarios ?? [];

  const path = flow.http?.path;
  const params = path ? parsePathParams(path) : [];
  // No Input node means nothing can map `params` into a node — there is
  // nothing to guard and nowhere to put a default, so skip entirely (mirrors
  // missingPathParams' guard semantics).
  const inputNode = params.length > 0 ? flow.nodes.find((n) => n.type === 'Input') : undefined;

  if (inputNode) {
    const paramDefaults = paramDefaultsOf(inputNode);

    for (const name of params) {
      const hasDefault = paramDefaults ? paramDefaults[name] !== undefined : false;
      if (!hasDefault) {
        diagnostics.push({
          severity: 'warning',
          code: 'missing-param-default',
          message: `Path param ":${name}" has no default — plain Run would reach nodes with params.${name} undefined. Add a value (even "") under the Input node's defaults.params, or run a scenario.`,
          nodeId: inputNode.id,
          param: name,
        });
      }
    }

    for (const name of params) {
      const suppliesRealValue = scenarioList.some((s) => {
        const scenarioParams = s.input?.params as Record<string, unknown> | undefined;
        const value = scenarioParams?.[name];
        return typeof value === 'string' ? value !== '' : value !== undefined;
      });
      if (!suppliesRealValue) {
        diagnostics.push({
          severity: 'info',
          code: 'param-no-real-scenario',
          message: `No scenario supplies a real value for path param ":${name}" — add a scenario with input.params.${name} set to exercise this path.`,
          nodeId: inputNode.id,
          param: name,
        });
      }
    }
  }

  const hasExpect = scenarioList.some((s) => s.expect !== undefined);
  if (!hasExpect) {
    diagnostics.push({
      severity: 'info',
      code: 'no-expects',
      message: 'This operation has no scenario with an expect — nothing verifies its behavior automatically. Add expect to at least one scenario.',
    });
  }

  const infraNodes = extras?.infraNodes ?? [];
  const opMocks = extras?.opMocks ?? flow.mocks ?? {};
  for (const { id, traceKind } of infraNodes) {
    if (Object.prototype.hasOwnProperty.call(opMocks, id)) continue;
    const node = flow.nodes.find((n) => n.id === id);
    diagnostics.push({
      severity: 'info',
      code: 'missing-node-mock',
      message: `"${node?.label ?? id}" touches infrastructure (${traceKind}) but has no mock — plain (no-scenario) Mock runs will fail at it. Cover with AI writes mocks, or add one under "mocks" in the scenarios file.`,
      nodeId: id,
    });
  }

  // inputmap-schema-mismatch: an inputMap entry reads a field the source node
  // never declares. Catches wiring that only breaks in a REAL run — a mocked
  // source node hides it, but the live node returns a differently-shaped output.
  // Only fires when the source node's type is registered AND its outputSchema
  // declares fields (present in extras.outputFieldsByNode).
  const outputFieldsByNode = extras?.outputFieldsByNode;
  if (outputFieldsByNode) {
    for (const node of flow.nodes) {
      if (!node.inputMap) continue;
      for (const [field, mapping] of Object.entries(node.inputMap)) {
        const declared = outputFieldsByNode[mapping.sourceNodeId];
        if (!declared) continue; // source unregistered or has no declared output fields
        // '$' means the whole output — nothing to check. Ignore a leading '$'.
        const raw = mapping.sourceField;
        if (raw === '$' || raw === '') continue;
        const firstSegment = raw.replace(/^\$\.?/, '').split('.')[0];
        if (firstSegment === '' || firstSegment === '$') continue;
        if (!declared.includes(firstSegment)) {
          diagnostics.push({
            severity: 'warning',
            code: 'inputmap-schema-mismatch',
            message: `"${node.label ?? node.id}".${field} reads "${raw}" from ${mapping.sourceNodeId}, but "${firstSegment}" is not a declared output field of that node (declares: ${declared.join(', ') || 'none'}). A real run may return undefined here even if a mock hides it.`,
            nodeId: node.id,
            param: field,
          });
        }
      }
    }
  }

  // simulated-commit: a mutation node whose implementation source still
  // contains the `[SIMULATED]` marker — the forbidden anti-pattern of a
  // commit branch that logs and returns success instead of performing (or
  // throwing on) the real side effect. Each flagged node instance gets its
  // own warning; a node type used twice is not deduped, since each instance
  // is an independent op-level risk. Only fires for nodes present in
  // extras.mutationSourcesByNode — see that field's doc comment for the
  // registered/mutation/function-source gating the caller performs.
  const mutationSourcesByNode = extras?.mutationSourcesByNode;
  if (mutationSourcesByNode) {
    for (const node of flow.nodes) {
      const source = mutationSourcesByNode[node.id];
      if (source === undefined || !source.includes('[SIMULATED]')) continue;
      diagnostics.push({
        severity: 'warning',
        code: 'simulated-commit',
        message: `mutation node "${node.id}" (${node.type}) has a simulated commit path — the commit branch must perform the real side effect or throw naming the missing secretRef`,
        nodeId: node.id,
      });
    }
  }

  // language-drift: the project's declared `language:` field disagrees with
  // its own config file's extension. Only fires when the caller passed
  // extras.languageDrift — which callers only do when the field was EXPLICIT
  // and contradicts the extension (see that field's doc comment); an
  // inferred language always agrees with the extension by construction, so
  // there's nothing to detect in that case.
  const languageDrift = extras?.languageDrift;
  if (languageDrift) {
    const { projectLanguage, configPathExtension } = languageDrift;
    diagnostics.push({
      severity: 'info',
      code: 'language-drift',
      message: `Project config declares language: "${projectLanguage}" but the config file itself is "${configPathExtension}" — align the "language" field with the config file's extension, or rename the file, so agents and tooling author in the right language.`,
    });
  }

  return diagnostics;
}
