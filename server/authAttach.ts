import type { EnvAuth } from './environments';

type LoginCapture = NonNullable<EnvAuth['login']>['capture'];

/**
 * Attaches a captured credential value onto a headers object for a run.
 * Pure and non-mutating: returns a NEW headers object.
 * Additive + non-destructive — if the target header/cookie-name is already
 * present, the input is returned unchanged (caller-explicit wins).
 */
export function attachCredential(
  headers: Record<string, unknown>,
  attach: EnvAuth['attach'],
  value: string,
): Record<string, unknown> {
  const attachedValue = attach.prefix ? `${attach.prefix}${value}` : value;

  if (attach.as === 'cookie') {
    const existingCookie = typeof headers['cookie'] === 'string' ? (headers['cookie'] as string) : undefined;
    if (existingCookie !== undefined && hasCookieName(existingCookie, attach.name)) {
      return headers;
    }
    const nextCookie = existingCookie
      ? `${existingCookie}; ${attach.name}=${attachedValue}`
      : `${attach.name}=${attachedValue}`;
    return { ...headers, cookie: nextCookie };
  }

  const headerKey = attach.name.toLowerCase();
  const existing = Object.keys(headers).find((k) => k.toLowerCase() === headerKey);
  if (existing !== undefined) {
    return headers;
  }
  return { ...headers, [headerKey]: attachedValue };
}

function hasCookieName(cookieHeader: string, name: string): boolean {
  return cookieHeader
    .split(';')
    .map((pair) => pair.trim().split('=')[0])
    .some((cookieName) => cookieName === name);
}

/**
 * Extracts a captured credential value from a login response.
 * Pure with respect to its inputs (no I/O of its own) — the caller performs
 * the actual fetch and passes in the response-like object.
 */
export async function captureCredential(
  res: { headers: Headers; json: () => Promise<any> },
  capture: LoginCapture,
): Promise<string | null> {
  if (capture.from === 'set-cookie') {
    const single = res.headers.get('set-cookie');
    const lines = res.headers.getSetCookie?.() ?? (single ? [single] : []);
    if (lines.length === 0) {
      return null;
    }

    if (!capture.cookieName) {
      const firstPair = lines[0]?.split(';')[0]?.trim();
      return firstPair || null;
    }

    for (const line of lines) {
      const firstPair = line.split(';')[0]?.trim();
      if (!firstPair) {
        continue;
      }
      const [cookieName, ...rest] = firstPair.split('=');
      if (cookieName === capture.cookieName) {
        return rest.join('=');
      }
    }
    return null;
  }

  if (capture.from === 'json') {
    const body = await res.json();
    return readDotPath(body, capture.path);
  }

  return res.headers.get(capture.name);
}

function readDotPath(body: unknown, path: string): string | null {
  const segments = path.split('.');
  let current: unknown = body;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined || current === null) {
    return null;
  }
  return String(current);
}
