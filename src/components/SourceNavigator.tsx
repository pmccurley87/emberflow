/**
 * Source-reference navigation for node implementations (spec:
 * docs/superpowers/specs/2026-07-14-source-reference-navigation.md).
 *
 * When a node carries a sourceRef, the Inspector's code dialog renders this
 * navigator instead of the plain toString() view: the whole registering file,
 * scrolled to the register() line, with identifiers that resolve to
 * project-owned files rendered as clickable links (custom
 * react-syntax-highlighter renderer). Clicking pushes the target file onto a
 * breadcrumb stack; a "Referenced code" panel below lists every import with a
 * badge — project (link) / external / builtin / unresolved (reason) — so no
 * referenced code is ever silently hidden.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ElementType, ReactNode } from 'react';
import { Prism as SyntaxHighlighter, createElement } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Badge } from '@/components/ui/badge';
import {
  fetchSourceFile,
  type Resolution,
  type SourceFileFetchResult,
  type SourceFilePayload,
  type SourceImport,
  type SourceReexport,
} from '../store/sourceNavClient';

// ---------------------------------------------------------------------------
// Shared highlighter chrome — identical to the Inspector's historical setup,
// so the sourceRef-less fallback view is pixel-for-pixel today's view.
// ---------------------------------------------------------------------------

const CODE_CUSTOM_STYLE: CSSProperties = {
  margin: 0,
  background: 'transparent',
  fontSize: '12.5px',
  lineHeight: 1.6,
  padding: '12px 2px',
};

const CODE_TAG_PROPS = { style: { background: 'transparent', textShadow: 'none' } as CSSProperties };

const LINE_NUMBER_STYLE: CSSProperties = {
  color: 'var(--muted-foreground)',
  opacity: 0.35,
  background: 'transparent',
  minWidth: '2.75em',
  paddingRight: '1em',
};

// ---------------------------------------------------------------------------
// Token linking: a custom renderer walks the highlighter's per-line rows and
// wraps whole-identifier text matches in link buttons.
// ---------------------------------------------------------------------------

/** Structural supertype of react-syntax-highlighter's (unexported) rendererNode. */
interface HastNode {
  type: 'element' | 'text';
  value?: string | number;
  tagName?: ElementType;
  properties?: { className: unknown[]; [key: string]: unknown };
  children?: HastNode[];
}

interface RendererArgs {
  rows: HastNode[];
  stylesheet: { [key: string]: CSSProperties };
  useInlineStyles: boolean;
}

/** What clicking an identifier does: open another file, or jump within this one. */
type LinkTarget = { kind: 'file'; path: string; line?: number } | { kind: 'line'; line: number };

const LINK_STYLE: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
  font: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
  textDecoration: 'underline',
  textDecorationStyle: 'dotted',
  textUnderlineOffset: '2px',
};

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** Split a text node into text pieces + link buttons for whole-identifier matches. */
function linkifyText(
  value: string,
  targets: Map<string, LinkTarget>,
  navigate: (target: LinkTarget) => void,
): HastNode[] {
  const out: HastNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(IDENTIFIER)) {
    const target = targets.get(match[0]);
    if (!target) continue;
    if (match.index > cursor) out.push({ type: 'text', value: value.slice(cursor, match.index) });
    out.push({
      type: 'element',
      tagName: 'button',
      properties: {
        className: ['source-nav-link'],
        type: 'button',
        style: LINK_STYLE,
        title:
          target.kind === 'file'
            ? `Open ${target.path}${target.line !== undefined ? `:${target.line}` : ''}`
            : `Jump to line ${target.line}`,
        onClick: () => navigate(target),
      },
      children: [{ type: 'text', value: match[0] }],
    });
    cursor = match.index + match[0].length;
  }
  if (out.length === 0) return [{ type: 'text', value }];
  if (cursor < value.length) out.push({ type: 'text', value: value.slice(cursor) });
  return out;
}

function isLineNumberNode(node: HastNode): boolean {
  const classes = node.properties?.className ?? [];
  return classes.some(
    (c) => c === 'linenumber' || c === 'react-syntax-highlighter-line-number',
  );
}

function linkifyNode(
  node: HastNode,
  targets: Map<string, LinkTarget>,
  navigate: (target: LinkTarget) => void,
): HastNode[] {
  if (node.type === 'text') {
    return linkifyText(String(node.value ?? ''), targets, navigate);
  }
  if (isLineNumberNode(node)) return [node];
  return [
    {
      ...node,
      children: (node.children ?? []).flatMap((child) => linkifyNode(child, targets, navigate)),
    },
  ];
}

/** DOM id for a 1-based line within one navigator instance (auto-scroll anchor). */
function lineId(uid: string, line: number): string {
  return `${uid}-L${line}`;
}

// ---------------------------------------------------------------------------
// Referenced-code panel
// ---------------------------------------------------------------------------

