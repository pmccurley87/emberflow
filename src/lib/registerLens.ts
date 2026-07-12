import type { LogLine } from '../engine';

/**
 * The register lens: every simple-vs-technical presentation decision lives
 * here, so the run console, dock, and Inspector cannot drift apart. One event
 * stream, two projections — simple hides mechanism (debug receipts, exact
 * timings, raw payload walls), never consequence (warn/error lines, effects,
 * environment state are identical in both registers).
 */
export type ViewRegister = 'simple' | 'technical';

export function filterLogs(logs: LogLine[], register: ViewRegister): LogLine[] {
  if (register === 'technical') return logs;
  return logs.filter((l) => l.level !== 'debug');
}

export function formatDuration(ms: number, register: ViewRegister): string {
  if (register === 'technical') {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
  }
  if (ms < 10) return '<10ms';
  if (ms < 1000) {
    // 995–999 round up to 1000 — hand those to the seconds branch so the
    // display never reads '1000ms' beside '1.0s'.
    const rounded = Math.round(ms / 10) * 10;
    return rounded >= 1000 ? `${(rounded / 1000).toFixed(1)}s` : `${rounded}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export function payloadOpenByDefault(register: ViewRegister): boolean {
  return register === 'technical';
}

/** The first sentence of a node description — a cheap plain-reading fallback
 * for nodes that haven't been given a `simpleDescription` yet. */
export function firstSentence(text: string): string {
  return text ? text.split('.')[0].trim() : '';
}

/** Simple-register description line for a node: its authored plain-language
 * one-liner, or the first sentence of the technical description, honest empty
 * string when neither exists. */
export function simpleNodeDescription(definition: { description?: string; simpleDescription?: string } | undefined): string {
  return definition?.simpleDescription ?? firstSentence(definition?.description ?? '');
}

export function keyValueRows(value: unknown): Array<{ key: string; display: string; complex: boolean }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([key, v]) => {
    if (Array.isArray(v)) return { key, display: `[${v.length} items]`, complex: true };
    if (v !== null && typeof v === 'object') {
      return { key, display: `{${Object.keys(v).length} keys}`, complex: true };
    }
    const raw = String(v);
    const display = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
    return { key, display, complex: false };
  });
}
