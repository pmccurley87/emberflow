import { chmodSync, copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Describes how the runner authenticates studio runs against an environment. */
export interface EnvAuth {
  attach: { as: 'cookie' | 'header'; name: string; secretRef: string; prefix?: string };
  login?: {
    request: { method: string; url: string; headers?: Record<string, string>; bodyRef?: string };
    capture:
      | { from: 'set-cookie'; cookieName?: string }
      | { from: 'json'; path: string }
      | { from: 'header'; name: string };
  };
}

/** A named value-set the runner injects into a run. */
export interface EnvironmentDefinition {
  /** Non-secret values (API base URLs, seed ids, flags) — visible in UI/logs. */
  vars: Record<string, string>;
  /**
   * Resolved secret map (KEY -> value) as seen by the runtime. Values live in
   * `emberflow.secrets.json` (never in `emberflow.environments.json`, which
   * carries only the list of key NAMES). A key that is declared but has no
   * value in the secrets file resolves to '' so `requireSecret` still throws a
   * helpful "missing secret" error. Masked everywhere: keys visible, values
   * never shown.
   */
  secrets: Record<string, string>;
  /** Marks environments where mistakes are expensive (e.g. prod). Forces safe mode by default. */
  protected?: boolean;
  /** Optional studio-run auth injection config. Absent means no auth injection (backward compatible). */
  auth?: EnvAuth;
}

export interface EnvironmentsFile {
  defaultEnvironment: string;
  environments: Record<string, EnvironmentDefinition>;
  /** True when the project deliberately configured environments (an
   *  emberflow.environments.json exists, or legacy secrets were found) —
   *  false when the loader synthesized the bare "local" fallback. Drives the
   *  default serving mode: an unconfigured project boots in mock. */
  configured: boolean;
}

/**
 * The on-disk shape of `emberflow.environments.json`. Structure only: `secrets`
 * is a list of key NAMES in the new format (a value-map is still accepted for
 * one migration cycle). Distinct from `EnvironmentDefinition`, whose `secrets`
 * is the RESOLVED value map the runtime consumes.
 */
interface RawEnvironmentDefinition {
  vars?: Record<string, string>;
  secrets?: string[] | Record<string, string>;
  protected?: boolean;
  auth?: EnvAuth;
}

interface RawEnvironmentsFile {
  defaultEnvironment: string;
  environments: Record<string, RawEnvironmentDefinition>;
}

const ENVIRONMENTS_FILENAME = 'emberflow.environments.json';
const SECRETS_FILENAME = 'emberflow.secrets.json';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** A nested `{ envName: { KEY: value } }` secrets-file map (new shape). */
function isNestedSecretsMap(value: unknown): value is Record<string, Record<string, string>> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((v) => isStringRecord(v));
}

/**
 * Validates an `EnvAuth` value's shape. Returns an error message (without any
 * `environments.<name>.` prefix) naming the problem, or `null` if valid.
 * Shared by `validateShape` (file load) and `setEnvironmentAuth` (writer) so
 * the rules can't drift between the two call sites.
 */
function validateAuthShape(auth: unknown): string | null {
  if (!isPlainObject(auth)) {
    return 'auth must be an object';
  }
  const attach = auth.attach;
  if (!isPlainObject(attach)) {
    return 'auth.attach must be an object';
  }
  if (attach.as !== 'cookie' && attach.as !== 'header') {
    return 'auth.attach.as must be "cookie" or "header"';
  }
  if (typeof attach.name !== 'string') {
    return 'auth.attach.name must be a string';
  }
  if (typeof attach.secretRef !== 'string') {
    return 'auth.attach.secretRef must be a string';
  }
  if (attach.prefix !== undefined && typeof attach.prefix !== 'string') {
    return 'auth.attach.prefix must be a string';
  }
  if (auth.login !== undefined && !isPlainObject(auth.login)) {
    return 'auth.login must be an object';
  }
  return null;
}

