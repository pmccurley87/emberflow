import { describe, expect, it } from 'vitest';
import { InMemoryTraceSink } from './trace';
import type { NodeExecutionSample } from './types';

const sample = (id: string, nodeId: string): NodeExecutionSample => ({
  id, workflowId: 'w', runId: 'r', nodeId, nodeType: 't', nodeLabel: 'T',
  input: { id }, status: 'succeeded', startedAt: '2026-01-01T00:00:00Z',
});

describe('InMemoryTraceSink', () => {
  it('records and filters by node, newest first', () => {
    const sink = new InMemoryTraceSink();
    sink.record(sample('s1', 'a'));
    sink.record(sample('s2', 'b'));
    sink.record(sample('s3', 'a'));
    expect(sink.samplesFor('a').map((s) => s.id)).toEqual(['s3', 's1']);
    expect(sink.all().map((s) => s.id)).toEqual(['s3', 's2', 's1']);
  });
});
