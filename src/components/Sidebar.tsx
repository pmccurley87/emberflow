import { useMemo, useState } from 'react';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
  WorkflowIcon,
  XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { useBuilderStore } from '../store/builderStore';
import { buildApiTree } from '../store/apiTree';
import type { ApiTreeNode, OpItem } from '../store/apiTree';
import { cn } from '@/lib/utils';

function methodBadgeVariant(method?: string): 'success' | 'highlight' | 'default' | 'destructive' | 'outline' {
  switch (method) {
    case 'GET':
      return 'success';
    case 'POST':
      return 'highlight';
    case 'DELETE':
      return 'destructive';
    case 'PUT':
    case 'PATCH':
      return 'default';
    default:
      return 'outline';
  }
}

/** Every operation id under this node (including nested folders). */
function collectOpIds(node: ApiTreeNode): string[] {
  return node.operations.map((o) => o.id).concat(node.folders.flatMap(collectOpIds));
}

/**
 * The hover "⋯" menu shared by API and operation rows. Reveals on the row's
 * group-hover, stays visible while open. Currently one item — Delete — which
 * fires immediately (no confirm dialog, per the delete-immediately spec).
 */
function RowMenu({ label, onDelete }: { label: string; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label={label}
          title={label}
          className="shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontalIcon className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-40 p-1" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
            onDelete();
          }}
          className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] text-destructive transition-colors hover:bg-destructive/10"
        >
          <Trash2Icon className="size-3.5" /> Delete
        </button>
      </PopoverContent>
    </Popover>
  );
}

function OperationRow({ op, depth }: { op: OpItem; depth: number }) {
  const activeId = useBuilderStore((s) => s.flow.id);
  const switchWorkflow = useBuilderStore((s) => s.switchWorkflow);
  const deleteOperations = useBuilderStore((s) => s.deleteOperations);
  const isActive = op.id === activeId;
  const rowTitle = op.method
    ? `HTTP endpoint: ${op.method} ${op.httpPath ?? ''}`.trim()
    : 'Runs inside the studio or as a sub-step — no HTTP endpoint';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => switchWorkflow(op.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          switchWorkflow(op.id);
        }
      }}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={rowTitle}
      className={cn(
        'group flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2.5 text-left text-[12.5px] transition-colors',
        isActive
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
      )}
    >
      {op.method ? (
        <Badge variant={methodBadgeVariant(op.method)} className="shrink-0">
          {op.method}
        </Badge>
      ) : (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/50"
          title="Runs inside the studio or as a sub-step — no HTTP endpoint"
        >
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          no endpoint
        </span>
      )}
      <span className="truncate">{op.name}</span>
      {op.httpPath && (
        <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground/60">
          {op.httpPath}
        </span>
      )}
      <span className={op.httpPath ? '' : 'ml-auto'}>
        <RowMenu label={`Delete ${op.name}`} onDelete={() => void deleteOperations([op.id])} />
      </span>
    </div>
  );
}

function countOps(node: ApiTreeNode): number {
  return node.operations.length + node.folders.reduce((sum, f) => sum + countOps(f), 0);
}

/** Every operation under an API (including nested folders) that has an HTTP trigger. */
function collectHttpOps(node: ApiTreeNode): OpItem[] {
  const own = node.operations.filter((op) => op.method && op.httpPath);
  return node.folders.reduce((acc, f) => acc.concat(collectHttpOps(f)), own);
}

/**
 * Gear/info affordance on each API row: opens a centered modal with
 * API-level settings. Currently shows the absolute invocation URL
 * (origin + http path) for every operation under this API that has an
 * HTTP trigger, with a per-row copy button — laid out as a settings panel
 * so more API-level sections can be added here later.
 */
