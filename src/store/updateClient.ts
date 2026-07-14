/**
 * Client for the package update notifier (GET /update-status) and one-click
 * updater (POST /update), reached through the Vite proxy at /api →
 * 127.0.0.1:8092 — same-origin pattern as setupClient.ts.
 *
 * Shapes mirror server/index.ts's /update-status and /update responses by
 * hand (the browser bundle can't import from server/).
 */

const BASE = '/api';

export interface UpdateStatus {
  current: string;
  /** Absent when the registry check was unavailable. */
  latest?: string;
  updateAvailable: boolean;
}

export interface UpdateResult {
  ok: boolean;
  /** True after a successful install — the runner must restart to pick it up. */
  restartRequired?: boolean;
  error?: string;
}

/** GET /update-status — null when the runner is unreachable or errors. */
export async function fetchUpdateStatus(): Promise<UpdateStatus | null> {
  try {
    const response = await fetch(`${BASE}/update-status`);
    if (!response.ok) return null;
    return (await response.json()) as UpdateStatus;
  } catch {
    return null;
  }
}

/** POST /update — runs npm install on the runner. Never throws. */
export async function postUpdate(): Promise<UpdateResult> {
  try {
    const response = await fetch(`${BASE}/update`, { method: 'POST' });
    const body = (await response.json().catch(() => ({}))) as UpdateResult;
    return {
      ok: response.ok && body.ok === true,
      ...(body.restartRequired !== undefined ? { restartRequired: body.restartRequired } : {}),
      ...(body.error !== undefined ? { error: body.error } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Update request failed' };
  }
}
