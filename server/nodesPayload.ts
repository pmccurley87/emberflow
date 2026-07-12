import type { NodeDefinition, NodeRegistry } from '../src/engine';

/**
 * Node metadata served to the studio over HTTP. Definitions carry everything
 * the UI needs (label, schemas, category, tags); `source` is the
 * implementation's toString() so the Inspector can show a node's code without
 * the browser bundling the implementation — the key to consumer nodes
 * appearing in the palette without a per-project browser build.
 */
export interface NodeMetaPayload {
  nodes: Array<NodeDefinition & { source?: string }>;
}

export function nodesPayload(registry: NodeRegistry): NodeMetaPayload {
  return {
    nodes: registry.list().map((definition) => {
      let source: string | undefined;
      try {
        source = registry.get(definition.type).implementation.toString();
      } catch {
        source = undefined;
      }
      return { ...definition, source };
    }),
  };
}
