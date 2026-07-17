/** Repo-relative changed file → the operation id it defines, or null.
 *  emberflow/apis/billing/charge.json → 'billing/charge'; sidecars and
 *  non-operation files don't map. */
export function operationIdFromFile(path: string): string | null {
  const m = /^emberflow\/apis\/(.+)\.json$/.exec(path);
  if (!m || m[1].endsWith('.scenarios') || m[1].endsWith('/_meta') || m[1] === '_meta') return null;
  return m[1];
}
