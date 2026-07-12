import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Chat-style tail anchoring for streaming log lists: follow the latest entry
 * only while the user is at (or near) the bottom. Scrolling up detaches the
 * follow; scrolling back within the threshold re-attaches it. `detached`
 * lets callers show a "jump to latest" affordance while new entries arrive
 * off-screen.
 */
export function useTailAnchor(
  count: number,
  options: { suspended?: boolean; threshold?: number } = {},
): {
  scrollerRef: (el: HTMLElement | null) => void;
  endRef: React.RefObject<HTMLDivElement | null>;
  detached: boolean;
  jumpToLatest: () => void;
} {
  const { suspended = false, threshold = 48 } = options;
  const atBottom = useRef(true);
  const scroller = useRef<HTMLElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [detached, setDetached] = useState(false);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
    atBottom.current = nearBottom;
    setDetached((d) => (d === !nearBottom ? d : !nearBottom));
  }, [threshold]);

  const scrollerRef = useCallback(
    (el: HTMLElement | null) => {
      scroller.current?.removeEventListener('scroll', onScroll);
      scroller.current = el;
      el?.addEventListener('scroll', onScroll, { passive: true });
    },
    [onScroll],
  );

  useEffect(() => {
    if (!suspended && atBottom.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [count, suspended]);

  const jumpToLatest = useCallback(() => {
    atBottom.current = true;
    setDetached(false);
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, []);

  return { scrollerRef, endRef, detached, jumpToLatest };
}
