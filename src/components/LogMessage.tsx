import { useEffect, useMemo, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { Json } from './Json';

/**
 * Log message renderer: when a message embeds a JSON payload (engine nodes
 * log `Some prefix: {...}`), the payload renders as a collapsible
 * syntax-highlighted block under the prose instead of a wall of escaped
 * text. Plain messages pass through untouched.
 */

/** Split "prefix {json}" → { prefix, value } when the tail parses as JSON. */
export function splitJsonTail(message: string): { prefix: string; value: unknown } | null {
  for (const opener of ['{', '[']) {
    const at = message.indexOf(opener);
    if (at === -1) continue;
    const tail = message.slice(at).trim();
    if (tail.length < 12) continue; // tiny fragments read fine inline
    try {
      const value = JSON.parse(tail);
      if (value !== null && typeof value === 'object') {
        return { prefix: message.slice(0, at).trimEnd(), value };
      }
    } catch {
      // fall through — try the other opener or give up
    }
  }
  return null;
}

export function LogMessage({ message, defaultOpen = true }: { message: string; defaultOpen?: boolean }) {
  const parsed = useMemo(() => splitJsonTail(message), [message]);
  const [open, setOpen] = useState(defaultOpen);
  // Register flips mid-session must apply to already-rendered lines, not just
  // new ones — re-sync local open state whenever the caller's default changes.
  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);
  if (!parsed) {
    return <span className="min-w-0 whitespace-pre-wrap break-words text-muted-foreground">{message}</span>;
  }
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <span className="min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex cursor-pointer items-baseline gap-1 text-left text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={open}
      >
        <Chevron className="size-3 shrink-0 self-center opacity-60" />
        <span className="whitespace-pre-wrap break-words">{parsed.prefix || 'payload'}</span>
      </button>
      {open && (
        <div className="mt-1 mb-0.5">
          <Json value={parsed.value} maxHeight={240} />
        </div>
      )}
    </span>
  );
}
