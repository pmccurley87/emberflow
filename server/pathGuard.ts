// A mountable operation `http.path` must be a real sub-path — never bare
// root ('/' or '') and never missing. Operation routes are registered
// before the studio SPA catch-all, so an op mounted at '/' would shadow the
// studio entirely (GET / would return the op's output, not the studio
// HTML). Roughly `^/[^/].*`.
export function isMountablePath(path: string | undefined | null): path is string {
  if (!path) return false;
  if (path.length < 2) return false; // '/' or ''
  if (path[0] !== '/') return false;
  if (path[1] === '/') return false; // '//x'
  return true;
}
