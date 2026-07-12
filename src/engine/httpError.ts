/** A typed error a node can throw to control the HTTP status/body of its operation. */
export class HttpError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(status: number, body?: unknown) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export function isHttpError(e: unknown): e is HttpError {
  return e instanceof HttpError;
}
