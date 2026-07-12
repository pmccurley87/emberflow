import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteEnvironmentSecret,
  loadEnvironments,
  resolveRunSafety,
  setEnvironmentAuth,
  setEnvironmentSecret,
  type EnvironmentDefinition,
} from './environments';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emberflow-env-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: unknown): void {
  writeFileSync(join(dir, name), typeof contents === 'string' ? contents : JSON.stringify(contents));
}

describe('loadEnvironments', () => {
  it('loads a well-formed environments file', () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'local',
      environments: {
        local: { vars: { A: '1' }, secrets: { B: '2' } },
        prod: { protected: true, vars: {}, secrets: {} },
      },
    });
    const result = loadEnvironments(dir);
    expect(result.defaultEnvironment).toBe('local');
    expect(result.environments.local).toEqual({ vars: { A: '1' }, secrets: { B: '2' } });
    expect(result.environments.prod).toEqual({ protected: true, vars: {}, secrets: {} });
  });

  it('fills in missing vars/secrets objects', () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'local',
      environments: { local: {} },
    });
    const result = loadEnvironments(dir);
    expect(result.environments.local).toEqual({ vars: {}, secrets: {} });
  });

  it('falls back to a synthesized local environment when only secrets.json exists', () => {
    write('emberflow.secrets.json', { API_KEY: 'shh' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = loadEnvironments(dir);
    logSpy.mockRestore();
    expect(result).toEqual({
      defaultEnvironment: 'local',
      environments: { local: { vars: {}, secrets: { API_KEY: 'shh' } } },
      // Legacy secrets are a deliberate setup — this project boots real.
      configured: true,
    });
  });

  it('logs a hint when falling back to the legacy secrets file', () => {
    write('emberflow.secrets.json', {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    loadEnvironments(dir);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('emberflow.environments.json');
    logSpy.mockRestore();
  });

  it('defaults to an empty local environment when neither file exists', () => {
    const result = loadEnvironments(dir);
    expect(result).toEqual({
      defaultEnvironment: 'local',
      environments: { local: { vars: {}, secrets: {} } },
      // Nothing was ever configured — drives the default-mock boot.
      configured: false,
    });
  });

  it('prefers the environments file over the legacy secrets file when both exist', () => {
    write('emberflow.secrets.json', { LEGACY: 'x' });
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: { dev: { vars: {}, secrets: {} } },
    });
    const result = loadEnvironments(dir);
    expect(result.defaultEnvironment).toBe('dev');
    expect(result.environments.LEGACY).toBeUndefined();
  });

  it('throws a clear error for invalid JSON', () => {
    write('emberflow.environments.json', '{ not json');
    expect(() => loadEnvironments(dir)).toThrow(/not valid JSON/);
  });

  it('throws when the top level is not an object', () => {
    write('emberflow.environments.json', ['nope']);
    expect(() => loadEnvironments(dir)).toThrow(/expected a JSON object/);
  });

  it('throws when defaultEnvironment is missing', () => {
    write('emberflow.environments.json', { environments: { local: {} } });
    expect(() => loadEnvironments(dir)).toThrow(/"defaultEnvironment" must be a non-empty string/);
  });

  it('throws when environments is missing', () => {
    write('emberflow.environments.json', { defaultEnvironment: 'local' });
    expect(() => loadEnvironments(dir)).toThrow(/"environments" must be an object/);
  });

  it('throws when environments is empty', () => {
    write('emberflow.environments.json', { defaultEnvironment: 'local', environments: {} });
    expect(() => loadEnvironments(dir)).toThrow(/at least one environment/);
  });

  it('throws when defaultEnvironment does not name a defined environment', () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'missing',
      environments: { local: {} },
    });
    expect(() => loadEnvironments(dir)).toThrow(/is not one of the defined environments/);
  });

  it('throws when an environment vars value is not a string map', () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'local',
      environments: { local: { vars: { A: 1 }, secrets: {} } },
    });
    expect(() => loadEnvironments(dir)).toThrow(/environments\.local\.vars must be an object of string -> string/);
  });

  it('throws when an environment secrets value is neither a name list nor a string map', () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'local',
      environments: { local: { vars: {}, secrets: { A: false } } },
    });
    expect(() => loadEnvironments(dir)).toThrow(
      /environments\.local\.secrets must be an array of key names or an object of string -> string/,
    );
  });

  it('rejects a secrets list containing a non-string element', () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'local',
      environments: { local: { vars: {}, secrets: ['OK', 3] } },
    });
    expect(() => loadEnvironments(dir)).toThrow(
      /environments\.local\.secrets must be an array of key names/,
    );
  });

  it('throws when protected is not a boolean', () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'local',
      environments: { local: { vars: {}, secrets: {}, protected: 'yes' } },
    });
    expect(() => loadEnvironments(dir)).toThrow(/environments\.local\.protected must be a boolean/);
  });

  it('accepts an auth.attach.prefix string', () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'local',
      environments: {
        local: {
          vars: {},
          secrets: {},
          auth: { attach: { as: 'header', name: 'Authorization', secretRef: 'S', prefix: 'Bearer ' } },
        },
      },
    });
    const result = loadEnvironments(dir);
    expect(result.environments.local.auth?.attach.prefix).toBe('Bearer ');
  });

  it('throws when auth.attach.prefix is not a string', () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'local',
      environments: {
        local: {
          vars: {},
          secrets: {},
          auth: { attach: { as: 'header', name: 'Authorization', secretRef: 'S', prefix: 123 } },
        },
      },
    });
    expect(() => loadEnvironments(dir)).toThrow(/auth\.attach\.prefix must be a string/);
  });
});

