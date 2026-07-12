import type { FieldDefinition, WorkflowDefinition, WorkflowEdge, WorkflowNode } from './types';
import type { NodeRegistry } from './registry';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

export interface LoopRegion {
  forEachId: string;
  collectId: string;
  /** Loop-body node ids: downstream(forEach) ∩ upstream(collect), excluding both. */
  bodyIds: string[];
}

export function topoSort(flow: WorkflowDefinition): string[] {
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const n of flow.nodes) {
    indegree.set(n.id, 0);
    adjacency.set(n.id, []);
  }
  for (const e of flow.edges) {
    if (!adjacency.has(e.source) || !indegree.has(e.target)) continue;
    adjacency.get(e.source)!.push(e.target);
    indegree.set(e.target, indegree.get(e.target)! + 1);
  }
  const queue = flow.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adjacency.get(id)!) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== flow.nodes.length) throw new Error('Flow contains a cycle');
  return order;
}

/** All nodes upstream of nodeId (direct parents and further ancestors). */
export function upstreamNodeIds(flow: WorkflowDefinition, nodeId: string): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const e of flow.edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e.source);
  }
  const seen = new Set<string>();
  const queue = [...(incoming.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(incoming.get(id) ?? []));
  }
  return seen;
}

/** All nodes downstream of nodeId (direct children and further descendants). */
export function downstreamNodeIds(flow: WorkflowDefinition, nodeId: string): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const e of flow.edges) {
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source)!.push(e.target);
  }
  const seen = new Set<string>();
  const queue = [...(outgoing.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(outgoing.get(id) ?? []));
  }
  return seen;
}

interface LoopPairing {
  forEachNode: WorkflowNode;
  collectNode: WorkflowNode;
  bodyIds: string[];
  leaks: WorkflowEdge[];
}

/**
 * Matches ForEach nodes to a single downstream Collect (and vice versa) and
 * computes each region's body + any edges that leak out of it. A ForEach/
 * Collect that doesn't pair 1:1 is simply omitted here — validateFlow raises
 * the specific "no Collect"/"multiple Collect"/etc. errors separately.
 */
function findLoopPairings(flow: WorkflowDefinition): LoopPairing[] {
  const forEachNodes = flow.nodes.filter((n) => n.type === 'ForEach');
  const collectNodes = flow.nodes.filter((n) => n.type === 'Collect');
  const pairings: LoopPairing[] = [];

  for (const forEachNode of forEachNodes) {
    const downstream = downstreamNodeIds(flow, forEachNode.id);
    const collectsDownstream = collectNodes.filter((c) => downstream.has(c.id));
    if (collectsDownstream.length !== 1) continue;
    const collectNode = collectsDownstream[0];

    const upstream = upstreamNodeIds(flow, collectNode.id);
    const forEachesUpstream = forEachNodes.filter((f) => upstream.has(f.id));
    if (forEachesUpstream.length !== 1 || forEachesUpstream[0].id !== forEachNode.id) continue;

    const bodyIds = [...downstream].filter(
      (id) => upstream.has(id) && id !== forEachNode.id && id !== collectNode.id,
    );
    const bodySet = new Set(bodyIds);
    const leaks = flow.edges.filter(
      (e) => bodySet.has(e.source) && !bodySet.has(e.target) && e.target !== collectNode.id,
    );
    pairings.push({ forEachNode, collectNode, bodyIds, leaks });
  }

  return pairings;
}

/**
 * ForEach node ids that sit downstream of another ForEach node — i.e. one
 * region wraps the other. Deliberately independent of findLoopPairings: a
 * genuinely nested pair almost always also fails the "exactly one Collect
 * descendant" check for the outer ForEach (its downstream includes both the
 * inner and outer Collect), which would otherwise prevent a pairing — and
 * therefore prevent detecting the nesting — from ever being computed.
 */