/** Throws with a message pinpointing what's wrong in the file, for a clear boot-time failure. */
function validateShape(parsed: unknown): asserts parsed is RawEnvironmentsFile {
  const prefix = `${ENVIRONMENTS_FILENAME} is malformed`;
  if (!isPlainObject(parsed)) {
    throw new Error(`${prefix}: expected a JSON object at the top level`);
  }
  if (typeof parsed.defaultEnvironment !== 'string' || parsed.defaultEnvironment.length === 0) {
    throw new Error(`${prefix}: "defaultEnvironment" must be a non-empty string`);
  }
  if (!isPlainObject(parsed.environments)) {
    throw new Error(`${prefix}: "environments" must be an object of name -> environment`);
  }
  const names = Object.keys(parsed.environments);
  if (names.length === 0) {
    throw new Error(`${prefix}: "environments" must define at least one environment`);
  }
  for (const name of names) {
    const env = parsed.environments[name];
    if (!isPlainObject(env)) {
      throw new Error(`${prefix}: environments.${name} must be an object`);
    }
    if (env.vars !== undefined && !isStringRecord(env.vars)) {
      throw new Error(`${prefix}: environments.${name}.vars must be an object of string -> string`);
    }
    // `secrets` is a LIST of key names (new, structure-only shape). The old
    // map-of-values shape is still accepted here so a pre-migration file loads;
    // loadEnvironments migrates its values out on the next load.
    if (env.secrets !== undefined && !isStringArray(env.secrets) && !isStringRecord(env.secrets)) {
      throw new Error(
        `${prefix}: environments.${name}.secrets must be an array of key names or an object of string -> string`,
      );
    }
    if (env.protected !== undefined && typeof env.protected !== 'boolean') {
      throw new Error(`${prefix}: environments.${name}.protected must be a boolean`);
    }
    if (env.auth !== undefined) {
      const authError = validateAuthShape(env.auth);
      if (authError !== null) {
        throw new Error(`${prefix}: environments.${name}.${authError}`);
      }
    }
  }
  if (!(parsed.defaultEnvironment in parsed.environments)) {
    throw new Error(
      `${prefix}: defaultEnvironment "${parsed.defaultEnvironment}" is not one of the defined environments (${names.join(', ')})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Secret VALUES live in emberflow.secrets.json, structure-only in
// environments.json. Everything below implements that split: reading the
// secrets file (new nested shape + legacy flat), $ENV indirection, file
// hardening warnings, and the one-time auto-migration of old inline values.
// ---------------------------------------------------------------------------

const secretsFileMode = 0o600;

/** One-shot per-process warning dedupe so repeated loads don't spam the log. */
const warnedOnce = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(message);
}

interface SecretsFileContents {
  /** Resolved-per-env raw values: { envName: { KEY: rawValue } }. */
  byEnv: Record<string, Record<string, string>>;
  /** True when the file used the legacy flat `{ KEY: value }` shape. */
  legacyFlat: boolean;
  existed: boolean;
}

/**
 * Reads `emberflow.secrets.json`. Accepts the new nested
 * `{ envName: { KEY: value } }` shape and the legacy flat `{ KEY: value }`
 * shape (mapped to env "local", preserving the historical synthesized-env
 * behavior). Missing or invalid file → empty. Values may be `$ENV:VAR`
 * indirections; they are resolved at merge time, not here.
 */
function readSecretsFile(secretsPath: string): SecretsFileContents {
  if (!existsSync(secretsPath)) return { byEnv: {}, legacyFlat: false, existed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(secretsPath, 'utf8'));
  } catch {
    return { byEnv: {}, legacyFlat: false, existed: true };
  }
  if (isNestedSecretsMap(parsed)) {
    // Empty {} is ambiguous but harmless as an empty nested map.
    return { byEnv: parsed, legacyFlat: false, existed: true };
  }
  if (isStringRecord(parsed)) {
    return { byEnv: { local: parsed }, legacyFlat: true, existed: true };
  }
  return { byEnv: {}, legacyFlat: false, existed: true };
}

/** Writes the nested secrets map and locks the file down to 0600. */
function writeSecretsFile(secretsPath: string, byEnv: Record<string, Record<string, string>>): void {
  writeFileSync(secretsPath, JSON.stringify(byEnv, null, 2) + '\n');
  try {
    chmodSync(secretsPath, secretsFileMode);
  } catch {
    // Best-effort on platforms/filesystems without POSIX modes.
  }
}

/**
 * Resolves a stored secret value. A value of the form `$ENV:VAR_NAME`
 * indirects to `process.env.VAR_NAME`; a missing/empty env var resolves to ''
 * and warns (once) naming the variable. All other values pass through.
 */
function resolveSecretValue(raw: string): string {
  const match = /^\$ENV:(.+)$/.exec(raw);
  if (!match) return raw;
  const varName = match[1];
  const fromEnv = process.env[varName];
  if (fromEnv === undefined || fromEnv === '') {
    warnOnce(
      `envvar:${varName}`,
      `[emberflow] secret indirection $ENV:${varName} is unset — resolving to empty. Set ${varName} in the environment.`,
    );
    return '';
  }
  return fromEnv;
}

/** True when the file is tracked by git. Safe/cheap; false when not a repo. */
function isTrackedByGit(cwd: string, relPath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', relPath], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Warns (once per process) if the secrets file is group/other-readable or is
 * tracked by git — both leak plaintext credentials.
 */
const hardeningChecked = new Set<string>();
function checkSecretsFileHardening(cwd: string, secretsPath: string): void {
  if (!existsSync(secretsPath)) return;
  // Runs once per path per process — loadEnvironments is called on every
  // GET /environments and we don't want to spawn `git` on that hot path.
  if (hardeningChecked.has(secretsPath)) return;
  hardeningChecked.add(secretsPath);
  try {
    const mode = statSync(secretsPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      // Loose perms on a hand-written secrets file are fixable in place — do
      // it and say so, rather than nagging on every load with no remediation.
      try {
        chmodSync(secretsPath, secretsFileMode);
        console.info(`[emberflow] tightened ${SECRETS_FILENAME} to 0600`);
      } catch {
        // Couldn't chmod (e.g. read-only filesystem) — fall back to warning
        // since we weren't able to fix it ourselves.
        warnOnce(
          `mode:${secretsPath}`,
          `[emberflow] SECURITY: ${SECRETS_FILENAME} is readable by group/other (mode 0${mode.toString(8)}); ` +
            `it holds plaintext secrets. Run: chmod 600 ${SECRETS_FILENAME}`,
        );
      }
    }
  } catch {
    // stat failure is non-fatal
  }
  if (isTrackedByGit(cwd, SECRETS_FILENAME)) {
    warnOnce(
      `git:${secretsPath}`,
      `[emberflow] SECURITY: ${SECRETS_FILENAME} is tracked by git and holds plaintext secrets. ` +
        `Remove it from the repo: git rm --cached ${SECRETS_FILENAME} (it should stay gitignored).`,
    );
  }
}

/** True when any environment still carries inline non-empty secret VALUES. */
function needsMigration(parsed: RawEnvironmentsFile): boolean {
  for (const env of Object.values(parsed.environments)) {
    const s = env.secrets;
    if (s !== undefined && !Array.isArray(s) && Object.values(s).some((v) => v !== '')) {
      return true;
    }
  }
  return false;
}

/**
 * One-time migration: moves inline secret VALUES out of environments.json into
 * emberflow.secrets.json (0600), rewrites environments.json so each env's
 * `secrets` is a list of key NAMES, and keeps a `.bak` of the original
 * environments.json on first migration. Idempotent — after it runs there are
 * no inline values left, so `needsMigration` returns false on the next load.
 */
function migrateEnvironmentsFile(
  environmentsPath: string,
  secretsPath: string,
  parsed: RawEnvironmentsFile,
): void {
  const backupPath = `${environmentsPath}.bak`;
  if (!existsSync(backupPath)) {
    copyFileSync(environmentsPath, backupPath);
  }
  const { byEnv } = readSecretsFile(secretsPath);
  for (const [name, env] of Object.entries(parsed.environments)) {
    const s = env.secrets;
    if (s === undefined || Array.isArray(s)) continue;
    const bucket = { ...(byEnv[name] ?? {}) };
    for (const [key, value] of Object.entries(s)) {
      // environments.json is the authoritative current source — its values win.
      if (value !== '') bucket[key] = value;
    }
    byEnv[name] = bucket;
    env.secrets = Object.keys(s);
  }
  writeSecretsFile(secretsPath, byEnv);
  writeFileSync(environmentsPath, JSON.stringify(parsed, null, 2) + '\n');
  console.log(
    `[emberflow] Migrated inline secret values from ${ENVIRONMENTS_FILENAME} into ${SECRETS_FILENAME} (0600). ` +
      `${ENVIRONMENTS_FILENAME} now holds secret key NAMES only; a .bak of the original was kept.`,
  );
}

/**
 * Merges an env's declared key names with the values present in the secrets
 * file: resolved map = names ∪ secrets-file keys, value from the secrets file
 * (with $ENV resolution) or '' when absent so requireSecret still throws.
 */
function resolveEnvironment(
  env: RawEnvironmentDefinition,
  fileSecrets: Record<string, string> | undefined,
): EnvironmentDefinition {
  const names = Array.isArray(env.secrets) ? env.secrets : Object.keys(env.secrets ?? {});
  const keys = new Set<string>([...names, ...Object.keys(fileSecrets ?? {})]);
  const secrets: Record<string, string> = {};
  for (const key of keys) {
    const raw = fileSecrets?.[key];
    secrets[key] = raw === undefined ? '' : resolveSecretValue(raw);
  }
  return {
    vars: env.vars ?? {},
    secrets,
    ...(env.protected !== undefined ? { protected: env.protected } : {}),
    ...(env.auth !== undefined ? { auth: env.auth } : {}),
  };
}

export interface RunSafetyRequest {
  safeMode?: boolean;
  confirm?: string;
}

export type RunSafetyResolution =
  | { ok: true; safeMode: boolean }
  | { ok: false; error: string };

/**
 * Resolves the effective `safeMode` for a run against a given environment.
 *
 * - Omitted `safeMode` defaults to the environment's protection: `true` when
 *   `protected`, `false` otherwise.
 * - Explicitly requesting `safeMode: false` on a protected environment is
 *   refused unless `confirm` matches the environment name exactly.
 * - Any other explicit request (including `safeMode: true` on any env, or
 *   `safeMode: false` on a non-protected env) is honored as-is.
 */
export function resolveRunSafety(
  envName: string,
  env: EnvironmentDefinition,
  request: RunSafetyRequest,
): RunSafetyResolution {
  const isProtected = !!env.protected;
  if (request.safeMode === undefined) {
    return { ok: true, safeMode: isProtected };
  }
  if (request.safeMode === false && isProtected && request.confirm !== envName) {
    return { ok: false, error: `unsafe run on protected environment '${envName}' requires confirm` };
  }
  return { ok: true, safeMode: request.safeMode };
}

/**
 * Loads `emberflow.environments.json` from `cwd`.
 *
 * - File present: parsed and validated; malformed files throw with a clear
 *   message (meant to fail the boot loudly rather than run with bad config).
 * - File absent but `emberflow.secrets.json` present: synthesizes a single
 *   `local` environment from it (logs a hint to migrate) so existing setups
 *   keep working.
 * - Neither file present: an empty `local` environment (matches the previous
 *   loadSecrets() behavior of defaulting to {} when nothing is configured).
 *
 * Secret VALUES are read from `emberflow.secrets.json` and merged onto the key
 * NAMES declared in environments.json. A first load of an old-format file
 * (inline values) auto-migrates the values out. See the helpers above.
 */
function parseEnvironmentsFile(environmentsPath: string): RawEnvironmentsFile {
  const raw = readFileSync(environmentsPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${ENVIRONMENTS_FILENAME} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  validateShape(parsed);
  return parsed;
}

export function loadEnvironments(cwd: string): EnvironmentsFile {
  const environmentsPath = resolve(cwd, ENVIRONMENTS_FILENAME);
  const secretsPath = resolve(cwd, SECRETS_FILENAME);

  if (existsSync(environmentsPath)) {
    let parsed = parseEnvironmentsFile(environmentsPath);
    if (needsMigration(parsed)) {
      migrateEnvironmentsFile(environmentsPath, secretsPath, parsed);
      // Re-read so the resolved view reflects the rewritten name-list file.
      parsed = parseEnvironmentsFile(environmentsPath);
    }
    checkSecretsFileHardening(cwd, secretsPath);
    const { byEnv } = readSecretsFile(secretsPath);
    const environments: Record<string, EnvironmentDefinition> = {};
    for (const [name, env] of Object.entries(parsed.environments)) {
      environments[name] = resolveEnvironment(env, byEnv[name]);
    }
    return { defaultEnvironment: parsed.defaultEnvironment, environments, configured: true };
  }

  if (existsSync(secretsPath)) {
    console.log(
      `[emberflow] No ${ENVIRONMENTS_FILENAME} found; synthesizing a "local" environment from ${SECRETS_FILENAME}. ` +
        `Create ${ENVIRONMENTS_FILENAME} to configure multiple environments (see emberflow.environments.example.json).`,
    );
    checkSecretsFileHardening(cwd, secretsPath);
    const { byEnv } = readSecretsFile(secretsPath);
    const names = Object.keys(byEnv);
    const environments: Record<string, EnvironmentDefinition> = {};
    for (const name of names) {
      environments[name] = resolveEnvironment({ secrets: Object.keys(byEnv[name]) }, byEnv[name]);
    }
    // Preserve the historical single synthesized-env behavior: always expose a
    // "local" env even when the file was empty.
    if (!environments.local) {
      environments.local = { vars: {}, secrets: {} };
    }
    return {
      defaultEnvironment: environments.local ? 'local' : names[0],
      environments,
      configured: true,
    };
  }

  return {
    defaultEnvironment: 'local',
    environments: { local: { vars: {}, secrets: {} } },
    configured: false,
  };
}

// Serializes all environment-file read-modify-write cycles through a single
// promise chain so concurrent setEnvironmentSecret calls can't clobber each
// other (last-write-wins on a sync read-modify-write would drop a secret).
let writeQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => T): Promise<T> {
  const p = writeQueue.then(fn);
  writeQueue = p.catch(() => {});
  return p;
}

/** Current secret key NAMES for an env, from either on-disk shape. */
function secretNames(env: RawEnvironmentDefinition): string[] {
  return Array.isArray(env.secrets) ? [...env.secrets] : Object.keys(env.secrets ?? {});
}

/**
 * Folds any pre-migration inline map VALUES into `bucket` so converting an
 * env's `secrets` to a name list never drops a sibling key's value. File
 * values already present win (they are the current source of truth).
 */
function foldInlineValues(env: RawEnvironmentDefinition, bucket: Record<string, string>): void {
  if (Array.isArray(env.secrets) || !env.secrets) return;
  for (const [k, v] of Object.entries(env.secrets)) {
    if (v !== '' && !(k in bucket)) bucket[k] = v;
  }
}

/**
 * Sets a single secret's VALUE in `emberflow.secrets.json` (0600) and ensures
 * its key NAME is listed on the environment in `emberflow.environments.json`,
 * both at `cwd`. The value never touches environments.json. Throws if the
 * environments file is missing/malformed or the environment name is unknown.
 * Concurrent calls are serialized so two in-flight writes never clobber each other.
 */
export function setEnvironmentSecret(cwd: string, envName: string, key: string, value: string): Promise<void> {
  return enqueue(() => {
    const environmentsPath = resolve(cwd, ENVIRONMENTS_FILENAME);
    const secretsPath = resolve(cwd, SECRETS_FILENAME);
    const parsed = parseEnvironmentsFile(environmentsPath);
    const env = parsed.environments[envName];
    if (!env) {
      throw new Error(`${ENVIRONMENTS_FILENAME}: unknown environment "${envName}"`);
    }
    // Value → secrets file (0600).
    const { byEnv } = readSecretsFile(secretsPath);
    const bucket = { ...(byEnv[envName] ?? {}) };
    foldInlineValues(env, bucket);
    bucket[key] = value;
    byEnv[envName] = bucket;
    writeSecretsFile(secretsPath, byEnv);
    // Name → environments.json (list form).
    const names = secretNames(env);
    if (!names.includes(key)) names.push(key);
    env.secrets = names;
    writeFileSync(environmentsPath, JSON.stringify(parsed, null, 2) + '\n');
  });
}

/**
 * Sets (or, when `auth` is `null`, clears) an environment's `auth` config in
 * `emberflow.environments.json` at `cwd` and persists the change. Validates
 * the auth shape before writing. Throws if the environments file is
 * missing/malformed, the environment name is unknown, or `auth` is invalid.
 * Preserves the environment's other fields (secrets, vars, protected,
 * unknown fields). Shares the write queue with `setEnvironmentSecret` so
 * concurrent writers can't clobber each other.
 */
export function setEnvironmentAuth(cwd: string, envName: string, auth: EnvAuth | null): Promise<void> {
  return enqueue(() => {
    if (auth !== null) {
      const authError = validateAuthShape(auth);
      if (authError !== null) {
        throw new Error(`${ENVIRONMENTS_FILENAME}: environments.${envName}.${authError}`);
      }
    }
    const environmentsPath = resolve(cwd, ENVIRONMENTS_FILENAME);
    const parsed = parseEnvironmentsFile(environmentsPath);
    const env = parsed.environments[envName];
    if (!env) {
      throw new Error(`${ENVIRONMENTS_FILENAME}: unknown environment "${envName}"`);
    }
    if (auth === null) {
      delete env.auth;
    } else {
      env.auth = auth;
    }
    writeFileSync(environmentsPath, JSON.stringify(parsed, null, 2) + '\n');
  });
}

/**
 * Removes a single secret from an environment: drops its key NAME from
 * `emberflow.environments.json` and its VALUE from `emberflow.secrets.json`,
 * both at `cwd`. Missing key resolves without error. Throws if the environments
 * file is missing/malformed or the environment name is unknown. Shares the
 * write queue with the other writers.
 */
export function deleteEnvironmentSecret(cwd: string, envName: string, key: string): Promise<void> {
  return enqueue(() => {
    const environmentsPath = resolve(cwd, ENVIRONMENTS_FILENAME);
    const secretsPath = resolve(cwd, SECRETS_FILENAME);
    const parsed = parseEnvironmentsFile(environmentsPath);
    const env = parsed.environments[envName];
    if (!env) {
      throw new Error(`${ENVIRONMENTS_FILENAME}: unknown environment "${envName}"`);
    }
    // Value out of the secrets file (preserving sibling inline values).
    const { byEnv } = readSecretsFile(secretsPath);
    const bucket = { ...(byEnv[envName] ?? {}) };
    foldInlineValues(env, bucket);
    delete bucket[key];
    byEnv[envName] = bucket;
    writeSecretsFile(secretsPath, byEnv);
    // Name out of environments.json (normalizing to list form).
    env.secrets = secretNames(env).filter((n) => n !== key);
    writeFileSync(environmentsPath, JSON.stringify(parsed, null, 2) + '\n');
  });
}
