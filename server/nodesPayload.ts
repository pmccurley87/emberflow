import { isAbsolute, relative, resolve } from 'node:path';
import type { NodeDefinition, NodeRegistry } from '../src/engine';

/**
 * Node metadata served to the studio over HTTP. Definitions carry everything
 * the UI needs (label, schemas, category, tags); `source` is the
 * implementation's toString() so the Inspector can show a node's code without
 * the browser bundling the implementation — the key to consumer nodes
 * appearing in the palette without a per-project browser build.
 *
 * `sourceRef` (repo-relative file + line of the register() call) is present
 * only when registration provenance was captured AND the file lives inside
 * the project root — the studio uses it to open the real source via
 * GET /source-file. A captured ref OUTSIDE the root (Emberflow's own
 * built-ins registered from the package) is flagged `builtin: true` instead:
 * those files are never served (node_modules exposure rule), so the
 * Inspector keeps the toString() view for them.
 */
export interface NodeMetaPayload {
  nodes: Array<
    NodeDefinition & {
      source?: string;
      sourceRef?: { file: string; line?: number };
      builtin?: boolean;
    }
  >;
}

export function nodesPayload(registry: NodeRegistry, projectRoot?: string): NodeMetaPayload {
  const root = resolve(projectRoot ?? process.cwd());
  return {
    nodes: registry.list().map((definition) => {
      let source: string | undefined;
      try {
        source = registry.get(definition.type).implementation.toString();
      } catch {
        source = undefined;
      }
      const ref = registry.getSourceRef(definition.type);
      if (!ref) return { ...definition, source };
      const rel = relative(root, resolve(root, ref.file));
      const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
      if (!inside) return { ...definition, source, builtin: true };
      return {
        ...definition,
        source,
        sourceRef: ref.line !== undefined ? { file: rel, line: ref.line } : { file: rel },
      };
    }),
  };
}