function nestedForEachIds(flow: WorkflowDefinition): Set<string> {
  const forEachNodes = flow.nodes.filter((n) => n.type === 'ForEach');
  const nested = new Set<string>();
  for (const outer of forEachNodes) {
    const downstream = downstreamNodeIds(flow, outer.id);
    for (const inner of forEachNodes) {
      if (outer === inner) continue;
      if (downstream.has(inner.id)) {
        nested.add(outer.id);
        nested.add(inner.id);
      }
    }
  }
  return nested;
}

/**
 * Computes ForEach/Collect loop regions for a flow. Only returns regions for
 * valid pairings (1:1 ForEach↔Collect, no leaking edges, not nested) — an
 * invalid flow fails validateFlow and startRun already throws before this
 * would be consulted.
 */
export function computeLoopRegions(flow: WorkflowDefinition): LoopRegion[] {
  const pairings = findLoopPairings(flow);
  const nested = nestedForEachIds(flow);
  return pairings
    .filter((p) => p.leaks.length === 0 && !nested.has(p.forEachNode.id))
    .map((p) => ({
      forEachId: p.forEachNode.id,
      collectId: p.collectNode.id,
      bodyIds: p.bodyIds,
    }));
}

export function validateFlow(flow: WorkflowDefinition, registry: NodeRegistry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set(flow.nodes.map((n) => n.id));

  for (const node of flow.nodes) {
    if (!registry.has(node.type)) {
      issues.push({ severity: 'error', nodeId: node.id, message: `Unknown node type: ${node.type}` });
    }
  }

  for (const edge of flow.edges) {
    for (const end of [edge.source, edge.target]) {
      if (!nodeIds.has(end)) {
        issues.push({ severity: 'error', message: `Edge ${edge.id} references missing node: ${end}` });
      }
    }
  }

  try {
    topoSort(flow);
  } catch {
    issues.push({ severity: 'error', message: 'Flow contains a cycle' });
  }

  const ancestorsOf = (nodeId: string): Set<string> => upstreamNodeIds(flow, nodeId);

  for (const node of flow.nodes) {
    for (const [field, mapping] of Object.entries(node.inputMap ?? {})) {
      if (!nodeIds.has(mapping.sourceNodeId)) {
        issues.push({
          severity: 'error', nodeId: node.id,
          message: `Input "${field}" maps to missing node: ${mapping.sourceNodeId}`,
        });
      } else if (!ancestorsOf(node.id).has(mapping.sourceNodeId)) {
        issues.push({
          severity: 'warning', nodeId: node.id,
          message: `Input "${field}" maps to ${mapping.sourceNodeId}, which is not upstream of this node`,
        });
      }
    }

    // A Subflow that names its own containing flow would recurse forever; the
    // runtime guard catches cross-flow cycles, but a direct self-call is a
    // static error.
    if (node.type === 'Subflow' && node.config.workflowId === flow.id) {
      issues.push({
        severity: 'error', nodeId: node.id,
        message: 'subflow cannot call its own flow',
      });
    }

    if (!registry.has(node.type)) continue;
    const definition = registry.get(node.type).definition;
    const inputSchema = definition.inputSchema;

    // Mutation nodes write observable state — warn so they can be reviewed
    // before running against a protected environment; safe mode dry-runs them.
    if (definition.effects === 'mutation') {
      issues.push({
        severity: 'warning',
        nodeId: node.id,
        message: `Mutation node "${node.label}" performs writes — dry-run under safe mode`,
      });
    }

    // Mappings to fields the node never declared are silently ignored by
    // implementations — surface them.
    const declared = new Set((inputSchema?.fields ?? []).map((f) => f.name));
    for (const field of Object.keys(node.inputMap ?? {})) {
      if (!declared.has(field)) {
        issues.push({
          severity: 'warning', nodeId: node.id,
          message: `Input "${field}" is mapped but not declared in ${node.type}'s input schema`,
        });
      }
    }

    for (const field of inputSchema?.fields ?? []) {
      if (!field.required) continue;
      const mapped = node.inputMap?.[field.name] !== undefined;
      const configured = node.config[field.name] !== undefined;
      if (!mapped && !configured) {
        issues.push({
          severity: 'warning', nodeId: node.id,
          message: `Required input "${field.name}" is not mapped or configured`,
        });
      }
    }
  }

  if (flow.scenarios && flow.scenarios.length > 0) {
    const inputNode = flow.nodes.find((n) => n.type === 'Input');
    if (!inputNode) {
      issues.push({
        severity: 'warning',
        message: 'Flow has scenarios but no Input node — scenario input is never consumed',
      });
    } else {
      const rawFields = inputNode.config?.fields;
      const fields: FieldDefinition[] = Array.isArray(rawFields)
        ? rawFields.filter(
            (f): f is FieldDefinition =>
              f !== null && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string',
          )
        : [];
      const rawDefaults = inputNode.config?.defaults;
      const defaults: Record<string, unknown> =
        rawDefaults !== null && typeof rawDefaults === 'object' && !Array.isArray(rawDefaults)
          ? (rawDefaults as Record<string, unknown>)
          : {};
      const declaredNames = new Set(fields.map((f) => f.name));

      for (const scenario of flow.scenarios) {
        for (const field of fields) {
          if (!field.required) continue;
          if (Object.prototype.hasOwnProperty.call(defaults, field.name)) continue;
          if (Object.prototype.hasOwnProperty.call(scenario.input, field.name)) continue;
          issues.push({
            severity: 'warning',
            nodeId: inputNode.id,
            message: `Scenario "${scenario.name}" omits required input field "${field.name}"`,
          });
        }
        for (const key of Object.keys(scenario.input)) {
          if (!declaredNames.has(key)) {
            issues.push({
              severity: 'warning',
              nodeId: inputNode.id,
              message: `Scenario "${scenario.name}" provides undeclared input field "${key}"`,
            });
          }
        }
      }
    }
  }

  // ── ForEach/Collect loop regions ──────────────────────────────────
  for (const n of flow.nodes) {
    if (n.type !== 'ForEach') continue;
    const downstream = downstreamNodeIds(flow, n.id);
    const collectsDownstream = flow.nodes.filter((c) => c.type === 'Collect' && downstream.has(c.id));
    if (collectsDownstream.length === 0) {
      issues.push({
        severity: 'error', nodeId: n.id,
        message: `ForEach "${n.id}" has no Collect node among its descendants`,
      });
    } else if (collectsDownstream.length > 1) {
      issues.push({
        severity: 'error', nodeId: n.id,
        message: `ForEach "${n.id}" has multiple Collect nodes among its descendants: ${collectsDownstream.map((c) => c.id).join(', ')}`,
      });
    }
  }

  for (const n of flow.nodes) {
    if (n.type !== 'Collect') continue;
    const upstream = upstreamNodeIds(flow, n.id);
    const forEachesUpstream = flow.nodes.filter((f) => f.type === 'ForEach' && upstream.has(f.id));
    if (forEachesUpstream.length === 0) {
      issues.push({
        severity: 'error', nodeId: n.id,
        message: `Collect "${n.id}" has no ForEach node among its ancestors`,
      });
    } else if (forEachesUpstream.length > 1) {
      issues.push({
        severity: 'error', nodeId: n.id,
        message: `Collect "${n.id}" has multiple ForEach nodes among its ancestors: ${forEachesUpstream.map((f) => f.id).join(', ')}`,
      });
    }
  }

  const pairings = findLoopPairings(flow);
  for (const p of pairings) {
    for (const edge of p.leaks) {
      issues.push({
        severity: 'error',
        nodeId: edge.source,
        message: `Edge "${edge.id}" leaves the ForEach/Collect region rooted at "${p.forEachNode.id}" without targeting the region or its Collect node "${p.collectNode.id}"`,
      });
    }
  }

  const nested = nestedForEachIds(flow);
  for (const forEachId of nested) {
    issues.push({
      severity: 'error',
      nodeId: forEachId,
      message: 'Nested ForEach regions are not supported',
    });
  }

  return issues;
}
