import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

/** One-time relocation of the legacy flat flows layout into `<apisDir>/default/`.
 *  Ids and sidecars are preserved; subflow references (by id) stay valid.
 *  Idempotent: a no-op once `apisDir` exists or `flowsDir` is absent.
 *  `flowsDir` is the actual configured flows directory — callers must not
 *  assume it is literally named `flows` (project configs can rename it). */
export function migrateFlowsToApis(flowsDir: string, apisDir: string): { moved: string[] } {
  if (existsSync(apisDir) || !existsSync(flowsDir)) return { moved: [] };

  const target = join(apisDir, 'default');
  mkdirSync(target, { recursive: true });
  const moved: string[] = [];
  for (const file of readdirSync(flowsDir)) {
    renameSync(join(flowsDir, file), join(target, file));
    if (file.endsWith('.json') && !file.endsWith('.scenarios.json')) {
      moved.push(file.slice(0, -'.json'.length));
    }
  }
  try { rmdirSync(flowsDir); } catch { /* non-empty or already gone — leave it */ }
  return { moved };
}
