import { useEffect, useState } from 'react';
import { ChevronRightIcon, CodeIcon, PinIcon, PlayIcon } from 'lucide-react';
import { BranchRulesEditor } from './BranchRulesEditor';
import { ExecutionPager } from './ExecutionPager';
import { NodeRunModal } from './NodeRunModal';
import { Json } from './Json';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Combobox } from '@/components/ui/combobox';
import type { ComboboxOption } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { useBuilderStore } from '../store/builderStore';
import { isMountablePath } from '../../server/pathGuard';
import type { AuthPolicy, FieldDefinition, HttpTrigger, LogLine, WorkflowNode } from '../engine';
import { keyValueRows, simpleNodeDescription } from '@/lib/registerLens';
import { cn } from '@/lib/utils';

// Trace-kind presentation, mirrored from the runbook badge hover card so the
// Inspector speaks the same language (SQL/HTTP/LLM · query/endpoint/model).
const TRACE_KIND_LABEL: Record<string, string> = { db: 'SQL', http: 'HTTP', llm: 'LLM', compute: 'FN' };
const TRACE_KIND_COLOR: Record<string, string> = { db: '#8fb8d8', http: '#c9a6e8', llm: '#d8c88f', compute: '#9aa0a6' };
const TRACE_KIND_DETAIL_LABEL: Record<string, string> = { db: 'query', http: 'endpoint', llm: 'model', compute: 'detail' };

function statusText(status: string) {
  if (status === 'succeeded') return 'text-success';
  if (status === 'failed') return 'text-destructive';
  if (status === 'running') return 'text-highlight';
  return 'text-muted-foreground';
}

function statusDotClass(status: string) {
  if (status === 'succeeded') return 'bg-success';
  if (status === 'failed') return 'bg-destructive';
  if (status === 'running') return 'bg-highlight animate-pulse';
  return 'bg-muted-foreground';
}

/**
 * Simple outcome line: the last info-level log for this node in the
 * current run — same rule the runbook projection uses for step outcomes
 * (see lastInfoOutcome in runbookProjection.ts). Kept local here since that
 * helper isn't exported; duplicating a four-line loop beats reaching across
 * modules for it.
 */
function lastInfoOutcome(logs: LogLine[], nodeId: string): string {
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i];
    if (line.nodeId === nodeId && line.level === 'info') return line.message;
  }
  return '';
}

/**
 * Simple register key-value grid for a node's input/output payload —
 * two-column rows (mono key · plain value), with complex (object/array)
 * values collapsed behind a toggle button that expands an inline <Json>
 * block. The destructive error pane is unchanged and never folds.
 */
function KeyValueGrid({
  value,
  error,
  emptyLabel,
}: {
  value: Record<string, unknown> | undefined;
  error?: string;
  emptyLabel: string;
}) {
  const rows = keyValueRows(value);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setOpen({});
  }, [value]);

  return (
    <div>
      {rows.length === 0 && (
        <div className="text-[12px] text-muted-foreground/60">{emptyLabel}</div>
      )}
      {rows.map((row) => (
        <div className="mb-1.5" key={row.key}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{row.key}</span>
            {row.complex ? (
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [row.key]: !o[row.key] }))}
                aria-expanded={!!open[row.key]}
                className="min-w-0 truncate text-[12px] text-foreground underline decoration-dotted underline-offset-2 hover:text-highlight"
              >
                {row.display}
              </button>
            ) : (
              <span className="min-w-0 truncate text-[12px] text-foreground" title={row.display}>
                {row.display}
              </span>
            )}
          </div>
          {row.complex && open[row.key] && (
            <div className="mt-1">
              <Json value={(value as Record<string, unknown>)[row.key]} maxHeight={220} />
            </div>
          )}
        </div>
      ))}
      {error && (
        <pre className="mt-2 overflow-x-auto rounded-md border border-destructive/50 bg-background p-2 font-mono text-[11.5px] whitespace-pre-wrap text-destructive-foreground">
          {error}
        </pre>
      )}
    </div>
  );
}

/**
 * The declared shape of a node's input or output — field names (with types) it
 * will carry, before any run. Regular nodes read their schema; dynamic nodes
 * (Input) declare no schema and instead carry their emitted field names in
 * config.fields, which are the node's *output* shape. Returns [] when there is
 * genuinely nothing to describe, so the caller can drop the section entirely
 * rather than print a "nothing yet" placeholder.
 */
function shapeFields(
  node: WorkflowNode,
  definition: { inputSchema?: { fields: FieldDefinition[] }; outputSchema?: { fields: FieldDefinition[] } } | undefined,
  kind: 'input' | 'output',
): { name: string; type?: string }[] {
  const declared = (kind === 'input' ? definition?.inputSchema : definition?.outputSchema)?.fields ?? [];
  if (declared.length) return declared.map((f) => ({ name: f.name, type: f.type }));
  if (kind === 'output' && Array.isArray(node.config?.fields)) {
    return (node.config.fields as Array<{ name?: unknown; type?: unknown }>)
      .filter((f) => typeof f?.name === 'string' && f.name)
      .map((f) => ({ name: String(f.name), type: typeof f.type === 'string' ? f.type : undefined }));
  }
  return [];
}

