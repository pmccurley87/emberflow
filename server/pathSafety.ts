import { isAbsolute, relative, resolve } from 'node:path';

/**
 * True when `relPath` is a safe POSIX-style relative path that, once joined
 * onto `baseDir`, resolves to somewhere *inside* `baseDir`.
 *
 * Rejects:
 *  - empty strings
 *  - a leading `/` (absolute)
 *  - a backslash anywhere (the Windows separator — letting it through would
 *    let a segment like `a\..\b` smuggle a traversal past the POSIX-only
 *    `'/'.split` checks below, and still resolve outside `baseDir` via
 *    `path.join`'s platform-specific behavior)
 *  - any `.`/`..`/empty segment (so `a//b`, `./x`, `../x` are all rejected)
 *  - anything that, after resolution, doesn't stay under `baseDir` (defense
 *    in depth beyond the segment checks above)
 *
 * Shared by `isSafeApiPath` (server/index.ts, POST /operations and future
 * path-taking endpoints) and `isSafeFlowId` (server/agents/runManager.ts) —
 * one robust implementation instead of two ad hoc string checks.
 */
export function isPathWithin(baseDir: string, relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  if (relPath.includes('\\')) return false;
  if (relPath.startsWith('/')) return false;
  const segments = relPath.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return false;

  const resolvedBase = resolve(baseDir);
  const resolved = resolve(baseDir, relPath);
  const rel = relative(resolvedBase, resolved);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
