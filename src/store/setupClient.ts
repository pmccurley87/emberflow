/**
 * Client for the first-run onboarding aggregate (GET /setup-status), reached
 * through the Vite proxy at /api → 127.0.0.1:8092, same-origin as
 * agentClient.ts/serverRunner.ts. Powers the Welcome checklist.
 *
 * NOTE ON DUPLICATION: the browser bundle can't import from server/, so
 * SetupStatus mirrors the shape server/index.ts's /setup-status returns. Keep
 * it in sync by hand if the server payload changes.
 */

import type { DetectedAgent } from './agentClient';

const BASE = '/api';

export interface SetupStatus {
  agents: DetectedAgent[];
  environments: {
    configured: boolean;
    count: number;
    protectedCount: number;
    anyAuthConfigured: boolean;
  };
  skills: { claude: boolean; codex: boolean };
  language: string;
  ops: { count: number; onlyHello: boolean };
  servingMode: 'real' | 'mock';
  /** Phase 3 fills scannedAt/itemCount and flips `present`. */
  infrastructure: { present: boolean; scannedAt?: string; itemCount?: number };
}

/** GET /setup-status — returns null when the runner is unreachable. */
export async function fetchSetupStatus(): Promise<SetupStatus | null> {
  try {
    const response = await fetch(`${BASE}/setup-status`);
    if (!response.ok) return null;
    return (await response.json()) as SetupStatus;
  } catch {
    return null;
  }
}
