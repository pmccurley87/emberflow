import type { NodeRegistry } from '../engine';

/**
 * Terminal node for an HTTP operation: its input `{ status, body }` becomes
 * the HTTP response `extractResponse` (server/operationResult.ts) maps onto
 * the wire. `status` defaults to 200 when the input omits it. Pure — no
 * side effects, so no `effects: 'mutation'` declaration.
 */
export function registerResponseNodes(registry: NodeRegistry): void {
  registry.register(
    {
      type: 'Response',
      label: 'Response',
      description:
        'Terminal node for an HTTP operation: its input { status, body } becomes the HTTP response. Omit status to default to 200.',
      simpleDescription: 'Shapes the HTTP response for this operation',
      category: 'http',
      traceKind: 'compute',
      tags: ['http'],
      inputSchema: {
        fields: [
          { name: 'status', type: 'number' },
          { name: 'body', type: 'object' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'status', type: 'number' },
          { name: 'body', type: 'object' },
        ],
      },
    },
    async (ctx) => {
      const input = (ctx.input ?? {}) as { status?: unknown; body?: unknown };
      const status = typeof input.status === 'number' ? input.status : 200;
      return { status, body: input.body };
    },
  );
}