/** The expected shape as a quiet field-name·type list — shown before a run in
 * place of a "nothing yet" placeholder, so the user sees what will flow. */
function ShapeList({ fields }: { fields: { name: string; type?: string }[] }) {
  return (
    <div>
      {fields.map((f) => (
        <div className="mb-1 flex items-baseline justify-between gap-3" key={f.name}>
          <span className="font-mono text-[10.5px] text-muted-foreground">{f.name}</span>
          {f.type && <span className="shrink-0 text-[10px] text-muted-foreground/50">{f.type}</span>}
        </div>
      ))}
    </div>
  );
}

function FieldTag({ field }: { field: FieldDefinition }) {
  return (
    <span className="font-mono text-[10px] text-muted-foreground/70">
      {field.type}
      {field.type === 'enum' && field.enumValues ? `: ${field.enumValues.join(' | ')}` : ''}
    </span>
  );
}

function FieldName({ field }: { field: FieldDefinition }) {
  return (
    <span className="font-mono text-[11.5px] text-foreground/90">
      {field.name}
      {field.required && <span className="ml-0.5 text-destructive">*</span>}
    </span>
  );
}

function ValuePreview({ value }: { value: unknown }) {
  if (value === undefined) return <span className="text-[11px] text-muted-foreground/60">—</span>;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (
    <code
      className="inline-block max-w-full truncate rounded-sm bg-secondary/60 px-1.5 font-mono text-[11px] text-muted-foreground"
      title={text}
    >
      {text}
    </code>
  );
}

function RunValue({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="mt-1 flex items-baseline gap-2">
      <span className="shrink-0 text-[9.5px] font-medium uppercase tracking-widest text-muted-foreground/60">
        {label}
      </span>
      <ValuePreview value={value} />
    </div>
  );
}

/** Declared output fields for a node, with values from a given output payload (last run or a selected iteration record). */
function OutputFieldsList({
  fields,
  outputValue,
  error,
}: {
  fields: FieldDefinition[];
  outputValue: Record<string, unknown> | undefined;
  error?: string;
}) {
  return (
    <>
      {fields.map((f) => (
        <div className="mb-3" key={f.name}>
          <div className="mb-1 flex items-baseline justify-between">
            <FieldName field={f} />
            <FieldTag field={f} />
          </div>
          {outputValue !== undefined && <RunValue label="last run" value={outputValue?.[f.name]} />}
        </div>
      ))}
      {fields.length === 0 && (
        <div className="text-[12px] text-muted-foreground/60">No declared outputs.</div>
      )}
      {error && (
        <pre className="mt-2 overflow-x-auto rounded-md border border-destructive/50 bg-background p-2 font-mono text-[11.5px] whitespace-pre-wrap text-destructive-foreground">
          {error}
        </pre>
      )}
    </>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
      {children}
    </h3>
  );
}

function isSecretRef(value: unknown): value is { $secret: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { $secret?: unknown }).$secret === 'string'
  );
}

/** True when a config value should be edited as JSON rather than a plain string. */
function isJsonConfigValue(value: unknown, field: FieldDefinition): boolean {
  if (typeof value === 'object' && value !== null) return true;
  return value === undefined && (field.type === 'object' || field.type === 'array');
}

/**
 * Mono JSON editor for object/array config values — replaces the string
 * Input, which otherwise coerces objects to "[object Object]". Edits are
 * kept in local draft state and only committed to the store on blur, once
 * they parse as valid JSON; invalid JSON is left in the draft with an
 * inline error rather than clobbering the stored value.
 */