describe('value/structure split: secrets file resolution', () => {
  it('loads the new shape: name-list in environments.json + values in secrets.json', () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: { dev: { vars: { A: '1' }, secrets: ['API_KEY', 'DB_URL'] } },
    });
    write('emberflow.secrets.json', { dev: { API_KEY: 'k', DB_URL: 'postgres://x' } });
    const result = loadEnvironments(dir);
    expect(result.environments.dev.secrets).toEqual({ API_KEY: 'k', DB_URL: 'postgres://x' });
    expect(result.environments.dev.vars).toEqual({ A: '1' });
  });

  it("resolves a declared-but-unvalued key to '' so requireSecret still throws", () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: { dev: { vars: {}, secrets: ['API_KEY', 'MISSING'] } },
    });
    write('emberflow.secrets.json', { dev: { API_KEY: 'k' } });
    const result = loadEnvironments(dir);
    expect(result.environments.dev.secrets).toEqual({ API_KEY: 'k', MISSING: '' });
  });

  it('merges names from environments.json with keys present only in the secrets file', () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: { dev: { vars: {}, secrets: ['DECLARED'] } },
    });
    write('emberflow.secrets.json', { dev: { DECLARED: 'a', EXTRA: 'b' } });
    const result = loadEnvironments(dir);
    expect(result.environments.dev.secrets).toEqual({ DECLARED: 'a', EXTRA: 'b' });
  });

  it('treats a legacy flat secrets.json as env "local" (no environments.json)', () => {
    write('emberflow.secrets.json', { API_KEY: 'shh' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = loadEnvironments(dir);
    logSpy.mockRestore();
    expect(result.environments.local.secrets).toEqual({ API_KEY: 'shh' });
    expect(result.configured).toBe(true);
  });

  it('reads new-shape secrets keyed by env name even without environments.json', () => {
    write('emberflow.secrets.json', { local: { A: '1' }, prod: { B: '2' } });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = loadEnvironments(dir);
    logSpy.mockRestore();
    expect(result.environments.local.secrets).toEqual({ A: '1' });
    expect(result.environments.prod.secrets).toEqual({ B: '2' });
  });
});

