import { SparklesIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SetupStatus } from '../store/setupClient';

/** Set once the user takes the "explore the example" path — the empty state
 *  never returns. Building a second op dismisses it implicitly (onlyHello
 *  flips false), so no key write is needed on the create path. */
export const EMPTY_STATE_DISMISSED_KEY = 'emberflow.emptyState.dismissed';

/**
 * Post-onboarding empty state: a fresh project with only the hello example
 * shouldn't greet the user with someone else's op. Rendered centered in the
 * canvas INSTEAD of the runbook (see CenterView) while the project has only
 * the hello example and the user hasn't dismissed it. Prop-driven — the
 * component test drives it across states without a live store; CenterView
 * owns the store wiring and the welcome-dialog gate.
 */
export function EmptyState({
  status,
  dismissed,
  onCreate,
  onExplore,
}: {
  status: SetupStatus | null;
  dismissed: boolean;
  /** Opens the same New API modal as the sidebar's button (store's createModal). */
  onCreate: () => void;
  /** Records the dismissal and opens the hello example. */
  onExplore: () => void;
}) {
  if (!status?.ops.onlyHello || dismissed) return null;
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-highlight/15 text-highlight">
          <SparklesIcon className="size-4" />
        </span>
        <h2 className="text-[15px] font-semibold tracking-tight">Build your first API</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Describe what you want and the agent builds it — or explore the example first.
        </p>
        <div className="mt-1 flex items-center gap-2">
          <Button size="sm" onClick={onCreate}>
            <SparklesIcon className="size-3.5" />
            Create your first API
          </Button>
          <Button size="sm" variant="outline" disabled title="Coming soon">
            Start from a template
          </Button>
        </div>
        <button
          type="button"
          onClick={onExplore}
          className="mt-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Explore the hello example
        </button>
      </div>
    </div>
  );
}
