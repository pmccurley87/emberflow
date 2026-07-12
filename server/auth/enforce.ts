// Re-exports the shared enforceAuth from src/engine/authVerify.ts. Kept as its
// own module (rather than importing src/engine directly at call sites) so the
// server-side auth call path has a stable, server-scoped entry point mirroring
// the file map in the plan; the underlying logic is shared with the
// requireAuth node (src/nodes/requireAuth.ts) to avoid divergence.
export { enforceAuth } from '../../src/engine';