function ApiSettingsButton({ node }: { node: ApiTreeNode }) {
  const [open, setOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const httpOps = useMemo(() => collectHttpOps(node), [node]);

  const copy = (op: OpItem) => {
    const url = `${window.location.origin}${op.httpPath}`;
    void navigator.clipboard.writeText(url);
    setCopiedId(op.id);
    window.setTimeout(() => setCopiedId((id) => (id === op.id ? null : id)), 1200);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={`${node.name} settings`}
        title="API settings"
        className="ml-1 shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
      >
        <SettingsIcon className="size-3" />
      </button>
      <DialogContent className="max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div>
          <DialogTitle>{node.name}</DialogTitle>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {httpOps.length} operation{httpOps.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            Endpoints
          </div>
          <div className="max-h-96 overflow-y-auto rounded-md border border-border">
            {httpOps.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-muted-foreground/70">
                No HTTP endpoints on this API.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {httpOps.map((op) => {
                  const url = `${window.location.origin}${op.httpPath}`;
                  return (
                    <div key={op.id} className="flex items-center gap-2 px-2.5 py-2 hover:bg-accent">
                      <Badge variant={methodBadgeVariant(op.method)} className="shrink-0">
                        {op.method}
                      </Badge>
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground/90"
                        title={url}
                      >
                        {url}
                      </span>
                      <button
                        type="button"
                        onClick={() => copy(op)}
                        aria-label={`Copy URL for ${op.name}`}
                        title="Copy URL"
                        className="shrink-0 cursor-pointer rounded-sm p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      >
                        <CopyIcon className="size-3" />
                      </button>
                      {copiedId === op.id && (
                        <span className="shrink-0 text-[10px] text-success">Copied</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TreeNode({
  node,
  keyPath,
  depth,
  isApi,
  collapsed,
  toggle,
  onAddOperation,
}: {
  node: ApiTreeNode;
  keyPath: string;
  depth: number;
  isApi?: boolean;
  collapsed: Set<string>;
  toggle: (key: string) => void;
  /** Open the agentic create modal scoped to this API (from the hover +). */
  onAddOperation: (location: string) => void;
}) {
  const isCollapsed = collapsed.has(keyPath);
  const deleteOperations = useBuilderStore((s) => s.deleteOperations);

  return (
    <div className={isApi ? 'group' : undefined}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => toggle(keyPath)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle(keyPath);
          }
        }}
        style={{ paddingLeft: 8 + depth * 14 }}
        className={cn(
          'flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-sidebar-accent/60',
          isApi ? 'text-[12.5px] font-semibold text-foreground' : 'text-[12px] font-medium text-foreground/80',
        )}
      >
        {isCollapsed ? (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {isApi ? (
          <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{node.name}</span>
        {isApi && <ApiSettingsButton node={node} />}
        {isApi && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAddOperation(keyPath);
            }}
            aria-label={`New operation in ${node.name}`}
            title="New operation"
            className="shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
          >
            <PlusIcon className="size-3.5" />
          </button>
        )}
        {isApi && (
          <RowMenu
            label={`Delete ${node.name} API`}
            onDelete={() => void deleteOperations(collectOpIds(node))}
          />
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
          {countOps(node)}
        </span>
      </div>
      {!isCollapsed && (
        <>
          {node.folders.map((folder) => (
            <TreeNode
              key={folder.name}
              node={folder}
              keyPath={`${keyPath}/${folder.name}`}
              depth={depth + 1}
              collapsed={collapsed}
              toggle={toggle}
              onAddOperation={onAddOperation}
            />
          ))}
          {node.operations.map((op) => (
            <OperationRow key={op.id} op={op} depth={depth + 1} />
          ))}
        </>
      )}
    </div>
  );
}

export function Sidebar() {
  const workflows = useBuilderStore((s) => s.workflows);
  const toggleSidebar = useBuilderStore((s) => s.toggleSidebar);
  // The create modal itself is hosted once in App (CreateModalHost) — the
  // sidebar only asks the store to open it, so it works with the sidebar closed.
  const setCreateModal = useBuilderStore((s) => s.setCreateModal);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = useMemo(
    () =>
      buildApiTree(
        workflows.map((w) => ({
          id: w.id,
          name: w.name,
          path: w.path ?? `default/${w.id}`,
          http: w.http,
        })),
      ),
    [workflows],
  );

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <aside className="flex h-full w-full flex-col bg-sidebar">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          APIs
        </span>
        <span className="flex items-center">
          <Button
            variant="ghost"
            size="xs"
            aria-label="New operation"
            title="New operation"
            onClick={() => setCreateModal({ mode: 'operation' })}
            className="text-muted-foreground hover:text-foreground"
          >
            <PlusIcon />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={toggleSidebar}
            aria-label="Close sidebar"
            title="Close sidebar (⌘B)"
            className="text-muted-foreground hover:text-foreground"
          >
            <XIcon />
          </Button>
        </span>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {tree.map((api) => (
          <TreeNode
            key={api.name}
            node={api}
            keyPath={api.name}
            depth={0}
            isApi
            collapsed={collapsed}
            toggle={toggle}
            onAddOperation={(location) => setCreateModal({ mode: 'operation', location })}
          />
        ))}
      </nav>
      <div className="border-t border-sidebar-border p-2">
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={() => setCreateModal({ mode: 'api' })}
        >
          <PlusIcon /> New API
        </Button>
      </div>
    </aside>
  );
}
