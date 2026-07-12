/**
 * Client for the infrastructure manifest (GET /infrastructure), reached through
 * the Vite proxy at /api → 127.0.0.1:8092, same-origin as setupClient.ts.
 * Powers the Dock's "Infra" tab.
 *
 * NOTE ON DUPLICATION: the browser bundle can't import from server/, so these
 * types mirror server/infrastructure.ts's InfrastructureManifest. Keep them in
 * sync by hand if the server shape changes.
 */

const BASE = '/api';

/** Mirrors server/infrastructure.ts's INFRASTRUCTURE_KINDS. */
export type InfrastructureKind =
  | 'database'
  | 'http-api'
  | 'queue'
  | 'cache'
  | 'email'
  | 'llm'
  | 'auth'
  | 'framework'
  | 'storage'
  | 'other';

export interface InfrastructureEvidence {
  file: string;
  note?: string;
}

export interface InfrastructureItem {
  id: string;
  kind: InfrastructureKind;
  name: string;
  evidence: InfrastructureEvidence[];
  suggestedSecretRefs: string[];
  suggestedVars: string[];
  notes?: string;
}

export interface InfrastructureManifest {
  version: number;
  scannedAt?: string;
  greenfield: boolean;
  summary?: string;
  items: InfrastructureItem[];
}

/** The GET /infrastructure response: `{present:false}` or `{present:true, manifest}`. */
export type InfrastructureResponse =
  | { present: false }
  | { present: true; manifest: InfrastructureManifest };

/** GET /infrastructure — returns null when the runner is unreachable. */
export async function fetchInfrastructure(): Promise<InfrastructureResponse | null> {
  try {
    const response = await fetch(`${BASE}/infrastructure`);
    if (!response.ok) return null;
    return (await response.json()) as InfrastructureResponse;
  } catch {
    return null;
  }
}