describe('$ENV indirection', () => {
  it('resolves $ENV:VAR to process.env at load', () => {
    process.env.EMBERFLOW_TEST_SECRET = 'from-env';
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: { dev: { vars: {}, secrets: ['TOK'] } },
    });
    write('emberflow.secrets.json', { dev: { TOK: '$ENV:EMBERFLOW_TEST_SECRET' } });
    try {
      const result = loadEnvironments(dir);
      expect(result.environments.dev.secrets.TOK).toBe('from-env');
    } finally {
      delete process.env.EMBERFLOW_TEST_SECRET;
    }
  });

  it("resolves a missing $ENV var to '' and warns naming the variable", () => {
    delete process.env.EMBERFLOW_TEST_ABSENT;
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: { dev: { vars: {}, secrets: ['TOK'] } },
    });
    write('emberflow.secrets.json', { dev: { TOK: '$ENV:EMBERFLOW_TEST_ABSENT' } });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadEnvironments(dir);
    expect(result.environments.dev.secrets.TOK).toBe('');
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('EMBERFLOW_TEST_ABSENT'))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('auto-migration of old inline-value format', () => {
  it('moves values into secrets.json, rewrites environments.json name-only, keeps a .bak', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: {
        dev: { vars: { A: '1' }, secrets: { API_KEY: 'realkey', DB_URL: 'realdb' } },
        prod: { protected: true, vars: {}, secrets: { API_KEY: 'prodkey' } },
      },
    });
    const result = loadEnvironments(dir);

    // Values are resolved correctly post-migration.
    expect(result.environments.dev.secrets).toEqual({ API_KEY: 'realkey', DB_URL: 'realdb' });
    expect(result.environments.prod.secrets).toEqual({ API_KEY: 'prodkey' });

    // environments.json is now structure-only (name lists, no values).
    const envFile = JSON.parse(readFileSync(join(dir, 'emberflow.environments.json'), 'utf8'));
    expect(envFile.environments.dev.secrets.sort()).toEqual(['API_KEY', 'DB_URL']);
    expect(envFile.environments.prod.secrets).toEqual(['API_KEY']);

    // Values live in the secrets file (new nested shape).
    const secretsFile = JSON.parse(readFileSync(join(dir, 'emberflow.secrets.json'), 'utf8'));
    expect(secretsFile).toEqual({
      dev: { API_KEY: 'realkey', DB_URL: 'realdb' },
      prod: { API_KEY: 'prodkey' },
    });

    // A .bak of the original environments.json was kept.
    expect(existsSync(join(dir, 'emberflow.environments.json.bak'))).toBe(true);
    const bak = JSON.parse(readFileSync(join(dir, 'emberflow.environments.json.bak'), 'utf8'));
    expect(bak.environments.dev.secrets).toEqual({ API_KEY: 'realkey', DB_URL: 'realdb' });

    // Exactly one migration info line.
    expect(logSpy.mock.calls.filter((c) => String(c[0]).includes('Migrated')).length).toBe(1);
    logSpy.mockRestore();
  });

  it('is idempotent: a second load does not migrate again or rewrite the .bak', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: { dev: { vars: {}, secrets: { API_KEY: 'realkey' } } },
    });
    loadEnvironments(dir);
    const bakAfterFirst = readFileSync(join(dir, 'emberflow.environments.json.bak'), 'utf8');
    logSpy.mockClear();
    const result = loadEnvironments(dir);
    // No second migration log.
    expect(logSpy.mock.calls.filter((c) => String(c[0]).includes('Migrated')).length).toBe(0);
    // .bak unchanged (still the original).
    expect(readFileSync(join(dir, 'emberflow.environments.json.bak'), 'utf8')).toBe(bakAfterFirst);
    expect(result.environments.dev.secrets).toEqual({ API_KEY: 'realkey' });
    logSpy.mockRestore();
  });

  it('writes the migrated secrets file with 0600 permissions', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: { dev: { vars: {}, secrets: { API_KEY: 'realkey' } } },
    });
    loadEnvironments(dir);
    const mode = statSync(join(dir, 'emberflow.secrets.json')).mode & 0o777;
    expect(mode).toBe(0o600);
    vi.restoreAllMocks();
  });
});

