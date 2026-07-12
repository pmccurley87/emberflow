import express, { type Express, type RequestHandler, type Router } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { RegisteredOp, RuntimeAdapter } from './RuntimeAdapter';

const METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;
type Method = (typeof METHODS)[number];

function isMethod(m: string): m is Method {
  return (METHODS as readonly string[]).includes(m);
}

/** Express implementation of the `RuntimeAdapter` seam. Keep it thin — this is
 *  the seam other runtimes (Deno/Bun) implement later. */
export class ExpressAdapter implements RuntimeAdapter {
  private readonly _app: Express;
  private server?: Server;
  private readonly seen = new Set<string>();

  constructor(app?: Express) {
    this._app = app ?? express();
  }

  get app(): Express {
    return this._app;
  }

  /** The bound address once `listen()` resolves (useful in tests to find an
   *  ephemeral port). `null` before listening / after close. */
  get address(): AddressInfo | null {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr : null;
  }

  registerOperation(op: RegisteredOp, handler: RequestHandler): void {
    const method = op.method.toUpperCase();
    const key = `${method} ${op.path}`;
    if (this.seen.has(key)) {
      throw new Error(`Duplicate operation route: ${key}`);
    }
    const lower = method.toLowerCase();
    if (!isMethod(lower)) {
      throw new Error(`Unsupported HTTP method for operation route: ${method} ${op.path}`);
    }
    this.seen.add(key);
    this._app[lower](op.path, handler);
  }

  mountRouter(basePath: string, router: Router): void {
    this._app.use(basePath, router);
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve) => {
      this.server = this._app.listen(port, host, () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = this.server;
      if (!server) {
        resolve();
        return;
      }
      this.server = undefined;
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
