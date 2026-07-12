// AuthPolicy/VerifyResult/Verifier are plain data/logic types shared with
// src/engine/authVerify.ts (also used by src/nodes/requireAuth.ts, which is
// bundled into the browser build — so src/ must not import from server/).
// Re-exported here rather than redefined, to avoid divergence.
export type { AuthPolicy, VerifyResult, Verifier } from '../../src/engine';
