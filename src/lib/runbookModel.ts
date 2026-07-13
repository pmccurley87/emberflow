import type { WorkflowDefinition, WorkflowEdge } from '../engine/types';
import { computeLoopRegions, topoSort, type LoopRegion } from '../engine/validation';
import type { NodeRegistry } from '../engine/registry';
import { firstSentence, simpleNodeDescription } from './registerLens';

export interface RunbookStep {
  kind: 'step';
  nodeId: string;
  number: string; // "3" or "3.2" or "3.2.1"
  depth: number; // 0 = root
  label: string; // node.label
  typeName: string; // node.type
  description: string; // registry definition.description first sentence, '' if unknown type
  simpleDescription: string; // definition.simpleDescription, else same as `description`
  traceKind?: 'db' | 'http' | 'llm' | 'compute'; // definition.traceKind, for the technical register badge
  mutation: boolean; // definition.effects === 'mutation'
  subflow: boolean; // node.type === 'Subflow'
  subflowId?: string; // config.workflowId when subflow
  decisionArms?: string[]; // outgoing sourceHandles when this node branches but arms are rendered as groups elsewhere
}

export interface RunbookBranchGroup {
  kind: 'branch';
  ownerId: string; // the branching node
  arm: string; // sourceHandle name
  number: string;
  depth: number;
  items: RunbookItem[];
}

export interface RunbookLoopGroup {
  kind: 'loop';
  forEachId: string;
  collectId: string;
  number: string;
  depth: number;
  items: RunbookItem[]; // body steps (Collect excluded; ForEach is the header)
  label: string; // ForEach node label
}

export type RunbookItem = RunbookStep | RunbookBranchGroup | RunbookLoopGroup;

export interface RunbookDoc {
  items: RunbookItem[];
  /** nodeId -> the (ownerId, arm) guards that gate it; used by projection for taken/dim state. */
  guards: Map<string, Array<{ ownerId: string; arm: string }>>;
  /** every (ownerId, arm) pair that exists in the flow, for coverage math. */
  arms: Array<{ ownerId: string; arm: string }>;
}

interface GuardEntry {
  ownerId: string;
  arm: string;
}

/**
 * Builds the guard set for every node in `nodeIds`, walking `order` (already
 * topologically valid for this subset) and intersecting incoming guard sets —
 * a node reached via two different arms of the same owner is a join and
 * carries neither arm (see executor.isReachable for the same branch-guard
 * semantics, mirrored here for grouping instead of execution).
 */
function buildGuardMap(
  nodeIds: Set<string>,
  order: string[],
  edges: WorkflowEdge[],
): Map<string, Set<string>> {
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e);
  }
  const guardMap = new Map<string, Set<string>>();
  for (const id of order) {
    const inc = incoming.get(id) ?? [];
    if (inc.length === 0) {
      guardMap.set(id, new Set());
      continue;
    }
    // Each edge contributes guardSet(source) ∪ {source::handle if branch
    // edge}. Edges that carry no gating information at all (no handle AND an
    // unguarded source, e.g. a data edge straight from "input") are excluded
    // from the intersection — they must not smuggle a node out of its branch.
    // But an unguarded-looking plain edge whose SOURCE inherited guards does
    // participate: a join fed by arm X directly and arm Y through a chain
    // intersects {X} ∩ {Y} = ∅ and correctly carries neither. If every edge
    // is information-free the guard set is ∅.
    let result: Set<string> | undefined;
    for (const e of inc) {
      const base = guardMap.get(e.source) ?? new Set<string>();
      if (!e.sourceHandle && base.size === 0) continue; // information-free
      const g = new Set(base);
      if (e.sourceHandle) g.add(`${e.source}::${e.sourceHandle}`);
      result = result === undefined ? g : new Set([...result].filter((x) => g.has(x)));
    }
    guardMap.set(id, result ?? new Set());
  }
  return guardMap;
}

function guardPath(id: string, guardMap: Map<string, Set<string>>, order: string[]): GuardEntry[] {
  const set = guardMap.get(id) ?? new Set<string>();
  const indexOf = (nodeId: string) => order.indexOf(nodeId);
  return [...set]
    .map((s): GuardEntry => {
      const idx = s.indexOf('::');
      return { ownerId: s.slice(0, idx), arm: s.slice(idx + 2) };
    })
    .sort((a, b) => indexOf(a.ownerId) - indexOf(b.ownerId));
}

function sameGuard(a: GuardEntry, b: GuardEntry): boolean {
  return a.ownerId === b.ownerId && a.arm === b.arm;
}

/** Distinct outgoing sourceHandles of `id`, in the order they first appear in flow.edges. */
function distinctArms(edges: WorkflowEdge[], id: string): string[] {
  const seen = new Set<string>();
  const arms: string[] = [];
  for (const e of edges) {
    if (e.source === id && e.sourceHandle && !seen.has(e.sourceHandle)) {
      seen.add(e.sourceHandle);
      arms.push(e.sourceHandle);
    }
  }
  return arms;
}

