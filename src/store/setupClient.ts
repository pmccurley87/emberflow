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
  /** Whether the project root is inside a git repo — agent features snapshot
   *  changes with git, so the checklist requires this before enabling them. */
  git: { repo: boolean };
  environments: {
    configured: boolean;
    count: number;
    protectedCount: number;
    anyAuthConfigured: boolean;
    /** CLIENT-side augmentation (never sent by the runner): the user chose
     *  "later" in guided setup, so the checklist row ticks as deferred
     *  instead of looking blocked. Cleared once environments are configured. */
    deferred?: boolean;
  };
  skills: { claude: boolean; codex: boolean };
  language: string;
  ops: { count: number; onlyHello: boolean };
  servingMode: 'real' | 'mock';
  /** Phase 3 fills scannedAt/itemCount and flips `present`. */
  infrastructure: { present: boolean; scannedAt?: string; itemCount?: number };
}

/**
 * Progress across the Welcome checklist's rows, mirrored from
 * deriveChecklist's per-row status logic. Powers the StatusBar setup chip;
 * keep in step if rows are added or their completion rules change.
 */
export function setupProgress(status: SetupStatus): { done: number; total: number } {
  // NOTE: secrets & auth deliberately have no row (matches deriveChecklist) —
  // they live in the Manage Environment dialog, not onboarding.
  const rows = [
    status.git.repo,
    status.agents.length > 0,
    status.environments.configured,
    status.skills.claude || status.skills.codex,
    status.infrastructure.present,
    status.ops.count > 1,
  ];
  return { done: rows.filter(Boolean).length, total: rows.length };
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
