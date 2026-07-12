import type { NodeRegistry } from '../engine';

/**
 * ForEach / Collect loop-region nodes. Iteration itself is owned by the
 * executor (see FlowRun's loop machinery in ../engine/executor.ts) — these
 * implementations exist so the node type is registered (canvas palette,
 * schema-driven inspector fields, isolated single-node runs) and so an
 * isolated run of just this node doesn't crash. In a real flow run the
 * executor never calls these; it drives iteration itself and writes
 * per-iteration / final output directly onto the node's run state.
 */
export function registerLoopNodes(registry: NodeRegistry): void {
  registry.register(
    {
      type: 'ForEach',
      label: 'For Each',
      description:
        'Iterates over an array, running the downstream loop body once per item (or per batch). Paired with exactly one Collect node.',
      simpleDescription: 'Repeats the next steps for each item in a list',
      category: 'flow',
      traceKind: 'compute',
      tags: ['branching', 'loop'],
      inputSchema: {
        fields: [{ name: 'items', type: 'array', required: true }],
      },
      configSchema: {
        fields: [
          { name: 'batchSize', type: 'number', description: 'Items per iteration (default 1).' },
          { name: 'maxIterations', type: 'number', description: 'Optional cap; extra iterations are truncated with a warning.' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'item', type: 'object', description: 'Single element (batchSize 1) or a chunk array otherwise.' },
          { name: 'index', type: 'number' },
          { name: 'total', type: 'number' },
        ],
      },
    },
    // Passthrough stub only — the executor owns real iteration and never
    // invokes this for a node of type ForEach inside a valid loop region.
    async (ctx) => ctx.input,
  );

  registry.register(
    {
      type: 'Collect',
      label: 'Collect',
      description:
        'Gathers each loop iteration\'s mapped value into an array once its paired ForEach finishes iterating.',
      simpleDescription: 'Collects the results from the repeated steps into a list',
      category: 'flow',
      traceKind: 'compute',
      tags: ['loop'],
      inputSchema: {
        fields: [{ name: 'value', type: 'object', required: false }],
      },
      outputSchema: {
        fields: [
          { name: 'items', type: 'array' },
          { name: 'count', type: 'number' },
        ],
      },
    },
    // Stub — the executor overrides this with the accumulated results in a
    // real run. Only exercised for an isolated run of this node in isolation.
    async () => ({ items: [], count: 0 }),
  );
}
