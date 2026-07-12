import type { NodeDefinition } from '../engine';

/** A runner node definition plus its implementation source (for display). */
export type NodeMeta = NodeDefinition & { source?: string };

/**
 * Fetch the runner's node metadata (GET /api/nodes, same-origin via the
 * studio proxy). Returns [] on any failure — the studio still has its
 * bundled built-in nodes; consumer nodes simply won't appear until the
 * runner is reachable.
 */
export async function fetchNodeMeta(): Promise<NodeMeta[]> {
  try {
    const res = await fetch('/api/nodes');
    if (!res.ok) return [];
    const body = (await res.json()) as { nodes?: NodeMeta[] };
    return Array.isArray(body.nodes) ? body.nodes : [];
  } catch {
    return [];
  }
}
