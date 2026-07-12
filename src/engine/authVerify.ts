// Browser-safe auth verification core. Lives here (not under server/auth/)
// because src/nodes/requireAuth.ts (bundled into the studio browser build via
// src/store/builderStore.ts -> src/nodes) must not import from server/. The
// server-side enforce.ts + verifiers.ts re-export/wrap this module so there's
// a single implementation instead of two diverging copies.
import { HttpError } from './httpError';
import type { AuthPolicy } from './types';

export interface VerifyResult {
  user: unknown;
}

/** Given the request + the resolved secret value, return a user or throw HttpError(401). */
export type Verifier = (args: {
  request: { headers: Record<string, unknown> };
  policy: AuthPolicy;
  secret: string | undefined;
}) => VerifyResult;

const bearerToken = (headers: Record<string, unknown>): string | undefined => {
  const raw = headers['authorization'] ?? headers['Authorization'];
  if (typeof raw !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m ? m[1] : undefined;
};

// Note: a plain string comparison is used here rather than a timing-safe
// comparison; timing-safe comparison is a later hardening item.
export const bearerVerifier: Verifier = ({ request, secret }) => {
  if (secret === undefined) throw new HttpError(500, { error: 'auth misconfigured: secret not set' });
  const token = bearerToken(request.headers);
  if (!token || token !== secret) throw new HttpError(401, { error: 'unauthorized' });
  return { user: { scheme: 'bearer' } };
};

export const apiKeyVerifier: Verifier = ({ request, policy, secret }) => {
  if (secret === undefined) throw new HttpError(500, { error: 'auth misconfigured: secret not set' });
  const headerName = (policy.header ?? 'x-api-key').toLowerCase();
  const provided = request.headers[headerName];
  if (typeof provided !== 'string' || provided !== secret) throw new HttpError(401, { error: 'unauthorized' });
  return { user: { scheme: 'apiKey' } };
};

export class VerifierRegistry {
  private map = new Map<string, Verifier>();
  register(name: string, v: Verifier): void {
    this.map.set(name, v);
  }
  get(name: string): Verifier | undefined {
    return this.map.get(name);
  }
}

export function createDefaultVerifierRegistry(): VerifierRegistry {
  const reg = new VerifierRegistry();
  reg.register('bearer', bearerVerifier);
  reg.register('apiKey', apiKeyVerifier);
  return reg;
}

/**
 * Picks the verifier (policy.verify ? verifiers.get(policy.verify) : verifiers.get(policy.scheme)),
 * fails closed with HttpError(500) if it's missing, resolves the secret from
 * `secrets[policy.secretRef]`, and runs the verifier (its HttpError, if any, propagates).
 */
export function enforceAuth(args: {
  policy: AuthPolicy;
  request: { headers: Record<string, unknown> };
  secrets: Record<string, unknown>;
  verifiers: VerifierRegistry;
}): VerifyResult {
  const { policy, request, secrets, verifiers } = args;
  const verifierName = policy.verify ?? policy.scheme;
  const verifier = policy.verify ? verifiers.get(policy.verify) : verifiers.get(policy.scheme);
  if (!verifier) {
    throw new HttpError(500, { error: `auth misconfigured: no verifier ${verifierName}` });
  }
  const rawSecret = secrets[policy.secretRef];
  const secret = typeof rawSecret === 'string' ? rawSecret : undefined;
  return verifier({ request, policy, secret });
}
