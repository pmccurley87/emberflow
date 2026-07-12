import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { performLogin } from './login';
import type { EnvironmentDefinition } from './environments';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emberflow-login-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: unknown): void {
  writeFileSync(join(dir, name), typeof contents === 'string' ? contents : JSON.stringify(contents));
}

function baseEnvDef(): EnvironmentDefinition {
  return {
    vars: {},
    secrets: {},
    auth: {
      attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' },
      login: {
        request: { method: 'POST', url: 'https://example.test/login' },
        capture: { from: 'set-cookie', cookieName: 'session' },
      },
    },
  };
}

describe('performLogin', () => {
  it('fires the login request, captures the credential, and stores it', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'local',
      environments: { local: { vars: {}, secrets: {} } },
    });
    const envDef = baseEnvDef();

    const fetchMock = async () => ({
      status: 200,
      headers: new Headers({ 'set-cookie': 'session=zzz; Path=/' }),
      json: async () => ({}),
    });

    const result = await performLogin(dir, 'local', envDef, { fetch: fetchMock as unknown as typeof fetch });

    expect(result).toEqual({ secretRef: 'sessionCookie' });

    // The captured credential VALUE lands in the secrets file (keyed by env),
    // never in environments.json — which now records only the key name.
    const secrets = JSON.parse(readFileSync(join(dir, 'emberflow.secrets.json'), 'utf8'));
    expect(secrets.local.sessionCookie).toBe('zzz');
    const stored = JSON.parse(readFileSync(join(dir, 'emberflow.environments.json'), 'utf8'));
    expect(stored.environments.local.secrets).toContain('sessionCookie');
    expect(JSON.stringify(stored)).not.toContain('zzz');
  });

  it('sends the parsed bodyRef secret as the request body (default content-type)', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'local',
      environments: { local: { vars: {}, secrets: {} } },
    });
    const envDef = baseEnvDef();
    envDef.secrets.loginBody = '{"email":"a@b.test","password":"pw"}';
    envDef.auth!.login!.request.bodyRef = 'loginBody';

    let capturedInit: RequestInit | undefined;
    const fetchMock = async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return {
        status: 200,
        headers: new Headers({ 'set-cookie': 'session=zzz; Path=/' }),
        json: async () => ({}),
      };
    };

    await performLogin(dir, 'local', envDef, { fetch: fetchMock as unknown as typeof fetch });

    expect(capturedInit?.body).toBe(JSON.stringify({ email: 'a@b.test', password: 'pw' }));
    expect((capturedInit?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('lets an explicitly cased request content-type header override the default', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'local',
      environments: { local: { vars: {}, secrets: {} } },
    });
    const envDef = baseEnvDef();
    envDef.secrets.loginBody = '{"email":"a@b.test"}';
    envDef.auth!.login!.request.bodyRef = 'loginBody';
    envDef.auth!.login!.request.headers = { 'Content-Type': 'application/vnd.api+json' };

    let capturedInit: RequestInit | undefined;
    const fetchMock = async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return {
        status: 200,
        headers: new Headers({ 'set-cookie': 'session=zzz; Path=/' }),
        json: async () => ({}),
      };
    };

    await performLogin(dir, 'local', envDef, { fetch: fetchMock as unknown as typeof fetch });

    const headers = capturedInit?.headers as Record<string, string>;
    // Caller's content-type wins, and there is no duplicate differently-cased key.
    expect(headers['content-type']).toBe('application/vnd.api+json');
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('throws when the bodyRef secret is not valid JSON', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'local',
      environments: { local: { vars: {}, secrets: {} } },
    });
    const envDef = baseEnvDef();
    envDef.secrets.loginBody = 'not-json{';
    envDef.auth!.login!.request.bodyRef = 'loginBody';

    const fetchMock = async () => ({
      status: 200,
      headers: new Headers({ 'set-cookie': 'session=zzz' }),
      json: async () => ({}),
    });

    await expect(
      performLogin(dir, 'local', envDef, { fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow('login body secret "loginBody" for environment "local" is not valid JSON');
  });

  it('throws when the login response is non-2xx', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'local',
      environments: { local: { vars: {}, secrets: {} } },
    });
    const envDef = baseEnvDef();

    const fetchMock = async () => ({
      status: 401,
      headers: new Headers(),
      json: async () => ({}),
    });

    await expect(
      performLogin(dir, 'local', envDef, { fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow('login failed: 401');
  });
});
