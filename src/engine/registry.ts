import type { NodeDefinition, NodeImplementation } from './types';

export interface RegisteredNode {
  definition: NodeDefinition;
  implementation: NodeImplementation;
}

/** Where a node was registered from: absolute file path + 1-based line of the register() call. */
export interface SourceRef {
  file: string;
  line?: number;
}

export interface RegisterOptions {
  /** Explicit provenance escape hatch — wins over automatic capture. */
  sourceRef?: SourceRef;
}

/**
 * V8 stack-frame shape (structural — this module must stay browser-safe, so
 * no @types/node CallSite import).
 */
interface V8CallSite {
  getFileName?: () => string | null | undefined;
  getLineNumber?: () => number | null | undefined;
}

/**
 * Read the CALLER's file:line via a one-frame V8 stack capture.
 * `Error.prepareStackTrace` is swapped for the duration of a single `new
 * Error()` and restored in `finally`, so source-map hooks installed by
 * tsx/vitest are back in place immediately. Frames arrive either as
 * `file:///abs/path.ts` URLs (ESM) or plain absolute paths (CJS/transpilers);
 * both normalize to a plain path. Returns undefined on any non-V8 runtime or
 * anonymous/eval frames — capture is best-effort by design.
 */
function captureCallerSourceRef(skip: (...args: never[]) => unknown): SourceRef | undefined {
  if (typeof Error.captureStackTrace !== 'function') return undefined;
  const original = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_err, frames) => frames;
    const holder: { stack?: unknown } = {};
    Error.captureStackTrace(holder as Error, skip);
    const frames = holder.stack;
    if (!Array.isArray(frames) || frames.length === 0) return undefined;
    const frame = frames[0] as V8CallSite;
    const raw = typeof frame.getFileName === 'function' ? frame.getFileName() : undefined;
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    const lineRaw = typeof frame.getLineNumber === 'function' ? frame.getLineNumber() : undefined;
    const line = typeof lineRaw === 'number' && lineRaw > 0 ? lineRaw : undefined;
    let file = raw;
    if (file.startsWith('file://')) {
      // No node:url here (browser-safe module): URL parsing covers the
      // file:///abs/path form these frames take on POSIX platforms.
      try {
        file = decodeURIComponent(new URL(file).pathname);
      } catch {
        return undefined;
      }
    }
    // Loaders (vite-node hot imports) may suffix ?t=... cache-busters.
    const q = file.indexOf('?');
    if (q !== -1) file = file.slice(0, q);
    return line !== undefined ? { file, line } : { file };
  } catch {
    return undefined;
  } finally {
    Error.prepareStackTrace = original;
  }
}

export class NodeRegistry {
  nodes = new Map<string, RegisteredNode>();
  sources = new Map<string, string>();
  /** Registration provenance per node type. Populated only when capture is on or opts.sourceRef given. */
  sourceRefs = new Map<string, SourceRef>();
  /** Types the RUNNER flagged builtin (registered from the package, not the project). */
  builtinTypes = new Set<string>();
  /** Automatic caller capture is opt-in (server registries only) so browser registries never pay/leak. */
  private captureSourceRefs: boolean;

  constructor(opts?: { captureSourceRefs?: boolean }) {
    this.captureSourceRefs = opts?.captureSourceRefs ?? false;
  }

  register(definition: NodeDefinition, implementation: NodeImplementation, opts?: RegisterOptions): void {
    if (this.nodes.has(definition.type)) {
      throw new Error(`Node type already registered: ${definition.type}`);
    }
    this.nodes.set(definition.type, { definition, implementation });
    const ref =
      opts?.sourceRef ??
      (this.captureSourceRefs ? captureCallerSourceRef(this.register) : undefined);
    if (ref) this.sourceRefs.set(definition.type, ref);
  }

  /** Where `type` was registered from, when known. */
  getSourceRef(type: string): SourceRef | undefined {
    return this.sourceRefs.get(type);
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
    this.sourceRefs = other.sourceRefs;
    this.builtinTypes = other.builtinTypes;
  }

  /** Whether the runner flagged `type` as a package built-in (no servable source file). */
  isBuiltin(type: string): boolean {
    return this.builtinTypes.has(type);
  }

  list(): NodeDefinition[] {
    return [...this.nodes.values()].map((n) => n.definition);
  }

  /**
   * Register a definition-only node (metadata fetched from the runner). Its
   * implementation is a stub that fails loudly if browser-executed — such
   * nodes run on the server. Never overwrites a real registration.
   */
  registerDefinition(
    definition: NodeDefinition,
    source?: string,
    opts?: { sourceRef?: SourceRef; builtin?: boolean },
  ): void {
    // Provenance is recorded even for already-registered types: the studio's
    // bundled built-ins are real registrations, and the runner's builtin flag
    // (or a project sourceRef shadowing one) must still land on them.
    if (opts?.sourceRef) this.sourceRefs.set(definition.type, opts.sourceRef);
    if (opts?.builtin) this.builtinTypes.add(definition.type);
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
    next.sourceRefs = this.sourceRefs;
    next.builtinTypes = this.builtinTypes;
    return next;
  }
}
