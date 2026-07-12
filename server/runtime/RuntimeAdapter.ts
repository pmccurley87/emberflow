import type { RequestHandler, Router } from 'express';

/** A single routed operation's method + path. */
export interface RegisteredOp {
  method: string;
  path: string;
}

/**
 * The seam between the runner and whatever HTTP runtime serves it. Express is
 * the only implementation today; Deno/Bun adapters can implement this same
 * interface later without touching the runner.
 */
export interface RuntimeAdapter {
  /** Register a routed operation's handler at `{method, path}`. Throws on a
   *  duplicate method+path registration. */
  registerOperation(op: RegisteredOp, handler: RequestHandler): void;
  /** Mount a sub-router at a base path (used for `/api` + the studio). */
  mountRouter(basePath: string, router: Router): void;
  /** Start listening; resolves once the server is up. */
  listen(port: number, host: string): Promise<void>;
  /** Stop the server; resolves once fully closed. */
  close(): Promise<void>;
}
