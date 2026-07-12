import type { RequestHandler } from 'express';
import { enforceAuth, isHttpError, validateAgainstSchema, type AuthPolicy, type WorkflowDefinition } from '../src/engine';
import { extractResponse } from './operationResult';
import type { RunRegistry } from './runRegistry';
import type { VerifierRegistry } from './auth/verifiers';

/**
 * Build the Express handler for a single routed operation: request in
 * ({params, query, body, headers}), schema-validate the body, run the
 * operation through the SAME engine path the studio "Run" uses
 * (`RunRegistry`), map the finished run to an HTTP response.
 *
 * The run input is the request body's own fields spread at the top level
 * (so `from('input', 'ppv')` resolves a domain field posted in the body),
 * PLUS the full request shape (`params`/`query`/`body`/`headers`/`user`)
 * layered on top — the latter always wins on key collisions, and ops that
 * read `input.body.x` keep working unchanged.
 */
/** The environment values a routed operation runs with — resolved once at
 *  boot from the project's default environment (see server/index.ts). Falls
 *  back to empty secrets/vars when omitted (e.g. in unit tests). */
export interface OperationRunEnv {
  secrets: Record<string, string>;
  vars: Record<string, string>;
  environment: string;
  safeMode: boolean;
}

export function makeOperationHandler(deps: {
  runs: RunRegistry;
  op: WorkflowDefinition;
  env?: OperationRunEnv;
  policy?: AuthPolicy | null;
  verifiers?: VerifierRegistry;
}): RequestHandler {
  const { runs, op, policy, verifiers } = deps;
  const env: OperationRunEnv = deps.env ?? { secrets: {}, vars: {}, environment: 'default', safeMode: false };
  return async (req, res) => {
    const request = {
      params: req.params,
      query: req.query,
      body: req.body,
      headers: req.headers,
    };

    try {
      // Auth precedes validation: an unauthenticated/misconfigured request
      // never reaches schema validation or the run, and 401/500 from the
      // verifier is mapped by the HttpError branch below — never a generic
      // 500 that could imply the request otherwise would have run.
      let user: unknown;
      if (policy) {
        if (!verifiers) throw new Error('makeOperationHandler: policy set but no verifiers registry provided');
        ({ user } = enforceAuth({ policy, request, secrets: env.secrets, verifiers }));
      }

      const schema = op.http?.inputSchema;
      if (schema) {
        const error = validateAgainstSchema(schema, request.body);
        if (error !== null) {
          res.status(400).json({ error });
          return;
        }
      }

      // Promote the request body's fields to the top of the run input so
      // flows that read domain fields directly (`from('input', 'ppv')`)
      // resolve them, while keeping `body` (and params/query/headers/user)
      // available for ops that read `input.body.x`. Spread the body FIRST
      // so params/query/body/headers/user always win over a colliding key.
      const bodyFields =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const { handle } = runs.create(op, {
        ...env,
        input: { ...bodyFields, ...request, user },
      });
      const run = await handle.runToEnd();
      const { status, body } = extractResponse(run, op);
      res.status(status).json(body ?? null);
    } catch (err) {
      if (isHttpError(err)) {
        res.status(err.status).json(err.body ?? null);
        return;
      }
      // A node's thrown Error can carry secrets in its message (e.g. a DB
      // connection string or a URL with an API key) — never echo it to the
      // (currently unauthenticated) client. Log the real error server-side
      // and return a generic body instead. HttpError above stays the
      // sanctioned way for a node to control the client-visible status+body.
      console.error('[operation] run failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  };
}