export function buildRunbook(flow: WorkflowDefinition, registry: NodeRegistry): RunbookDoc {
  const order = topoSort(flow);
  const regions = computeLoopRegions(flow);

  const bodyNodeIds = new Set<string>(regions.flatMap((r) => r.bodyIds));
  const collectIds = new Set<string>(regions.map((r) => r.collectId));
  const regionByForEach = new Map<string, LoopRegion>(regions.map((r) => [r.forEachId, r]));

  // ── root scope: everything except loop-body-internal nodes ──
  const extendedNodeIds = new Set<string>(flow.nodes.map((n) => n.id).filter((id) => !bodyNodeIds.has(id)));
  const syntheticEdges: WorkflowEdge[] = regions.map((r) => ({
    id: `synthetic-${r.forEachId}`,
    source: r.forEachId,
    target: r.collectId,
  }));
  const rootEdges: WorkflowEdge[] = [
    ...flow.edges.filter(
      (e) => extendedNodeIds.has(e.source) && extendedNodeIds.has(e.target) && !collectIds.has(e.target),
    ),
    ...syntheticEdges,
  ];
  const rootOrder = order.filter((id) => extendedNodeIds.has(id));
  const rootGuardMap = buildGuardMap(extendedNodeIds, rootOrder, rootEdges);
  const rootPool = order.filter((id) => !bodyNodeIds.has(id) && !collectIds.has(id));

  // ── per-region body scope: guards computed relative to the body's own node set ──
  const bodyScopes = new Map<
    string,
    { bodySet: Set<string>; bodyOrder: string[]; bodyGuardMap: Map<string, Set<string>> }
  >();
  for (const region of regions) {
    const bodySet = new Set(region.bodyIds);
    const bodyEdges = flow.edges.filter((e) => bodySet.has(e.source) && bodySet.has(e.target));
    const bodyOrder = order.filter((id) => bodySet.has(id));
    const bodyGuardMap = buildGuardMap(bodySet, bodyOrder, bodyEdges);
    bodyScopes.set(region.forEachId, { bodySet, bodyOrder, bodyGuardMap });
  }

  function buildStep(id: string): RunbookStep {
    const node = flow.nodes.find((n) => n.id === id)!;
    const registered = registry.has(node.type) ? registry.get(node.type) : undefined;
    const description = firstSentence(registered?.definition.description ?? '');
    const simpleDescription = simpleNodeDescription(registered?.definition);
    const mutation = registered?.definition.effects === 'mutation';
    const subflow = node.type === 'Subflow';
    const step: RunbookStep = {
      kind: 'step',
      nodeId: id,
      number: '',
      depth: 0,
      label: node.label,
      typeName: node.type,
      description,
      simpleDescription,
      mutation,
      subflow,
    };
    if (registered?.definition.traceKind) step.traceKind = registered.definition.traceKind;
    if (subflow) step.subflowId = node.config.workflowId as string;
    return step;
  }

  function buildLoopGroup(region: LoopRegion): RunbookLoopGroup {
    const scope = bodyScopes.get(region.forEachId)!;
    const items = buildLevel(scope.bodyOrder, [], scope.bodyGuardMap);
    const forEachNode = flow.nodes.find((n) => n.id === region.forEachId)!;
    return {
      kind: 'loop',
      forEachId: region.forEachId,
      collectId: region.collectId,
      number: '',
      depth: 0,
      items,
      label: forEachNode.label,
    };
  }

  /**
   * Builds the item list for one level of nesting. `pool` holds every node
   * id whose guard path (in `guardMap`) has `context` as a prefix — nodes
   * further nested are deferred to the recursive call triggered by their
   * governing branch owner, encountered later in this same loop.
   */
  function buildLevel(
    pool: string[],
    context: GuardEntry[],
    guardMap: Map<string, Set<string>>,
  ): RunbookItem[] {
    const items: RunbookItem[] = [];
    for (const id of pool) {
      const gp = guardPath(id, guardMap, order);
      if (gp.length !== context.length) continue; // belongs to a deeper level; handled via its owner below

      const region = regionByForEach.get(id);
      if (region) {
        items.push(buildLoopGroup(region));
        continue;
      }

      const step = buildStep(id);
      items.push(step);

      const arms = distinctArms(flow.edges, id);
      if (arms.length === 0) continue;

      const leftover: string[] = [];
      for (const arm of arms) {
        const entry: GuardEntry = { ownerId: id, arm };
        const childPool = pool.filter((pid) => {
          const pgp = guardPath(pid, guardMap, order);
          return pgp.length > context.length && sameGuard(pgp[context.length], entry);
        });
        if (childPool.length === 0) {
          leftover.push(arm);
          continue;
        }
        const childItems = buildLevel(childPool, [...context, entry], guardMap);
        items.push({ kind: 'branch', ownerId: id, arm, number: '', depth: 0, items: childItems });
      }
      if (leftover.length > 0) step.decisionArms = leftover;
    }
    return items;
  }

  const rootItems = buildLevel(rootPool, [], rootGuardMap);

  function numberItems(items: RunbookItem[], prefix: string, depth: number): void {
    items.forEach((item, i) => {
      const number = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      item.number = number;
      item.depth = depth;
      if (item.kind !== 'step') numberItems(item.items, number, depth + 1);
    });
  }
  numberItems(rootItems, '', 0);

  // ── guards: every node's full guard chain, for projection's taken/dim math ──
  const guards = new Map<string, Array<{ ownerId: string; arm: string }>>();
  for (const id of extendedNodeIds) {
    guards.set(id, guardPath(id, rootGuardMap, rootOrder));
  }
  for (const region of regions) {
    const scope = bodyScopes.get(region.forEachId)!;
    for (const id of region.bodyIds) {
      guards.set(id, guardPath(id, scope.bodyGuardMap, scope.bodyOrder));
    }
  }

  // ── arms: every (ownerId, arm) pair declared anywhere in the flow ──
  const armsSeen = new Set<string>();
  const arms: Array<{ ownerId: string; arm: string }> = [];
  for (const e of flow.edges) {
    if (!e.sourceHandle) continue;
    const key = `${e.source}::${e.sourceHandle}`;
    if (armsSeen.has(key)) continue;
    armsSeen.add(key);
    arms.push({ ownerId: e.source, arm: e.sourceHandle });
  }

  return { items: rootItems, guards, arms };
}
