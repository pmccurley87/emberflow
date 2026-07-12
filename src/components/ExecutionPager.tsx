import { useEffect, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ExecutionRecord } from '../engine';

const statusDot: Record<string, string> = {
  succeeded: 'bg-success',
  failed: 'bg-destructive',
};

/**
 * Browsable header + body over a loop-body node's `ExecutionRecord[]`.
 * Selection is uncontrolled and defaults to (and snaps back to) the last
 * record whenever the records array grows — i.e. a new run/iteration.
 */
export function ExecutionPager({
  executions,
  children,
  className,
}: {
  executions: ExecutionRecord[];
  children: (record: ExecutionRecord, index: number) => React.ReactNode;
  className?: string;
}) {
  const [index, setIndex] = useState(executions.length - 1);

  useEffect(() => {
    setIndex(executions.length - 1);
  }, [executions.length]);

  const safeIndex = Math.min(Math.max(index, 0), executions.length - 1);
  const record = executions[safeIndex];
  if (!record) return null;

  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
          disabled={safeIndex === 0}
          onClick={() => setIndex(safeIndex - 1)}
          aria-label="Previous execution"
        >
          <ChevronLeftIcon className="size-3.5" />
        </Button>
        <span className={cn('size-1.5 shrink-0 rounded-full', statusDot[record.status])} />
        <span className="font-mono text-[11px] text-muted-foreground">
          {safeIndex + 1}/{executions.length}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
          disabled={safeIndex === executions.length - 1}
          onClick={() => setIndex(safeIndex + 1)}
          aria-label="Next execution"
        >
          <ChevronRightIcon className="size-3.5" />
        </Button>
      </div>
      {children(record, safeIndex)}
    </div>
  );
}
