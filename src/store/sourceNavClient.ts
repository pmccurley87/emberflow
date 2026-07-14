/**
 * Client for the runner's source navigator (GET /source-file), reached through
 * the Vite proxy at /api → 127.0.0.1:8092, same-origin as setupClient.ts.
 * Powers the Inspector's source-reference navigation (SourceNavigator).
 *
 * Types are imported TYPE-ONLY from server/sourceNav.ts — erased at build, so
 * the browser bundle never pulls server code, and the shapes can't drift.
 */
import type { SourceFilePayload } from '../../server/sourceNav';

export type {
  SourceFilePayload,
  SourceDeclaration,
  SourceImport,
  SourceReexport,
  Resolution,
} from '../../server/sourceNav';

/** A fetch outcome the navigator can render either way — payload or error text. */
export type SourceFileFetchResult =
  | { ok: true; payload: SourceFilePayload }
  | { ok: false; error: string };

const BASE = '/api';

/**
 * GET /source-file?path=<repo-relative>. Never throws — errors come back as
 * `{ok:false}` with status-aware text: 400 → denied, 404 → missing, network
 * failure → runner unreachable.
 */
export async function fetchSourceFile(path: string): Promise<SourceFileFetchResult> {
  try {
    const response = await fetch(`${BASE}/source-file?${new URLSearchParams({ path })}`);
    if (response.ok) {
      return { ok: true, payload: (await response.json()) as SourceFilePayload };
    }
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.status === 400) {
      return { ok: false, error: `Access denied: ${body.error ?? 'path not servable'}` };
    }
    if (response.status === 404) {
      return { ok: false, error: `File not found: ${path}` };
    }
    return { ok: false, error: body.error ?? `Source fetch failed (HTTP ${response.status})` };
  } catch {
    return { ok: false, error: 'Runner unreachable — start the runner to view source' };
  }
}
