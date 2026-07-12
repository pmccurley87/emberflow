// Re-exports the shared, browser-safe implementation from src/engine/authVerify.ts
// so server-side auth enforcement and the requireAuth node (bundled into the
// studio browser build) share one implementation instead of two diverging copies.
export {
  bearerVerifier,
  apiKeyVerifier,
  VerifierRegistry,
  createDefaultVerifierRegistry,
} from '../../src/engine';
