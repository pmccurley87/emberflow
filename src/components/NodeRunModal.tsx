import { useEffect, useMemo, useState } from 'react';
import { Loader2Icon, PinIcon, PlayIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useBuilderStore } from '../store/builderStore';
import { fetchSamples } from '../store/serverRunner';
import { Json } from './Json';
import { cn } from '@/lib/utils';
import type { LogLine, NodeExecutionSample, WorkflowNode } from '../engine';

const levelColor: Record<string, string> = {
  info: 'text-success',
  debug: 'text-muted-foreground/60',
  warn: 'text-yellow-500',
  error: 'text-destructive',
};

interface RunResult {
  output?: unknown;
  error?: string;
  logs: LogLine[];
}

export function NodeRunModal({
  node,
  open,
  onOpenChange,
}: {
  node: WorkflowNode;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const trace = useBuilderStore((s) => s.trace);
  const run = useBuilderStore((s) => s.run);
  const runNodeIsolated = useBuilderStore((s) => s.runNodeIsolated);
  const pinNodeOutput = useBuilderStore((s) => s.pinNodeOutput);

  const [inputText, setInputText] = useState('{}');
  const [sourceValue, setSourceValue] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [pinnedThis, setPinnedThis] = useState(false);

  const localSamples = useMemo(
    () => (open ? trace.samplesFor(node.id) : []),
    [open, trace, node.id],
  );
  const [samples, setSamples] = useState<NodeExecutionSample[]>([]);

  useEffect(() => {
    if (!open) {
      setSamples(localSamples);
      return;
    }
    if (!useBuilderStore.getState().runnerOnline) {
      setSamples(localSamples);
      return;
    }
    let cancelled = false;
    fetchSamples(node.id).then((remote) => {
      if (cancelled) return;
      const byId = new Map<string, NodeExecutionSample>();
      for (const sample of [...localSamples, ...remote]) byId.set(sample.id, sample);
      const merged = [...byId.values()].sort(
        (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );
      setSamples(merged);
    });
    return () => {
      cancelled = true;
    };
  }, [open, node.id, localSamples]);

  const lastRunInput = run?.nodeStates[node.id]?.input;

  const sourceOptions = [
    ...(lastRunInput !== undefined
      ? [{ value: '__lastRun__', label: 'From last run' }]
      : []),
    ...samples.map((s) => ({
      value: s.id,
      label: `${new Date(s.startedAt).toLocaleTimeString()} · ${s.status}${s.runId.startsWith('isolated') ? ' · isolated' : ''}`,
      group: 'Previous executions',
    })),
  ];

  const applySource = (value: string) => {
    setSourceValue(value);
    if (value === '__lastRun__' && lastRunInput !== undefined) {
      setInputText(JSON.stringify(lastRunInput, null, 2));
      return;
    }
    const sample = samples.find((s) => s.id === value);
    if (sample) setInputText(JSON.stringify(sample.input ?? {}, null, 2));
  };

  const execute = async () => {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(inputText) as Record<string, unknown>;
    } catch (err) {
      setResult({ error: `Input is not valid JSON: ${err instanceof Error ? err.message : ''}`, logs: [] });
      return;
    }
    setRunning(true);
    setPinnedThis(false);
    try {
      setResult(await runNodeIsolated(node.id, input));
    } finally {
      setRunning(false);
    }
  };

  const pinResult = () => {
    if (result?.output === undefined) return;
    pinNodeOutput(node.id, result.output);
    setPinnedThis(true);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogTitle className="flex items-center gap-2">
          Run node
          <span className="text-muted-foreground">·</span> {node.label}
          <Badge variant="mono">{node.type}</Badge>
        </DialogTitle>
        <DialogDescription>
          Executes this node alone against the input below. The execution is captured as a
          replayable sample.
        </DialogDescription>

        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Input
          </span>
          <div className="ml-auto w-72">
            <Combobox
              options={sourceOptions}
              value={sourceValue}
              onChange={applySource}
              placeholder="Manual input"
              searchPlaceholder="Search captured inputs…"
              emptyText="No captured executions yet."
              clearLabel="Manual input"
            />
          </div>
        </div>
        <textarea
          value={inputText}
          onChange={(e) => {
            setInputText(e.target.value);
            setSourceValue('');
          }}
          spellCheck={false}
          rows={8}
          className="w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-relaxed outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]"
        />

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={execute} disabled={running}>
            {running ? <Loader2Icon className="animate-spin" /> : <PlayIcon />} Run node
          </Button>
          {result?.output !== undefined && (
            <Button variant="secondary" size="sm" onClick={pinResult} disabled={pinnedThis}>
              <PinIcon /> {pinnedThis ? 'Pinned' : 'Pin this output'}
            </Button>
          )}
        </div>

        {result && (
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-hidden">
            <div className="min-h-0 overflow-auto">
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                {result.error ? 'Error' : 'Output'}
              </div>
              {result.error ? (
                <pre className="overflow-auto rounded-md border border-destructive/50 p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-destructive-foreground">
                  {result.error}
                </pre>
              ) : (
                <Json value={result.output} />
              )}
            </div>
            <div className="min-h-0 overflow-auto">
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                Logs
              </div>
              {result.logs.length === 0 && (
                <div className="text-[12px] text-muted-foreground/60">No log output.</div>
              )}
              {result.logs.map((line, i) => (
                <div key={i} className="flex items-baseline gap-2 py-0.5 font-mono text-[11px]">
                  <span
                    className={cn(
                      'w-10 shrink-0 text-[9.5px] uppercase tracking-wider',
                      levelColor[line.level],
                    )}
                  >
                    {line.level}
                  </span>
                  <span className="text-muted-foreground">{line.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
