import type { AgentKind } from './types';

const MODEL_REJECTION_RE =
  /unknown model|unsupported model|invalid model|model.*not.*(found|supported)|model requires a newer version/i;

/**
 * When an agent CLI exits nonzero without ever emitting a terminal `done`,
 * inspect its buffered stderr tail for known model-rejection shapes (a stale
 * CLI that doesn't recognize the requested model). Returns an actionable
 * hint to append to the error event text, or undefined when nothing matches.
 */
export function modelRejectionHint(kind: AgentKind, stderrTail: string): string | undefined {
  if (!MODEL_REJECTION_RE.test(stderrTail)) return undefined;
  return `hint: your ${kind} CLI may be too old for the selected model — upgrade it or switch backend in Settings.`;
}
