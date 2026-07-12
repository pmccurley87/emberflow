import { describe, expect, it } from 'vitest';
import { filterLogs, firstSentence, formatDuration, keyValueRows, payloadOpenByDefault, simpleNodeDescription } from './registerLens';
import type { LogLine } from '../engine';

const line = (level: LogLine['level'], message: string): LogLine => ({
  timestamp: '2026-07-04T00:00:00Z', level, runId: 'r1', nodeId: 'n1', nodeLabel: 'N', message,
});

describe('filterLogs', () => {
  const logs = [line('debug', '#1 ▶ execute'), line('info', 'ok'), line('warn', 'careful'), line('error', 'boom')];
  it('simple drops debug only — warn/error always survive', () => {
    expect(filterLogs(logs, 'simple').map((l) => l.level)).toEqual(['info', 'warn', 'error']);
  });
  it('technical keeps everything', () => {
    expect(filterLogs(logs, 'technical')).toHaveLength(4);
  });
});

describe('formatDuration', () => {
  it('simple rounds calm', () => {
    expect(formatDuration(337, 'simple')).toBe('340ms');
    expect(formatDuration(4636, 'simple')).toBe('4.6s');
    expect(formatDuration(4, 'simple')).toBe('<10ms');
    expect(formatDuration(997, 'simple')).toBe('1.0s');
  });
  it('technical stays exact', () => {
    expect(formatDuration(337, 'technical')).toBe('337ms');
    expect(formatDuration(4636, 'technical')).toBe('4.64s');
  });
});

describe('payloadOpenByDefault', () => {
  it('simple collapsed, technical open', () => {
    expect(payloadOpenByDefault('simple')).toBe(false);
    expect(payloadOpenByDefault('technical')).toBe(true);
  });
});

describe('keyValueRows', () => {
  it('primitives, truncation, and shape summaries', () => {
    const rows = keyValueRows({
      surplus: 2500, ok: true, note: 'x'.repeat(150),
      series: [1, 2, 3], nested: { a: 1, b: 2 },
    });
    expect(rows[0]).toEqual({ key: 'surplus', display: '2500', complex: false });
    expect(rows[1]).toEqual({ key: 'ok', display: 'true', complex: false });
    expect(rows[2].display.endsWith('…')).toBe(true);
    expect(rows[2].display.length).toBe(121);
    expect(rows[3]).toEqual({ key: 'series', display: '[3 items]', complex: true });
    expect(rows[4]).toEqual({ key: 'nested', display: '{2 keys}', complex: true });
  });
  it('non-object input yields empty list', () => {
    expect(keyValueRows(null)).toEqual([]);
    expect(keyValueRows('str')).toEqual([]);
  });
});

describe('firstSentence', () => {
  it('takes the text before the first period', () => {
    expect(firstSentence('Loads the thing. PORT NOTE: mechanism detail.')).toBe('Loads the thing');
  });
  it('empty input yields empty output', () => {
    expect(firstSentence('')).toBe('');
  });
});

describe('simpleNodeDescription', () => {
  it('prefers an authored simpleDescription over the technical one', () => {
    expect(simpleNodeDescription({ description: 'Verbatim port of X. Mechanism.', simpleDescription: 'Does the thing' })).toBe(
      'Does the thing',
    );
  });
  it('falls back to the first sentence of description when absent', () => {
    expect(simpleNodeDescription({ description: 'Does the thing. Mechanism detail.' })).toBe('Does the thing');
  });
  it('is empty for an undefined definition', () => {
    expect(simpleNodeDescription(undefined)).toBe('');
  });
});