function JsonConfigField({ node, field }: { node: WorkflowNode; field: FieldDefinition }) {
  const updateNodeConfig = useBuilderStore((s) => s.updateNodeConfig);
  const value = node.config[field.name];
  const [draft, setDraft] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);

  // Reset the draft whenever the node, field, or stored value changes from
  // outside this field (node switch, pin, mapping, undo, etc).
  useEffect(() => {
    setDraft(JSON.stringify(value ?? {}, null, 2));
    setError(null);
  }, [node.id, field.name, value]);

  const rows = Math.min(10, Math.max(3, draft.split('\n').length));

  const handleBlur = () => {
    try {
      const parsed = JSON.parse(draft);
      setError(null);
      updateNodeConfig(node.id, field.name, parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  };

  return (
    <div className="mb-2">
      <div className="mb-1 flex items-baseline justify-between">
        <FieldName field={field} />
        <FieldTag field={field} />
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        spellCheck={false}
        rows={rows}
        placeholder="{}"
        className="w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-relaxed outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]"
      />
      {error && <div className="mt-1 text-[11px] text-destructive">{error}</div>}
    </div>
  );
}

/** A Subflow node's workflowId, chosen from the workflows in the workspace. */
function WorkflowSelectField({ node, field }: { node: WorkflowNode; field: FieldDefinition }) {
  const workflows = useBuilderStore((s) => s.workflows);
  const flowId = useBuilderStore((s) => s.flow.id);
  const updateNodeConfig = useBuilderStore((s) => s.updateNodeConfig);
  const value = node.config[field.name];
  // A flow can't call itself (validation error), so leave self out of the list.
  const options: ComboboxOption[] = workflows
    .filter((w) => w.id !== flowId)
    .map((w) => ({ value: w.id, label: w.folder ? `${w.folder} / ${w.name}` : w.name }));

  return (
    <div className="mb-2 flex items-center justify-between gap-2.5">
      <FieldName field={field} />
      <Combobox
        className="max-w-44"
        options={options}
        value={String(value ?? '')}
        onChange={(v) => updateNodeConfig(node.id, field.name, v)}
        placeholder="select a workflow"
        searchPlaceholder="Search workflows…"
        clearLabel="none"
      />
    </div>
  );
}

function ConfigField({ node, field }: { node: WorkflowNode; field: FieldDefinition }) {
  const updateNodeConfig = useBuilderStore((s) => s.updateNodeConfig);
  const value = node.config[field.name];

  if (node.type === 'Subflow' && field.name === 'workflowId') {
    return <WorkflowSelectField node={node} field={field} />;
  }

  if (isSecretRef(value)) {
    return (
      <div className="mb-2 flex items-center justify-between gap-2.5">
        <FieldName field={field} />
        <Badge variant="mono" title="Resolved from runner secrets at execution time">
          secret · {value.$secret}
        </Badge>
      </div>
    );
  }

  if (isJsonConfigValue(value, field)) {
    return <JsonConfigField key={`${node.id}:${field.name}`} node={node} field={field} />;
  }

  if (field.type === 'boolean') {
    return (
      <label className="mb-2 flex items-center justify-between gap-2.5">
        <FieldName field={field} />
        <input
          type="checkbox"
          className="accent-(--highlight)"
          checked={Boolean(value)}
          onChange={(e) => updateNodeConfig(node.id, field.name, e.target.checked)}
        />
      </label>
    );
  }

  if (field.type === 'enum') {
    return (
      <div className="mb-2 flex items-center justify-between gap-2.5">
        <FieldName field={field} />
        <Combobox
          className="max-w-40"
          options={(field.enumValues ?? []).map((v) => ({ value: v, label: v }))}
          value={String(value ?? '')}
          onChange={(v) => updateNodeConfig(node.id, field.name, v)}
          clearLabel="none"
        />
      </div>
    );
  }

  return (
    <label className="mb-2 flex items-center justify-between gap-2.5">
      <FieldName field={field} />
      <Input
        className="max-w-40"
        type={field.type === 'number' ? 'number' : 'text'}
        value={String(value ?? '')}
        spellCheck={false}
        onChange={(e) =>
          updateNodeConfig(
            node.id,
            field.name,
            field.type === 'number' ? Number(e.target.value) : e.target.value,
          )
        }
      />
    </label>
  );
}


/**
 * Read-only input wiring: where each declared input comes from, in plain
 * language. Mappings are agent-authored — the user reads them, never edits
 * them here — so this is a static statement, not a picker: `field ← Source ·
 * out`, or a config default, or an unmapped note.
 */
function InputWiringRow({ node, field }: { node: WorkflowNode; field: FieldDefinition }) {
  const flow = useBuilderStore((s) => s.flow);
  const mapping = node.inputMap?.[field.name];
  const configValue = node.config[field.name];

  let source: React.ReactNode;
  if (mapping) {
    const src = flow.nodes.find((n) => n.id === mapping.sourceNodeId);
    const srcLabel = src?.label ?? mapping.sourceNodeId;
    source = (
      <span className="min-w-0 truncate text-[12px] text-foreground/90">
        <span className="text-highlight">{srcLabel}</span>
        {mapping.sourceField !== '$' && (
          <span className="font-mono text-[11px] text-muted-foreground"> · {mapping.sourceField}</span>
        )}
      </span>
    );
  } else if (configValue !== undefined) {
    const text = typeof configValue === 'string' ? configValue : JSON.stringify(configValue);
    source = (
      <code
        className="min-w-0 truncate rounded-sm bg-secondary/60 px-1.5 font-mono text-[11px] text-muted-foreground"
        title={text}
      >
        {text}
      </code>
    );
  } else {
    source = <span className="text-[11.5px] text-muted-foreground/50 italic">not wired</span>;
  }

  return (
    <div className="flex items-baseline gap-2 py-1">
      <span className="shrink-0 font-mono text-[11.5px] text-foreground/90">
        {field.name}
        {field.required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      <span className="shrink-0 text-muted-foreground/50">←</span>
      {source}
    </div>
  );
}

/**
 * The per-node action bar — one consistent row shared by both registers so the
 * controls look and sit the same everywhere: run this node in isolation, view
 * its code, and pin/unpin its last output. `Pin` only appears once there's an
 * output to pin; when pinned it becomes an in-place toggle in the accent colour.
 */
function NodeActions({
  onRun,
  onCode,
  hasOutput,
  pinned,
  onPin,
  onUnpin,
}: {
  onRun: () => void;
  onCode: () => void;
  hasOutput: boolean;
  pinned: boolean;
  onPin: () => void;
  onUnpin: () => void;
}) {
  const btn = 'gap-1 text-muted-foreground hover:text-foreground';
  return (
    <div className="flex items-center gap-0.5">
      <Button variant="ghost" size="xs" className={btn} onClick={onRun} title="Run this node in isolation">
        <PlayIcon /> Run
      </Button>
      <Button variant="ghost" size="xs" className={btn} onClick={onCode} title="View this node's implementation">
        <CodeIcon /> Code
      </Button>
      {hasOutput &&
        (pinned ? (
          <Button
            variant="ghost"
            size="xs"
            className="gap-1 text-highlight hover:text-highlight"
            onClick={onUnpin}
            title="Pinned — runs reuse this output without executing. Click to unpin."
          >
            <PinIcon className="fill-current" /> Pinned
          </Button>
        ) : (
          <Button variant="ghost" size="xs" className={btn} onClick={onPin} title="Pin last output — runs reuse it without executing">
            <PinIcon /> Pin
          </Button>
        ))}
    </div>
  );
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
type AuthKind = 'inherit' | 'none' | 'bearer' | 'apiKey';

function authKindOf(auth: HttpTrigger['auth']): AuthKind {
  if (auth === undefined || auth === 'inherit') return 'inherit';
  if (auth === 'none') return 'none';
  return auth.scheme;
}

const baseInputClass =
  'w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12px] outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]';

// Slug of the flow's name (falling back to the last path segment of its id)
// used to seed a sensible non-root default path when HTTP is first enabled.
function defaultHttpPath(flowId: string, flowName: string): string {
  const source = flowName?.trim() || flowId.split('/').pop() || 'operation';
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `/${slug || 'operation'}`;
}

/**
 * Flow-level HTTP endpoint editor: method/path/inputSchema/auth for the
 * active flow's `http` trigger. This is deliberately independent of node
 * selection — any flow can become an operation by adding `http`, so it
 * renders regardless of which (if any) node is selected. Every write goes
 * through `setFlowHttp`, which flows through the same touched()+autosave
 * path (see the store's flow-change subscription) as every other flow edit,
 * so this reuses the existing PUT /workflows/:id persistence — no new path.
 */
function HttpSection() {
  const flowId = useBuilderStore((s) => s.flow.id);
  const flowName = useBuilderStore((s) => s.flow.name);
  const http = useBuilderStore((s) => s.flow.http);
  const setFlowHttp = useBuilderStore((s) => s.setFlowHttp);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pathHint, setPathHint] = useState<string | null>(null);
  // Holds the raw text of an in-progress, not-yet-valid path edit (e.g. the
  // user cleared the field or typed '/') so the input reflects what they
  // typed instead of snapping back to the last-persisted path. Cleared
  // (falls back to `http.path`) once the text becomes a valid sub-path.
  const [pathDraft, setPathDraft] = useState<string | null>(null);

  const [schemaDraft, setSchemaDraft] = useState(() => JSON.stringify(http?.inputSchema ?? {}, null, 2));
  const [schemaError, setSchemaError] = useState<string | null>(null);

  // Reset the schema draft only when the active flow changes — not on every
  // http edit, which would otherwise reformat the textarea under the user's
  // fingers as they type (setFlowHttp round-trips through JSON.stringify).
  useEffect(() => {
    setSchemaDraft(JSON.stringify(http?.inputSchema ?? {}, null, 2));
    setSchemaError(null);
    setPathHint(null);
    setPathDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId]);

  const enabled = !!http;
  const kind = authKindOf(http?.auth);
  const authObj: AuthPolicy | undefined = http && typeof http.auth === 'object' ? http.auth : undefined;

  const toggleEnabled = (checked: boolean) => {
    setPathHint(null);
    setPathDraft(null);
    setFlowHttp(checked ? (http ?? { method: 'GET', path: defaultHttpPath(flowId, flowName) }) : undefined);
  };

  const handlePathChange = (raw: string) => {
    if (!http) return;
    if (!isMountablePath(raw)) {
      setPathDraft(raw);
      setPathHint('Path must be a sub-path like /things (not /)');
      return;
    }
    setPathDraft(null);
    setPathHint(null);
    setFlowHttp({ ...http, path: raw });
  };

  const setAuthKind = (next: AuthKind) => {
    if (!http) return;
    if (next === 'inherit') {
      const { auth: _drop, ...rest } = http;
      setFlowHttp(rest);
    } else if (next === 'none') {
      setFlowHttp({ ...http, auth: 'none' });
    } else {
      setFlowHttp({
        ...http,
        auth: { scheme: next, secretRef: authObj?.secretRef ?? '', ...(authObj?.header ? { header: authObj.header } : {}) },
      });
    }
  };

  const handleSchemaChange = (text: string) => {
    setSchemaDraft(text);
    if (!http) return;
    try {
      const parsed = JSON.parse(text);
      setSchemaError(null);
      setFlowHttp({ ...http, inputSchema: parsed });
    } catch (err) {
      setSchemaError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  };

  return (
    <section className="mt-4 border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setAdvancedOpen((o) => !o)}
        aria-expanded={advancedOpen}
        className="flex w-full cursor-pointer items-center gap-1.5 text-left text-[10px] font-medium uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn('size-3 shrink-0 transition-transform', advancedOpen && 'rotate-90')}
        />
        Advanced · HTTP &amp; auth
      </button>

      {advancedOpen && (
        <div className="mt-3">
          <div className="mb-2.5 flex items-center justify-between">
            <SectionTitle>HTTP</SectionTitle>
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              HTTP endpoint
              <input
                type="checkbox"
                className="accent-(--highlight)"
                checked={enabled}
                onChange={(e) => toggleEnabled(e.target.checked)}
                aria-label="HTTP endpoint"
              />
            </label>
          </div>

          {enabled && http && (
            <>
          <div className="mb-2 flex items-center gap-2">
            <select
              className={cn(baseInputClass, 'w-24 shrink-0')}
              value={http.method}
              aria-label="HTTP method"
              onChange={(e) => setFlowHttp({ ...http, method: e.target.value })}
            >
              {HTTP_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              className={cn(baseInputClass, 'font-mono')}
              value={pathDraft ?? http.path}
              placeholder="/path/:id"
              spellCheck={false}
              aria-label="HTTP path"
              onChange={(e) => handlePathChange(e.target.value)}
            />
          </div>
          {pathHint && <div className="mb-2 -mt-1 text-[11px] text-destructive">{pathHint}</div>}

          <div className="mb-2">
            <div className="mb-1 text-[10.5px] text-muted-foreground">Input schema</div>
            <textarea
              value={schemaDraft}
              onChange={(e) => handleSchemaChange(e.target.value)}
              spellCheck={false}
              rows={Math.min(10, Math.max(3, schemaDraft.split('\n').length))}
              placeholder="{}"
              className="w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-relaxed outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            />
            {schemaError && <div className="mt-1 text-[11px] text-destructive">invalid JSON: {schemaError}</div>}
          </div>

          <div className="mb-2">
            <div className="mb-1 text-[10.5px] text-muted-foreground">Auth</div>
            <select
              className={baseInputClass}
              value={kind}
              aria-label="Auth policy"
              onChange={(e) => setAuthKind(e.target.value as AuthKind)}
            >
              <option value="inherit">Inherit</option>
              <option value="none">None (public)</option>
              <option value="bearer">Bearer token</option>
              <option value="apiKey">API key</option>
            </select>
          </div>

          {(kind === 'bearer' || kind === 'apiKey') && (
            <div className="mb-2 space-y-2">
              <label className="block">
                <div className="mb-1 text-[10.5px] text-muted-foreground">Secret ref</div>
                <input
                  className={cn(baseInputClass, 'font-mono')}
                  value={authObj?.secretRef ?? ''}
                  spellCheck={false}
                  placeholder="e.g. API_TOKEN"
                  onChange={(e) =>
                    setFlowHttp({
                      ...http,
                      auth: { scheme: kind, secretRef: e.target.value, ...(authObj?.header ? { header: authObj.header } : {}) },
                    })
                  }
                />
              </label>
              {kind === 'apiKey' && (
                <label className="block">
                  <div className="mb-1 text-[10.5px] text-muted-foreground">Header (default x-api-key)</div>
                  <input
                    className={cn(baseInputClass, 'font-mono')}
                    value={authObj?.header ?? ''}
                    spellCheck={false}
                    placeholder="x-api-key"
                    onChange={(e) =>
                      setFlowHttp({
                        ...http,
                        auth: { scheme: 'apiKey', secretRef: authObj?.secretRef ?? '', header: e.target.value },
                      })
                    }
                  />
                </label>
              )}
            </div>
          )}
        </>
          )}
        </div>
      )}
    </section>
  );
}

export function Inspector() {
  const flow = useBuilderStore((s) => s.flow);
  const registry = useBuilderStore((s) => s.registry);
  const run = useBuilderStore((s) => s.run);
  const logs = useBuilderStore((s) => s.logs);
  const register = useBuilderStore((s) => s.viewRegister);
  const selectedNodeId = useBuilderStore((s) => s.selectedNodeId);
  const renameNode = useBuilderStore((s) => s.renameNode);
  const pinNodeOutput = useBuilderStore((s) => s.pinNodeOutput);
  const unpinNode = useBuilderStore((s) => s.unpinNode);
  const setNodeRetry = useBuilderStore((s) => s.setNodeRetry);
  const [codeOpen, setCodeOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Mechanism (config/mappings/pin/run/code) folds shut whenever the
  // selection changes, so switching nodes never leaks an open fold from one
  // node onto another.
  useEffect(() => {
    setDetailsOpen(false);
  }, [selectedNodeId]);

  const node = flow.nodes.find((n) => n.id === selectedNodeId);

  if (!node) {
    return (
      <div className="p-4 pt-6 text-[13px] text-muted-foreground">
        <div className="mb-1.5 font-medium text-foreground/80">Nothing selected</div>
        <p className="leading-relaxed">
          Select a node to inspect its configuration, inputs, outputs, and the data from the
          last run.
        </p>
        <HttpSection />
      </div>
    );
  }

  const definition = registry.has(node.type) ? registry.get(node.type).definition : undefined;
  const state = run?.nodeStates[node.id];
  const outputValue = state?.output as Record<string, unknown> | undefined;
  const executions = state?.executions;
  const source = registry.has(node.type) ? (registry.getSource(node.type) ?? '') : '';

  const codeDialog = (
    <Dialog open={codeOpen} onOpenChange={setCodeOpen}>
      <DialogContent className="max-w-4xl">
        <DialogTitle className="flex items-center gap-2">
          {node.label}
          <Badge variant="mono">{node.type}</Badge>
        </DialogTitle>
        <DialogDescription>{definition?.description ?? 'Node implementation'}</DialogDescription>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-background">
          <SyntaxHighlighter
            language="javascript"
            style={vscDarkPlus}
            showLineNumbers
            customStyle={{
              margin: 0,
              background: 'transparent',
              fontSize: '12.5px',
              lineHeight: 1.6,
              padding: '12px 2px',
            }}
            codeTagProps={{ style: { background: 'transparent', textShadow: 'none' } }}
            lineNumberStyle={{
              color: 'var(--muted-foreground)',
              opacity: 0.35,
              background: 'transparent',
              minWidth: '2.75em',
              paddingRight: '1em',
            }}
          >
            {source}
          </SyntaxHighlighter>
        </div>
      </DialogContent>
    </Dialog>
  );

  if (register === 'simple') {
    // Failed nodes lead with their error, matching the runbook projection's
    // outcome rule — a stale info line in the outcome slot would misreport.
    const outcome =
      state?.status === 'failed'
        ? state.error || lastInfoOutcome(logs, node.id)
        : lastInfoOutcome(logs, node.id);
    const pinned = !!(node.metadata && 'pinnedOutput' in node.metadata);
    const plainDescription = simpleNodeDescription(definition);

    return (
      <div className="p-4">
        <div className="mb-2">
          <input
            className="-ml-1.5 w-full rounded-sm border border-transparent bg-transparent px-1.5 py-1 text-[15px] font-semibold tracking-tight outline-none transition-colors hover:border-border focus:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            value={node.label}
            onChange={(e) => renameNode(node.id, e.target.value)}
            aria-label="Node label"
            spellCheck={false}
          />
          <div className="my-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-mono">{node.type}</span>
            {state && (
              <>
                <span className={cn('size-1.5 rounded-full', statusDotClass(state.status))} />
                <span className={statusText(state.status)}>{state.status}</span>
              </>
            )}
            {definition?.effects === 'mutation' && (
              <span className="text-[11px] text-warn" title="Mutation: has side effects">
                ⚡
              </span>
            )}
          </div>
          <div className="-ml-1.5 mt-1.5">
            <NodeActions
              onRun={() => setRunOpen(true)}
              onCode={() => setCodeOpen(true)}
              hasOutput={state?.output !== undefined}
              pinned={pinned}
              onPin={() => state?.output !== undefined && pinNodeOutput(node.id, state.output)}
              onUnpin={() => unpinNode(node.id)}
            />
          </div>
        </div>

        {plainDescription && (
          <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
            {plainDescription}
          </p>
        )}

        {outcome && (
          <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground/80 italic">{outcome}</p>
        )}

        {(() => {
          const inputVal = state?.input as Record<string, unknown> | undefined;
          const hasInputVal = !!inputVal && Object.keys(inputVal).length > 0;
          const inputShape = shapeFields(node, definition, 'input');
          // Nothing to say — no run value and no declared shape — so no section.
          if (!hasInputVal && inputShape.length === 0) return null;
          return (
            <section className="mt-3 border-t border-border pt-3">
              <SectionTitle>Inputs</SectionTitle>
              {hasInputVal ? <KeyValueGrid value={inputVal} emptyLabel="" /> : <ShapeList fields={inputShape} />}
            </section>
          );
        })()}

        {(() => {
          const hasExecOutputs = !!executions && executions.length > 1;
          const hasOutputVal = !!outputValue && Object.keys(outputValue).length > 0;
          const outputShape = shapeFields(node, definition, 'output');
          if (!hasExecOutputs && !hasOutputVal && !state?.error && outputShape.length === 0) return null;
          return (
            <section className="mt-4 border-t border-border pt-3">
              <SectionTitle>Outputs</SectionTitle>
              {hasExecOutputs ? (
                <ExecutionPager executions={executions!}>
                  {(record) => (
                    <KeyValueGrid
                      value={record.output as Record<string, unknown> | undefined}
                      error={record.error}
                      emptyLabel=""
                    />
                  )}
                </ExecutionPager>
              ) : hasOutputVal || state?.error ? (
                <KeyValueGrid value={outputValue} error={state?.error} emptyLabel="" />
              ) : (
                <ShapeList fields={outputShape} />
              )}
            </section>
          );
        })()}

        <section className="mt-4 border-t border-border pt-3">
          <button
            type="button"
            onClick={() => setDetailsOpen((o) => !o)}
            aria-expanded={detailsOpen}
            className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRightIcon
              className={cn('size-3 shrink-0 transition-transform', detailsOpen && 'rotate-90')}
            />
            Details
          </button>

          {detailsOpen && (
            <div className="mt-3">
              {(definition?.configSchema?.fields.length ?? 0) > 0 && (
                <section className="mb-4">
                  <SectionTitle>Config</SectionTitle>
                  {node.type === 'Conditional' ? (
                    <BranchRulesEditor node={node} />
                  ) : (
                    definition!.configSchema!.fields.map((f) => (
                      <ConfigField key={f.name} node={node} field={f} />
                    ))
                  )}
                </section>
              )}

              {(definition?.inputSchema?.fields.length ?? 0) > 0 && (
                <section className="mb-4">
                  <SectionTitle>Input mappings</SectionTitle>
                  {definition!.inputSchema!.fields.map((f) => (
                    <InputWiringRow key={f.name} node={node} field={f} />
                  ))}
                </section>
              )}
            </div>
          )}
        </section>

        <HttpSection />

        <NodeRunModal node={node} open={runOpen} onOpenChange={setRunOpen} />
        {codeDialog}
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="mb-2">
        <input
          className="-ml-1.5 w-full rounded-sm border border-transparent bg-transparent px-1.5 py-1 text-[15px] font-semibold tracking-tight outline-none transition-colors hover:border-border focus:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          value={node.label}
          onChange={(e) => renameNode(node.id, e.target.value)}
          aria-label="Node label"
          spellCheck={false}
        />
        <div className="my-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono">{node.type}</span>
          {state && (
            <>
              <span className="text-border">·</span>
              <span className={statusText(state.status)}>{state.status}</span>
            </>
          )}
        </div>
        <div className="-ml-1.5 mt-1.5">
          <NodeActions
            onRun={() => setRunOpen(true)}
            onCode={() => setCodeOpen(true)}
            hasOutput={state?.output !== undefined}
            pinned={!!(node.metadata && 'pinnedOutput' in node.metadata)}
            onPin={() => state?.output !== undefined && pinNodeOutput(node.id, state.output)}
            onUnpin={() => unpinNode(node.id)}
          />
        </div>
        <NodeRunModal node={node} open={runOpen} onOpenChange={setRunOpen} />
        {codeDialog}
        {definition?.description && (
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {definition.description}
          </p>
        )}
      </div>

      {/* The real call this node makes — same kind + endpoint/query/model the
          runbook badge reveals on hover, surfaced here so it's readable without
          hunting for the badge. */}
      {definition?.traceKind && definition.traceKind !== 'compute' && (
        <section className="mt-4 border-t border-border pt-3">
          <div className="mb-2 flex items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wide"
              style={{
                color: TRACE_KIND_COLOR[definition.traceKind],
                backgroundColor: `${TRACE_KIND_COLOR[definition.traceKind]}1f`,
              }}
            >
              {TRACE_KIND_LABEL[definition.traceKind]}
            </span>
            <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              {TRACE_KIND_DETAIL_LABEL[definition.traceKind]}
            </span>
            {definition.effects === 'mutation' && (
              <span className="text-[11px] text-warn" title="Mutation: has side effects">⚡</span>
            )}
          </div>
          {definition.traceDetail ? (
            <p className="font-mono text-[11.5px] leading-relaxed break-words text-foreground/85">
              {definition.traceDetail}
            </p>
          ) : (
            <p className="text-[11.5px] text-muted-foreground/60">No trace detail recorded.</p>
          )}
        </section>
      )}

      {(definition?.configSchema?.fields.length ?? 0) > 0 && (
        <section className="mt-4 border-t border-border pt-3">
          <SectionTitle>Config</SectionTitle>
          {node.type === 'Conditional' ? (
            <BranchRulesEditor node={node} />
          ) : (
            definition!.configSchema!.fields.map((f) => (
              <ConfigField key={f.name} node={node} field={f} />
            ))
          )}
        </section>
      )}

      {node.type !== 'Input' && node.type !== 'Response' && node.type !== 'Result' && (
        <section className="mt-4 border-t border-border pt-3">
          <SectionTitle>Retry</SectionTitle>
          <div className="mt-1.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
            <input
              type="number"
              min={1}
              value={node.retry?.maxTries ?? ''}
              placeholder="1"
              onChange={(e) => {
                const maxTries = Number(e.target.value);
                setNodeRetry(
                  node.id,
                  Number.isInteger(maxTries) && maxTries > 1
                    ? { maxTries, ...(node.retry?.waitMs ? { waitMs: node.retry.waitMs } : {}) }
                    : undefined,
                );
              }}
              className="w-14 rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px] outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]"
              aria-label="Total attempts"
              title="Total attempts including the first — 1 or empty disables retry"
            />
            <span>tries</span>
            <input
              type="number"
              min={0}
              step={100}
              value={node.retry?.waitMs ?? ''}
              placeholder="0"
              disabled={!node.retry}
              onChange={(e) => {
                if (!node.retry) return;
                const waitMs = Number(e.target.value);
                setNodeRetry(node.id, {
                  maxTries: node.retry.maxTries,
                  ...(Number.isFinite(waitMs) && waitMs > 0 ? { waitMs } : {}),
                });
              }}
              className="w-20 rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px] outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-40"
              aria-label="Wait between attempts (ms)"
              title="Fixed wait between attempts, in milliseconds"
            />
            <span>ms between</span>
          </div>
        </section>
      )}

      {/* Run I/O leads in technical: when the node has actually executed, the
          run's real output (then input) as formatted JSON is what a developer
          came to see — declarations and mappings are agent territory and fold
          below. */}
      {state && (state.output !== undefined || state.input !== undefined || state.error) && (
        <section className="mt-4 border-t border-border pt-3">
          <SectionTitle>Run I/O</SectionTitle>
          {executions && executions.length > 1 ? (
            <ExecutionPager executions={executions}>
              {(record) => (
                <RunIoPanes input={record.input} output={record.output} error={record.error} />
              )}
            </ExecutionPager>
          ) : (
            <RunIoPanes input={state.input} output={state.output} error={state.error} />
          )}
        </section>
      )}

      <section className="mt-4 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setSchemaOpen((v) => !v)}
          aria-expanded={schemaOpen}
          className="flex w-full cursor-pointer items-center gap-1.5 text-left"
        >
          <ChevronRightIcon
            className={cn('size-3 text-muted-foreground transition-transform', schemaOpen && 'rotate-90')}
          />
          <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Wiring &amp; schema
          </span>
        </button>
        {schemaOpen && (
          <div className="mt-3">
            {(definition?.inputSchema?.fields.length ?? 0) > 0 && (
              <div className="mb-4">
                <SectionTitle>Input wiring</SectionTitle>
                {definition!.inputSchema!.fields.map((f) => (
                  <InputWiringRow key={f.name} node={node} field={f} />
                ))}
              </div>
            )}
            <SectionTitle>Outputs</SectionTitle>
            <OutputFieldsList
              fields={definition?.outputSchema?.fields ?? []}
              outputValue={outputValue}
              error={state?.error}
            />
          </div>
        )}
      </section>

      <HttpSection />
    </div>
  );
}

/** Technical Run I/O: the run's actual payloads as formatted JSON — output
 * first (what the node produced is the headline), then input, error verbatim. */
function RunIoPanes({ input, output, error }: { input: unknown; output: unknown; error?: string }) {
  return (
    <div className="space-y-3">
      {error && (
        <pre className="overflow-x-auto rounded-md border border-destructive/50 bg-background p-2.5 font-mono text-[11.5px] whitespace-pre-wrap text-destructive-foreground">
          {error}
        </pre>
      )}
      {output !== undefined && (
        <div>
          <div className="mb-1 text-[9.5px] font-medium uppercase tracking-widest text-muted-foreground/70">
            Output
          </div>
          <Json value={output} maxHeight={280} />
        </div>
      )}
      {input !== undefined && (
        <div>
          <div className="mb-1 text-[9.5px] font-medium uppercase tracking-widest text-muted-foreground/70">
            Input
          </div>
          <Json value={input} maxHeight={200} />
        </div>
      )}
    </div>
  );
}
