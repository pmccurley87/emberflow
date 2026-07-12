import type { NodeExecutionSample } from './types';

export interface TraceSink {
  record(sample: NodeExecutionSample): void;
  samplesFor(nodeId: string): NodeExecutionSample[];
  all(): NodeExecutionSample[];
}

export class InMemoryTraceSink implements TraceSink {
  private samples: NodeExecutionSample[] = [];

  record(sample: NodeExecutionSample): void {
    this.samples.push(sample);
  }

  samplesFor(nodeId: string): NodeExecutionSample[] {
    return this.all().filter((s) => s.nodeId === nodeId);
  }

  all(): NodeExecutionSample[] {
    return [...this.samples].reverse();
  }
}