describe('secrets-file writers persist values out-of-band and chmod 0600', () => {
  function readJson(name: string): any {
    return JSON.parse(readFileSync(join(dir, name), 'utf8'));
  }

  it('setEnvironmentSecret writes the value to secrets.json (0600) and the name to environments.json', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: { dev: { vars: {}, secrets: [] } },
    });
    await setEnvironmentSecret(dir, 'dev', 'API_KEY', 'topsecret');

    // Value is NOT in environments.json — only the key name is.
    const envFile = readJson('emberflow.environments.json');
    expect(envFile.environments.dev.secrets).toEqual(['API_KEY']);
    expect(JSON.stringify(envFile)).not.toContain('topsecret');

    // Value IS in the secrets file, under the env name, at 0600.
    expect(readJson('emberflow.secrets.json')).toEqual({ dev: { API_KEY: 'topsecret' } });
    expect(statSync(join(dir, 'emberflow.secrets.json')).mode & 0o777).toBe(0o600);

    // And it resolves back through the loader.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadEnvironments(dir).environments.dev.secrets).toEqual({ API_KEY: 'topsecret' });
    vi.restoreAllMocks();
  });

  it('deleteEnvironmentSecret removes both the name and the value', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: { dev: { vars: {}, secrets: ['API_KEY', 'OTHER'] } },
    });
    write('emberflow.secrets.json', { dev: { API_KEY: 'k', OTHER: 'o' } });
    await deleteEnvironmentSecret(dir, 'dev', 'API_KEY');
    expect(readJson('emberflow.environments.json').environments.dev.secrets).toEqual(['OTHER']);
    expect(readJson('emberflow.secrets.json')).toEqual({ dev: { OTHER: 'o' } });
  });
});

describe('secrets-file hardening warnings', () => {
  it('auto-tightens a group/other-readable secrets file to 0600 and logs an info line', () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: { dev: { vars: {}, secrets: ['API_KEY'] } },
    });
    // write() uses default 0644 — group/other readable.
    const secretsPath = join(dir, 'emberflow.secrets.json');
    writeFileSync(secretsPath, JSON.stringify({ dev: { API_KEY: 'k' } }), {
      mode: 0o644,
    });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadEnvironments(dir);
    expect(infoSpy.mock.calls.some((c) => /tightened emberflow\.secrets\.json to 0600/.test(String(c[0])))).toBe(
      true,
    );
    expect(warnSpy).not.toHaveBeenCalled();
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('resolveRunSafety', () => {
  const open: EnvironmentDefinition = { vars: {}, secrets: {} };
  const guarded: EnvironmentDefinition = { vars: {}, secrets: {}, protected: true };

  it('defaults to unsafe (false) on a non-protected environment', () => {
    expect(resolveRunSafety('local', open, {})).toEqual({ ok: true, safeMode: false });
  });

  it('defaults to safe (true) on a protected environment', () => {
    expect(resolveRunSafety('prod', guarded, {})).toEqual({ ok: true, safeMode: true });
  });

  it('honors an explicit safeMode:true on any environment', () => {
    expect(resolveRunSafety('local', open, { safeMode: true })).toEqual({ ok: true, safeMode: true });
    expect(resolveRunSafety('prod', guarded, { safeMode: true })).toEqual({ ok: true, safeMode: true });
  });

  it('honors an explicit safeMode:false on a non-protected environment', () => {
    expect(resolveRunSafety('local', open, { safeMode: false })).toEqual({ ok: true, safeMode: false });
  });

  it('refuses safeMode:false on a protected environment without a matching confirm', () => {
    expect(resolveRunSafety('prod', guarded, { safeMode: false })).toEqual({
      ok: false,
      error: "unsafe run on protected environment 'prod' requires confirm",
    });
    expect(resolveRunSafety('prod', guarded, { safeMode: false, confirm: 'staging' })).toEqual({
      ok: false,
      error: "unsafe run on protected environment 'prod' requires confirm",
    });
  });

  it('allows safeMode:false on a protected environment with a matching confirm', () => {
    expect(resolveRunSafety('prod', guarded, { safeMode: false, confirm: 'prod' })).toEqual({
      ok: true,
      safeMode: false,
    });
  });
});

describe('setEnvironmentSecret', () => {
  it('sets a secret on an existing environment and persists it', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: {
        dev: { vars: {}, secrets: {} },
      },
    });
    await setEnvironmentSecret(dir, 'dev', 'sessionCookie', 'abc');
    const result = loadEnvironments(dir);
    expect(result.environments.dev.secrets.sessionCookie).toBe('abc');
  });

  it('throws when the environment is unknown', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: {
        dev: { vars: {}, secrets: {} },
      },
    });
    await expect(setEnvironmentSecret(dir, 'staging', 'sessionCookie', 'abc')).rejects.toThrow();
  });

  it('serializes concurrent writes so two different keys both survive (no last-write-wins clobber)', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: {
        dev: { vars: {}, secrets: {} },
      },
    });
    // Fire both without awaiting between them — a naive sync read-modify-write
    // would have the second call clobber the first's in-memory read.
    const p1 = setEnvironmentSecret(dir, 'dev', 'keyA', 'valueA');
    const p2 = setEnvironmentSecret(dir, 'dev', 'keyB', 'valueB');
    await Promise.all([p1, p2]);
    const result = loadEnvironments(dir);
    expect(result.environments.dev.secrets.keyA).toBe('valueA');
    expect(result.environments.dev.secrets.keyB).toBe('valueB');
  });
});

