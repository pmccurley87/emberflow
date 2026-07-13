import { useEffect, useState } from 'react';
import { ArrowUpIcon, SparklesIcon, XIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useBuilderStore } from '../store/builderStore';
import { AgentStream } from './AgentStream';


const statusDot: Record<string, string> = {
  running: 'bg-highlight animate-pulse',
  done: 'bg-success',
  error: 'bg-destructive',
};

/**
 * Docked panel that streams a studio-triggered coding-agent run. Presents it
 * the way Codex/Claude present their own work: the agent's reasoning is the
 * content (comfortable prose), commands collapse to quiet one-liners you can
 * expand, and background diagnostics (MCP/hook noise) are tucked into a count
 * (all via the shared <AgentStream>). Then the diff with a Revert button once
 * the run finishes.
 */
export function AgentConsole({ onDismiss }: { onDismiss: () => void }) {
  const agentRun = useBuilderStore((s) => s.agentRun);
  const revertAgentRun = useBuilderStore((s) => s.revertAgentRun);
  const runAgent = useBuilderStore((s) => s.runAgent);
  const flowId = useBuilderStore((s) => s.flow.id);
  const flowName = useBuilderStore((s) => s.flow.name);
  const envSetup = useBuilderStore((s) => s.agentEnvSetup);
  const [instruction, setInstruction] = useState('');
  const running = agentRun?.status === 'running';

  // Slide in from the right on mount: start translated off-screen, then flip to
  // 0 on the next frame so the transition runs. (A CSS keyframe races the
  // resizable panel's JS-driven width and often no-ops; this is reliable.)
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, []);

  const send = () => {
    const text = instruction.trim();
    if (!text || running) return;
    // Chat drives the OPEN operation — unless the panel was opened from the
    // Environments dialog, in which case it drives environment setup and
    // follow-ups keep refining the environments file.
    if (envSetup) {
      void runAgent({ action: 'setup-environments', instruction: text });
    } else {
      // One input, no modes: the edit-flow prompt classifies the message —
      // questions get answered read-only, change requests get edited. The
      // explicit `ask` intent still exists for programmatic callers.
      void runAgent({ action: 'edit-flow', flowId, instruction: text });
    }
    setInstruction('');
  };

  const finished = agentRun != null && agentRun.status !== 'running';

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden border-l border-border bg-card transition-transform duration-200 ease-out motion-reduce:transition-none',
        entered ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border/70 px-3.5">
        <span className={cn('size-2 rounded-full', agentRun ? statusDot[agentRun.status] : 'bg-muted-foreground/40')} />
        <span className="min-w-0 truncate text-[12.5px] font-medium">
          {envSetup ? 'Agent — environments' : 'Agent'}
        </span>
        {agentRun && (
          <Badge variant="outline" className="shrink-0 text-[9px] uppercase">
            {agentRun.status}
          </Badge>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
          aria-label="Dismiss agent console"
        >
          <XIcon className="size-3.5" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3.5 py-3">
        {/* Your message — the instruction you sent, shown first like a chat. */}
        {agentRun?.instruction && (
          <div className="mb-1 flex justify-end">
            <div className="max-w-[90%] rounded-lg rounded-br-sm bg-highlight/15 px-2.5 py-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground">
              {agentRun.instruction}
            </div>
          </div>
        )}
        {!agentRun && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <span className="flex size-9 items-center justify-center rounded-full bg-highlight/12 text-highlight">
              <SparklesIcon className="size-4" />
            </span>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              {envSetup ? (
                <>
                  Describe the environments this project should have — dev? prod? test? Base URLs
                  and which ones are protected. The agent writes the config; secret values stay
                  yours to add afterwards.
                </>
              ) : (
                <>
                  Ask the agent to change <span className="text-foreground/80">{flowName}</span>. It edits the
                  operation — adding nodes, wiring, or a new registered node — and the canvas updates live when it’s done.
                </>
              )}
            </p>
          </div>
        )}
        {agentRun && <AgentStream events={agentRun.events} running={running} />}
      </div>

      {finished && agentRun && (agentRun.diff !== undefined || agentRun.status === 'error') && (
        <div className="min-h-0 shrink-0 border-t border-border/70">
          <div className="max-h-64 overflow-auto p-3">
            {agentRun.diff ? (
              <>
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                  Changes{agentRun.files && agentRun.files.length > 0 ? ` · ${agentRun.files.join(', ')}` : ''}
                </div>
                <pre className="overflow-auto rounded-md border border-border bg-background/40 p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap">
                  {agentRun.diff}
                </pre>
              </>
            ) : (
              <div className="text-[12px] text-muted-foreground/70">No changes were made.</div>
            )}
          </div>
        </div>
      )}

      {/* Revert stays available after a completed change. */}
      {finished && agentRun && agentRun.status === 'done' && agentRun.diff && (
        <div className="flex shrink-0 items-center border-t border-border/70 px-3.5 py-1.5">
          <Button variant="destructive" size="sm" onClick={() => void revertAgentRun()}>
            Revert last change
          </Button>
        </div>
      )}

      {/* Persistent chat input — the way to drive the open operation. */}
      <footer className="shrink-0 border-t border-border/70 p-2.5">
        <div className="flex items-end gap-2">
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                send();
              }
            }}
            disabled={running}
            placeholder={
              running
                ? 'Agent is working…'
                : envSetup
                  ? 'e.g. dev on localhost:3001, prod at api.example.com (protected)'
                  : `Ask about ${flowName}, or tell the agent what to change…`
            }
            rows={2}
            className="min-h-0 flex-1 resize-none rounded-md border border-input bg-input/30 px-2.5 py-1.5 text-[12.5px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
          />
          <Button
            size="icon"
            className="size-8 shrink-0"
            onClick={send}
            disabled={running || !instruction.trim()}
            aria-label="Send to agent"
            title="Send (⌘⏎)"
          >
            <ArrowUpIcon className="size-4" />
          </Button>
        </div>
      </footer>
    </div>
  );
}