function ResolutionRow({
  label,
  from,
  resolution,
  onOpen,
}: {
  label: string;
  from: string;
  resolution: Resolution;
  onOpen: (path: string, line?: number) => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2 py-1 text-[12px]">
      {resolution.kind === 'project' && (
        <>
          <Badge variant="highlight">project</Badge>
          <span className="font-mono">{label}</span>
          <button
            type="button"
            className="font-mono text-highlight underline decoration-dotted underline-offset-2 hover:decoration-solid"
            onClick={() => onOpen(resolution.path, resolution.line)}
          >
            {resolution.path}
            {resolution.line !== undefined ? `:${resolution.line}` : ''}
          </button>
        </>
      )}
      {resolution.kind === 'external' && (
        <>
          <Badge variant="outline">external</Badge>
          <span className="font-mono text-muted-foreground">{label}</span>
          <span className="text-muted-foreground">package: {resolution.package}</span>
        </>
      )}
      {resolution.kind === 'builtin' && (
        <>
          <Badge variant="outline">builtin</Badge>
          <span className="font-mono text-muted-foreground">{label}</span>
          <span className="text-muted-foreground">Node.js builtin</span>
        </>
      )}
      {resolution.kind === 'unresolved' && (
        <>
          <Badge variant="destructive">unresolved</Badge>
          <span className="font-mono">{label}</span>
          <span className="text-destructive-foreground">unresolved — {resolution.reason}</span>
        </>
      )}
      <span className="ml-auto font-mono text-[11px] text-muted-foreground/70">{from}</span>
    </li>
  );
}

/** Display label for an import row; side-effect imports have no local binding. */
function importLabel(entry: SourceImport): string {
  if (entry.local) return entry.local;
  if (entry.name === '*') return '(side-effect import)';
  return entry.name;
}