describe('setEnvironmentAuth', () => {
  it('sets auth on an existing environment and persists it', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: {
        dev: { vars: {}, secrets: {} },
      },
    });
    await setEnvironmentAuth(dir, 'dev', {
      attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' },
    });
    const result = loadEnvironments(dir);
    expect(result.environments.dev.auth).toEqual({
      attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' },
    });
  });

  it('rejects an invalid attach.as with a message naming the problem', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: {
        dev: { vars: {}, secrets: {} },
      },
    });
    await expect(
      setEnvironmentAuth(dir, 'dev', {
        attach: { as: 'bogus' as unknown as 'cookie', name: 'session', secretRef: 'sessionCookie' },
      }),
    ).rejects.toThrow(/auth\.attach\.as/);
  });

  it('clears auth when passed null', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: {
        dev: {
          vars: {},
          secrets: {},
          auth: { attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' } },
        },
      },
    });
    await setEnvironmentAuth(dir, 'dev', null);
    const result = loadEnvironments(dir);
    expect(result.environments.dev.auth).toBeUndefined();
  });

  it('throws when the environment is unknown', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: {
        dev: { vars: {}, secrets: {} },
      },
    });
    await expect(
      setEnvironmentAuth(dir, 'staging', {
        attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' },
      }),
    ).rejects.toThrow();
  });

  it('preserves the environment other fields (secrets, vars, protected)', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: {
        dev: { vars: { region: 'us' }, secrets: { apiKey: 'shh' }, protected: true },
      },
    });
    await setEnvironmentAuth(dir, 'dev', {
      attach: { as: 'header', name: 'X-Auth', secretRef: 'apiKey' },
    });
    const result = loadEnvironments(dir);
    expect(result.environments.dev.vars).toEqual({ region: 'us' });
    expect(result.environments.dev.secrets).toEqual({ apiKey: 'shh' });
    expect(result.environments.dev.protected).toBe(true);
  });

  it('serializes concurrent setEnvironmentAuth + setEnvironmentSecret so both survive (shared queue)', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: {
        dev: { vars: {}, secrets: {} },
      },
    });
    const p1 = setEnvironmentAuth(dir, 'dev', {
      attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' },
    });
    const p2 = setEnvironmentSecret(dir, 'dev', 'sessionCookie', 'abc');
    await Promise.all([p1, p2]);
    const result = loadEnvironments(dir);
    expect(result.environments.dev.auth).toEqual({
      attach: { as: 'cookie', name: 'session', secretRef: 'sessionCookie' },
    });
    expect(result.environments.dev.secrets.sessionCookie).toBe('abc');
  });
});

describe('deleteEnvironmentSecret', () => {
  it('removes an existing secret', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: {
        dev: { vars: {}, secrets: { sessionCookie: 'abc' } },
      },
    });
    await deleteEnvironmentSecret(dir, 'dev', 'sessionCookie');
    const result = loadEnvironments(dir);
    expect(result.environments.dev.secrets.sessionCookie).toBeUndefined();
  });

  it('is a no-op when the key is missing', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: {
        dev: { vars: {}, secrets: { other: 'x' } },
      },
    });
    await expect(deleteEnvironmentSecret(dir, 'dev', 'sessionCookie')).resolves.toBeUndefined();
    const result = loadEnvironments(dir);
    expect(result.environments.dev.secrets).toEqual({ other: 'x' });
  });

  it('throws when the environment is unknown', async () => {
    write('emberflow.environments.json', {
      defaultEnvironment: 'dev',
      environments: {
        dev: { vars: {}, secrets: {} },
      },
    });
    await expect(deleteEnvironmentSecret(dir, 'staging', 'sessionCookie')).rejects.toThrow();
  });
});
