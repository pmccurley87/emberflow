import type { NodeDefinition, NodeImplementation } from './types';

export interface RegisteredNode {
  definition: NodeDefinition;
  implementation: NodeImplementation;
}

export class NodeRegistry {
  nodes = new Map<string, RegisteredNode>();
  sources = new Map<string, string>();

  register(definition: NodeDefinition, implementation: NodeImplementation): void {
    if (this.nodes.has(definition.type)) {
      throw new Error(`Node type already registered: ${definition.type}`);
    }
    this.nodes.set(definition.type, { definition, implementation });
  }

  get(type: string): RegisteredNode {
    const node = this.nodes.get(type);
    if (!node) throw new Error(`Unknown node type: ${type}`);
    return node;
  }

  has(type: string): boolean {
    return this.nodes.has(type);
  }

  /**
   * Replace this registry's contents with another's, in place. Keeps this
   * object's identity, so references held elsewhere (RunRegistry's execution
   * registry, request-handler closures) immediately see the new node set. Used
   * by the project-config hot-reload to pick up agent-authored nodes without a
   * process restart (which would kill in-flight agent runs).
   */
  adopt(other: NodeRegistry): void {
    this.nodes = other.nodes;
    this.sources = other.sources;
  }

  list(): NodeDefinition[] {
    return [...this.nodes.values()].map((n) => n.definition);
  }

  /**
   * Register a definition-only node (metadata fetched from the runner). Its
   * implementation is a stub that fails loudly if browser-executed — such
   * nodes run on the server. Never overwrites a real registration.
   */
  registerDefinition(definition: NodeDefinition, source?: string): void {
    if (this.nodes.has(definition.type)) return;
    this.nodes.set(definition.type, {
      definition,
      implementation: async () => {
        throw new Error(
          `${definition.type} runs on the server — start the runner or switch execution to Server mode`,
        );
      },
    });
    if (source !== undefined) this.sources.set(definition.type, source);
  }

  /** Source text for display: stored source for definition-only nodes, else the impl's toString(). */
  getSource(type: string): string | undefined {
    if (this.sources.has(type)) return this.sources.get(type);
    const node = this.nodes.get(type);
    return node ? node.implementation.toString() : undefined;
  }

  /**
   * A fresh registry instance sharing this one's node + source maps — a new
   * top-level reference (so store subscribers re-render) without copying node data.
   */
  withSameNodes(): NodeRegistry {
    const next = new NodeRegistry();
    next.nodes = this.nodes;
    next.sources = this.sources;
    return next;
  }
}