function ReferencedCodePanel({
  imports,
  reexports,
  onOpen,
}: {
  imports: SourceImport[];
  reexports: SourceReexport[];
  onOpen: (path: string, line?: number) => void;
}) {
  if (imports.length === 0 && reexports.length === 0) return null;
  return (
    <div className="mt-2 rounded-md border border-border bg-background p-3">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Referenced code
      </div>
      <ul className="divide-y divide-border/50">
        {imports.map((entry, i) => (
          <ResolutionRow
            key={`import-${i}`}
            label={importLabel(entry)}
            from={entry.from}
            resolution={entry.resolution}
            onOpen={onOpen}
          />
        ))}
        {reexports.map((entry, i) => (
          <ResolutionRow
            key={`reexport-${i}`}
            label={`export ${entry.name}`}
            from={entry.from}
            resolution={entry.resolution}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SourceNavigator
// ---------------------------------------------------------------------------

interface Crumb {
  path: string;
  line?: number;
}

export interface SourceNavigatorProps {
  /** Repo-relative path of the node's registering module. */
  entryFile: string;
  /** 1-based line of the register() call, when captured. */
  entryLine?: number;
  /** The node type being inspected (context for headers/errors). */
  nodeType: string;
  /** Test seam: overrides the /source-file client. */
  fetcher?: (path: string) => Promise<SourceFileFetchResult>;
  /** Test seam: start at a deeper breadcrumb stack. */
  initialStack?: Crumb[];
  /** Test seam: pre-populate the per-file fetch cache (path → result). */
  initialFiles?: Record<string, SourceFileFetchResult>;
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function SourceNavigator({
  entryFile,
  entryLine,
  nodeType,
  fetcher = fetchSourceFile,
  initialStack,
  initialFiles,
}: SourceNavigatorProps) {
  const uid = useId();
  const [stack, setStack] = useState<Crumb[]>(
    () => initialStack ?? [{ path: entryFile, line: entryLine }],
  );
  // Per-file fetch cache: repeated and circular visits hit the cache — safe by
  // construction (flat per-file views, navigation is just a stack push).
  const [files, setFiles] = useState<Record<string, SourceFileFetchResult>>(
    () => initialFiles ?? {},
  );
  const containerRef = useRef<HTMLDivElement>(null);

  const current = stack[stack.length - 1];
  const result = files[current.path];

  useEffect(() => {
    if (files[current.path]) return;
    let cancelled = false;
    void fetcher(current.path).then((res) => {
      if (!cancelled) setFiles((prev) => ({ ...prev, [current.path]: res }));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.path, files[current.path] !== undefined]);

  // Auto-scroll to the crumb's line once its content is on screen.
  useEffect(() => {
    if (!result?.ok) return;
    if (current.line === undefined) {
      containerRef.current?.scrollTo?.({ top: 0 });
      return;
    }
    scrollToLine(current.line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.path, current.line, result?.ok === true, stack.length]);

  function scrollToLine(line: number) {
    const el = containerRef.current?.querySelector?.(`[id="${lineId(uid, line)}"]`);
    if (el && 'scrollIntoView' in el) (el as HTMLElement).scrollIntoView({ block: 'center' });
  }

  function push(path: string, line?: number) {
    if (path === current.path && line !== undefined) {
      // Same-file navigation is a scroll, not a crumb.
      scrollToLine(line);
      return;
    }
    setStack((prev) => [...prev, { path, line }]);
  }

  function jumpTo(depth: number) {
    setStack((prev) => prev.slice(0, depth + 1));
  }

  function back() {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }

  const payload: SourceFilePayload | undefined = result?.ok ? result.payload : undefined;

  // Identifier → action map for the current file: project-resolved import
  // locals open the target file; local declarations scroll within this one.
  const targets = new Map<string, LinkTarget>();
  if (payload) {
    for (const decl of payload.symbols.declarations) {
      targets.set(decl.name, { kind: 'line', line: decl.line });
    }
    for (const entry of payload.symbols.imports) {
      if (entry.local && entry.resolution.kind === 'project') {
        targets.set(entry.local, {
          kind: 'file',
          path: entry.resolution.path,
          line: entry.resolution.line,
        });
      }
    }
  }

  const navigate = (target: LinkTarget) => {
    if (target.kind === 'file') push(target.path, target.line);
    else scrollToLine(target.line);
  };

  const renderer = ({ rows, stylesheet, useInlineStyles }: RendererArgs): ReactNode =>
    rows.map((row, i) => {
      const transformed: HastNode = {
        ...row,
        properties: { ...(row.properties ?? { className: [] }), id: lineId(uid, i + 1) },
        children: (row.children ?? []).flatMap((child) => linkifyNode(child, targets, navigate)),
      };
      return createElement({
        node: transformed as Parameters<typeof createElement>[0]['node'],
        stylesheet,
        useInlineStyles,
        key: `source-row-${i}`,
      });
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-node-type={nodeType}>
      <style>{`.source-nav-link:hover { color: var(--highlight) !important; text-decoration-style: solid !important; }`}</style>

      {/* Breadcrumb header */}
      <div className="mb-2 flex items-center gap-1.5 text-[12px]">
        {stack.length > 1 && (
          <button
            type="button"
            className="mr-1 rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={back}
          >
            ← Back
          </button>
        )}
        {stack.map((crumb, depth) => {
          const last = depth === stack.length - 1;
          return (
            <span key={`${crumb.path}-${depth}`} className="flex items-center gap-1.5">
              {depth > 0 && <span className="text-muted-foreground/60">›</span>}
              {last ? (
                <span className="font-mono font-semibold" title={crumb.path}>
                  {basename(crumb.path)}
                </span>
              ) : (
                <button
                  type="button"
                  className="font-mono text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-highlight"
                  title={crumb.path}
                  onClick={() => jumpTo(depth)}
                >
                  {basename(crumb.path)}
                </button>
              )}
            </span>
          );
        })}
      </div>

      {payload?.resolver === 'unavailable' && (
        <div className="mb-2 rounded-md border border-border bg-tertiary px-3 py-2 text-[12px] text-muted-foreground">
          Symbol resolution unavailable (typescript not installed) — references below may be
          incomplete
        </div>
      )}

      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-background"
      >
        {result === undefined && (
          <div className="p-4 text-[13px] text-muted-foreground">Loading source…</div>
        )}
        {result !== undefined && !result.ok && (
          <div className="p-4 text-[13px] text-destructive-foreground">{result.error}</div>
        )}
        {payload && (
          <SyntaxHighlighter
            language={payload.language === 'ts' ? 'typescript' : 'javascript'}
            style={vscDarkPlus}
            showLineNumbers
            customStyle={CODE_CUSTOM_STYLE}
            codeTagProps={CODE_TAG_PROPS}
            lineNumberStyle={LINE_NUMBER_STYLE}
            renderer={renderer}
          >
            {payload.content}
          </SyntaxHighlighter>
        )}
      </div>

      {payload && (
        <ReferencedCodePanel
          imports={payload.symbols.imports}
          reexports={payload.symbols.reexports}
          onOpen={(path, line) => push(path, line)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NodeCodeView — the Inspector code dialog's body. sourceRef → navigator;
// builtin → today's view plus a quiet badge; neither → EXACTLY today's view.
// ---------------------------------------------------------------------------

export interface NodeCodeViewProps {
  nodeType: string;
  /** toString()/stored source — the fallback when no sourceRef exists. */
  source: string;
  sourceRef?: { file: string; line?: number };
  builtin?: boolean;
  /** Test seam, forwarded to SourceNavigator. */
  fetcher?: (path: string) => Promise<SourceFileFetchResult>;
}

export function NodeCodeView({ nodeType, source, sourceRef, builtin, fetcher }: NodeCodeViewProps) {
  if (sourceRef) {
    return (
      <SourceNavigator
        entryFile={sourceRef.file}
        entryLine={sourceRef.line}
        nodeType={nodeType}
        fetcher={fetcher}
      />
    );
  }
  return (
    <>
      {builtin && (
        <div className="mb-1">
          <Badge variant="outline">Built-in node</Badge>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-background">
        <SyntaxHighlighter
          language="javascript"
          style={vscDarkPlus}
          showLineNumbers
          customStyle={CODE_CUSTOM_STYLE}
          codeTagProps={CODE_TAG_PROPS}
          lineNumberStyle={LINE_NUMBER_STYLE}
        >
          {source}
        </SyntaxHighlighter>
      </div>
    </>
  );
}
