import { captureCredential } from './authAttach';
import { setEnvironmentSecret, type EnvironmentDefinition } from './environments';

/** Minimal response shape performLogin needs from the injected fetch. */
interface LoginResponse {
  status: number;
  headers: Headers;
  json: () => Promise<any>;
}

export interface PerformLoginDeps {
  fetch: (url: string, init?: RequestInit) => Promise<LoginResponse>;
}

/**
 * Fires the configured login request for `envName`, captures the resulting
 * credential per `envDef.auth.login.capture`, and persists it into the
 * environment's secrets under `envDef.auth.attach.secretRef`.
 *
 * Never returns or logs the captured value — only the secretRef name.
 */
export async function performLogin(
  cwd: string,
  envName: string,
  envDef: EnvironmentDefinition,
  deps: PerformLoginDeps = { fetch: globalThis.fetch },
): Promise<{ secretRef: string }> {
  const login = envDef.auth?.login;
  if (!login) {
    throw new Error(`environment "${envName}" has no auth.login configured`);
  }

  const { method, url, headers, bodyRef } = login.request;
  const init: RequestInit = { method, ...(headers ? { headers } : {}) };
  if (bodyRef !== undefined) {
    const rawBody = envDef.secrets[bodyRef];
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      // Never include the secret content in the message — only names.
      throw new Error(`login body secret "${bodyRef}" for environment "${envName}" is not valid JSON`);
    }
    init.body = JSON.stringify(parsed);
    // Lowercase all caller header keys so an explicit content-type (any casing)
    // wins over — and never duplicates — the auto-added default.
    const callerHeaders = Object.fromEntries(
      Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    init.headers = { 'content-type': 'application/json', ...callerHeaders };
  }

  const res = await deps.fetch(url, init);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`login failed: ${res.status}`);
  }

  const value = await captureCredential(res, login.capture);
  if (value === null) {
    throw new Error('login succeeded but no credential captured');
  }

  const secretRef = envDef.auth!.attach.secretRef;
  await setEnvironmentSecret(cwd, envName, secretRef, value);

  return { secretRef };
}
