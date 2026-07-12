import { useEffect, useRef, useState } from 'react';
import { FolderIcon, SparklesIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useBuilderStore } from '../store/builderStore';
import { cn } from '@/lib/utils';

/** lowercase, spaces -> '-', strip anything not URL-safe (matches builderStore.slug). */
function slug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// Words that add no meaning to an operation's derived name/route.
const STOP = new Set([
  'a', 'an', 'the', 'and', 'to', 'for', 'of', 'that', 'with', 'from', 'on', 'in', 'into',
  'your', 'my', 'me', 'it', 'create', 'make', 'build', 'add', 'new', 'return', 'get',
]);
// Read-ish verbs → a GET route; everything else defaults to POST.
const GET_VERB = /^(list|get|look\s?up|fetch|find|show|read|search|retrieve|view)\b/i;

/** Derive a first-guess operation name + method + path from the plain-language
 *  goal, so the create flow can stand up a real, selectable stub immediately.
 *  The agent (and the Inspector) can refine any of it afterwards. */
function deriveOperation(goal: string, location: string): { name: string; method: string; httpPath: string } {
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .slice(0, 4);
  const opSlug = words.join('-') || 'operation';
  const name = words.length
    ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
    : 'New Operation';
  const method = GET_VERB.test(goal.trim()) ? 'GET' : 'POST';
  return { name, method, httpPath: `/${location}/${opSlug}` };
}

/** Configures the two entry points that share this modal. */
export type CreateModalState =
  | { mode: 'api' }
  | { mode: 'operation'; location?: string }; // location preset scopes it to an API (from the + hover)

const OPERATION_EXAMPLES = [
  'List overdue invoices for a customer',
  'Charge a saved card and return the receipt',
  'Webhook that verifies a Stripe event',
];
const API_EXAMPLES = [
  'Create a draft invoice',
  'Look up a customer by email',
  'Start a background export job',
];

/**
 * The agentic create surface — one centered modal for both "New API" (name +
 * its first operation) and "New operation" (scoped to an API, or with a
 * location picker). Describe the goal in plain language; the agent picks the
 * method/path/nodes and builds it. Streams into the AgentConsole on submit.
 */
export function CreateModal({
  state,
  onOpenChange,
  locations,
}: {
  state: CreateModalState | null;
  onOpenChange: (open: boolean) => void;
  locations: string[];
}) {
  const createAndBuild = useBuilderStore((s) => s.createAndBuild);
  const agentRunning = useBuilderStore((s) => s.agentRun?.status === 'running');

  const [apiName, setApiName] = useState('');
  const [goal, setGoal] = useState('');
  const [location, setLocation] = useState('');
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);
  const goalRef = useRef<HTMLTextAreaElement>(null);

  const open = state !== null;
  const mode = state?.mode ?? 'operation';
  const presetLocation = state?.mode === 'operation' ? state.location : undefined;
  const examples = mode === 'api' ? API_EXAMPLES : OPERATION_EXAMPLES;

  // Reset fields each time the modal opens; seed the location from the preset.
  useEffect(() => {
    if (!open) return;
    setApiName('');
    setGoal('');
    setLocation(presetLocation ?? '');
    setLocationPickerOpen(false);
    const t = setTimeout(() => goalRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open, presetLocation]);

  const apiSlug = slug(apiName);
  const targetLocation = mode === 'api' ? apiSlug : location.trim() || 'default';
  const canSubmit =
    !agentRunning && goal.trim().length > 0 && (mode === 'operation' || apiSlug.length > 0);

  const submit = () => {
    if (!canSubmit) return;
    const { name, method, httpPath } = deriveOperation(goal.trim(), targetLocation);
    // Stand up the stub + select it, then let the agent fill it in. The user
    // sees the operation's name and route immediately, with a holding pattern
    // on the canvas until the build completes.
    void createAndBuild({ location: targetLocation, name, method, httpPath, goal: goal.trim() });
    onOpenChange(false);
  };

  const scopedLabel = presetLocation; // operation launched from an API's + button

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 p-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-border/60 px-5 py-4">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-highlight/15 text-highlight">
            <SparklesIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-[15px]">
              {mode === 'api' ? 'New API' : 'New operation'}
            </DialogTitle>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
              {mode === 'api'
                ? 'Name the API and describe its first operation — the agent builds it.'
                : scopedLabel
                  ? 'Describe what this operation should do — the agent builds it.'
                  : 'Pick where it lives and describe what it should do.'}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          {/* API name (api mode) */}
          {mode === 'api' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                API name
              </label>
              <Input
                value={apiName}
                onChange={(e) => setApiName(e.target.value)}
                placeholder="e.g. Billing"
                autoFocus
              />
              {apiName.trim() && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  → <span className="text-foreground/80">{apiSlug || '—'}</span>
                </span>
              )}
            </div>
          )}

          {/* Target (operation mode) — a static chip when scoped, a picker otherwise */}
          {mode === 'operation' &&
            (scopedLabel ? (
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <span>in</span>
                <span className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-secondary/40 px-2 py-1 font-mono text-[12px] text-foreground">
                  <FolderIcon className="size-3.5 text-muted-foreground" />
                  {scopedLabel}
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Location
                </label>
                <Popover open={locationPickerOpen} onOpenChange={setLocationPickerOpen}>
                  <PopoverTrigger asChild>
                    <Input
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      onFocus={() => setLocationPickerOpen(true)}
                      placeholder="e.g. billing/charges"
                    />
                  </PopoverTrigger>
                  {locations.length > 0 && (
                    <PopoverContent className="w-72 p-0" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
                      <Command>
                        <CommandList>
                          <CommandEmpty>No existing locations.</CommandEmpty>
                          <CommandGroup>
                            {locations
                              .filter((l) => l.toLowerCase().includes(location.toLowerCase()))
                              .map((l) => (
                                <CommandItem
                                  key={l}
                                  value={l}
                                  onSelect={() => {
                                    setLocation(l);
                                    setLocationPickerOpen(false);
                                  }}
                                >
                                  <FolderIcon className="size-3.5" />
                                  {l}
                                </CommandItem>
                              ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  )}
                </Popover>
              </div>
            ))}

          {/* Goal */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {mode === 'api' ? 'What should its first operation do?' : 'What should this operation do?'}
            </label>
            <textarea
              ref={goalRef}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Describe the goal in plain language — the agent picks the method, path, and nodes."
              rows={5}
              className={cn(
                'w-full resize-none rounded-md border border-input bg-input/30 px-3 py-2.5 text-[13.5px] leading-relaxed text-foreground shadow-xs outline-none transition-colors',
                'placeholder:text-muted-foreground selection:bg-highlight selection:text-highlight-foreground',
                'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
              )}
            />
            {/* Example prompts */}
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              <span className="text-[11px] text-muted-foreground/70">Try:</span>
              {examples.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => {
                    setGoal(ex);
                    goalRef.current?.focus();
                  }}
                  className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-highlight/50 hover:text-foreground"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border/60 px-5 py-3.5">
          <span className="text-[11px] text-muted-foreground">
            {mode === 'operation' && !scopedLabel ? null : (
              <>
                Builds in{' '}
                <span className="font-mono text-foreground/70">{targetLocation || '…'}</span>
              </>
            )}
          </span>
          <div className="flex items-center gap-2">
            <span className="hidden text-[10px] text-muted-foreground/60 sm:inline">⌘⏎</span>
            <Button size="sm" onClick={submit} disabled={!canSubmit}>
              <SparklesIcon /> {agentRunning ? 'Agent running…' : 'Create with AI'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
