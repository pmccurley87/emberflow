import { useState } from 'react';
import { SparklesIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { InfraPanel } from './InfraPanel';
import { useBuilderStore } from '../store/builderStore';
import type { InfrastructureResponse } from '../store/infraClient';

/**
 * Relative "scouted N ago" for the manifest's scannedAt. Tolerant of an absent
 * or unparseable timestamp (returns null → the freshness line is hidden).
 */
export function formatScoutedAt(scannedAt: string | undefined, now: number = Date.now()): string | null {
  if (!scannedAt) return null;
  const then = new Date(scannedAt).getTime();
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return 'scouted just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `scouted ${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `scouted ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `scouted ${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * "Project infrastructure" modal, opened from the StatusBar infra chip. Explains
 * what the scout found and — crucially — WHY it matters: agents read this
 * manifest before building operations and REUSE these systems (same secret
 * names, same services) instead of inventing parallel config. Reuses the
 * presentational InfraPanel for the item list (one source of truth) with the
 * per-kind gloss enabled, and offers a free-text "Update with AI" amendment.
 */
export function InfrastructureDialog({
  open,
  onOpenChange,
  data,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: InfrastructureResponse | null;
}) {
  const beginInfrastructureScout = useBuilderStore((s) => s.beginInfrastructureScout);
  const [instruction, setInstruction] = useState('');

  const freshness =
    data && data.present ? formatScoutedAt(data.manifest.scannedAt) : null;

  const submitUpdate = () => {
    const value = instruction.trim();
    onOpenChange(false);
    setInstruction('');
    // Empty → full rescan; free text → a targeted amendment. Both dispatch the
    // scout intent, which opens the agent panel so the run is visible.
    beginInfrastructureScout(value.length > 0 ? value : undefined);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>Project infrastructure</DialogTitle>
        <DialogDescription>
          Discovered by the scout from this project's code. Agents read this before building
          operations and{' '}
          <span className="font-medium text-foreground/90">
            reuse these systems — same secret names, same services — instead of inventing parallel
            config.
          </span>
        </DialogDescription>

        {freshness && (
          <p className="text-[11px] text-muted-foreground/70">{freshness}</p>
        )}

        <div className="max-h-[55vh] overflow-y-auto pr-0.5">
          <InfraPanel data={data} explainKinds />
        </div>

        <div className="flex flex-col gap-1.5 border-t border-border/60 pt-3">
          <label htmlFor="infra-update" className="text-[11px] font-medium text-foreground/80">
            Update with AI
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="infra-update"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitUpdate();
                }
              }}
              placeholder="e.g. add our Redis cache, or remove the legacy Stripe entry…"
              className="h-8 text-[12px]"
            />
            <Button size="sm" onClick={submitUpdate}>
              <SparklesIcon className="size-3.5" />
              Update
            </Button>
          </div>
          <p className="text-[10.5px] text-muted-foreground/70">
            Leave empty to re-scan the whole project.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
