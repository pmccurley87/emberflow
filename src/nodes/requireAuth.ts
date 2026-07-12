import type { NodeRegistry } from '../engine';
import { createDefaultVerifierRegistry, enforceAuth } from '../engine';
import type { AuthPolicy } from '../engine';

/**
 * Explicit in-flow auth check. Config carries the AuthPolicy fields (scheme,
 * secretRef, verify?, header?). Reads the request off ctx.input (the
 * operation's incoming { headers, ... }) and the secret off ctx.secrets,
 * then reuses the same enforceAuth() the HTTP handler runs before the
 * operation body (server/httpOperations.ts via server/auth/enforce.ts) so
 * there is a single verify code path.
 *
 * Browser-safe: uses only src/engine (no server/ import), since src/nodes is
 * bundled into the studio browser build (src/store/builderStore.ts). Custom
 * verifiers registered server-side via project.registerVerifiers are a
 * server-enforcement concern; this node only has the default bearer/apiKey
 * verifiers (unless policy.verify happens to name one of those).
 *
 * Pure-read: throws HttpError(401/500) on failure, otherwise returns
 * { user } for downstream nodes to see. No side effects, so no
 * `effects: 'mutation'`.
 */
export function registerRequireAuthNode(registry: NodeRegistry): void {
  registry.register(
    {
      type: 'requireAuth',
      label: 'Require Auth',
      description:
        'Verifies the incoming request against an auth policy (bearer/apiKey shared-secret, or a named custom verifier) and attaches { user } for downstream nodes. Throws HttpError(401) on failure, HttpError(500) if misconfigured.',
      simpleDescription: 'Checks the request is authorized before continuing',
      category: 'http',
      traceKind: 'compute',
      tags: ['http', 'auth'],
      configSchema: {
        fields: [
          { name: 'scheme', type: 'string' },
          { name: 'secretRef', type: 'string' },
          { name: 'verify', type: 'string' },
          { name: 'header', type: 'string' },
        ],
      },
      outputSchema: {
        fields: [{ name: 'user', type: 'object' }],
      },
    },
    async (ctx) => {
      const policy = ctx.config as unknown as AuthPolicy;
      const input = (ctx.input ?? {}) as { headers?: Record<string, unknown> };
      const request = { headers: input.headers ?? {} };
      const verifiers = createDefaultVerifierRegistry();
      const { user } = enforceAuth({ policy, request, secrets: ctx.secrets, verifiers });
      return { user };
    },
  );
}
