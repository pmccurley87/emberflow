/** Extract `:name` path-param segments from an HTTP path, in order, e.g.
 *  `/api/channels/:id/approvals/:approvalId` → `['id', 'approvalId']`. */
export function parsePathParams(path: string): string[] {
  const matches = path.match(/:([A-Za-z0-9_]+)/g) ?? [];
  return matches.map((m) => m.slice(1));
}
