import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The committed, secrets-free infrastructure manifest the scout writes to
 * `emberflow/infrastructure.json` and agents/studio read back. It describes
 * what a (usually brownfield) project already uses — databases, external APIs,
 * providers — with evidence pointing at the files that prove it. Env-var
 * NAMES only ever appear here; never values.
 */

/** The closed set of infrastructure categories the scout classifies items into. */
export const INFRASTRUCTURE_KINDS = [
  'database',
  'http-api',
  'queue',
  'cache',
  'email',
  'llm',
  'auth',
  'framework',
  'storage',
  'other',
] as const;

export type InfrastructureKind = (typeof INFRASTRUCTURE_KINDS)[number];

/** A single file:note pointer proving an item exists. `note` is optional. */
export interface InfrastructureEvidence {
  file: string;
  note?: string;
  /** Unknown fields are preserved on read (forward-compatibility). */
  [key: string]: unknown;
}

/** One discovered piece of infrastructure. */
export interface InfrastructureItem {
  id: string;
  kind: InfrastructureKind;
  name: string;
  evidence: InfrastructureEvidence[];
  /** Env-var NAMES this item likely needs (e.g. "DATABASE_URL") — never values. */
  suggestedSecretRefs: string[];
  /** Non-secret config var NAMES this item likely needs. */
  suggestedVars: string[];
  notes?: string;
  /** Unknown fields are preserved on read (forward-compatibility). */
  [key: string]: unknown;
}

export interface InfrastructureManifest {
  version: number;
  scannedAt?: string;
  greenfield: boolean;
  summary?: string;
  items: InfrastructureItem[];
  /** Unknown top-level fields are preserved on read (forward-compatibility). */
  [key: string]: unknown;
}

export const INFRASTRUCTURE_FILENAME = join('emberflow', 'infrastructure.json');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInfrastructureKind(value: unknown): value is InfrastructureKind {
  return typeof value === 'string' && (INFRASTRUCTURE_KINDS as readonly string[]).includes(value);
}

/**
 * Leniently coerces one raw item into an `InfrastructureItem`. Missing/invalid
 * required fields are defaulted rather than rejected (name/id fall back,
 * unknown `kind` normalizes to "other") and unknown fields pass through, so a
 * slightly-off item from the agent still renders instead of nuking the whole
 * manifest. Returns null only when the item isn't an object at all.
 */
function coerceItem(raw: unknown, index: number): InfrastructureItem | null {
  if (!isPlainObject(raw)) return null;
  const evidenceRaw = Array.isArray(raw.evidence) ? raw.evidence : [];
  const evidence: InfrastructureEvidence[] = evidenceRaw
    .filter(isPlainObject)
    .map((e) => ({ ...e, file: typeof e.file === 'string' ? e.file : '', note: typeof e.note === 'string' ? e.note : undefined }));
  const secretRefs = Array.isArray(raw.suggestedSecretRefs)
    ? raw.suggestedSecretRefs.filter((s): s is string => typeof s === 'string')
    : [];
  const vars = Array.isArray(raw.suggestedVars)
    ? raw.suggestedVars.filter((s): s is string => typeof s === 'string')
    : [];
  return {
    ...raw,
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : `item-${index}`,
    kind: isInfrastructureKind(raw.kind) ? raw.kind : 'other',
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : 'Unnamed',
    evidence,
    suggestedSecretRefs: secretRefs,
    suggestedVars: vars,
    ...(typeof raw.notes === 'string' ? { notes: raw.notes } : {}),
  };
}

/** One-shot per-path warn dedupe so repeated GETs don't spam the log. */
const warnedOnce = new Set<string>();

/**
 * Reads `emberflow/infrastructure.json` from `projectRoot`.
 *
 * - Absent file → `null` (no warning: not-scouted-yet is a normal state).
 * - Malformed (unreadable, invalid JSON, or not the expected shape) → `null`
 *   plus a single warning per path per process. The CALLER decides keep-last-good.
 * - Valid → a leniently-normalized `InfrastructureManifest`: required fields
 *   defaulted, item `kind`s clamped to the enum, unknown fields preserved.
 */
export function loadInfrastructure(projectRoot: string): InfrastructureManifest | null {
  const path = join(projectRoot, INFRASTRUCTURE_FILENAME);
  if (!existsSync(path)) return null;

  const warn = (message: string): null => {
    if (!warnedOnce.has(path)) {
      warnedOnce.add(path);
      console.warn(`[emberflow] ${INFRASTRUCTURE_FILENAME} ${message} — ignoring it (keeping last good state). Re-run the infrastructure scout to regenerate it.`);
    }
    return null;
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Deliberately NOT interpolating the parse error's message: on malformed
    // JSON, JSON.parse's error text often echoes a fragment of the file
    // content around the failure point (e.g. "Unexpected token o in JSON at
    // position 5 ... <10 chars of the file>"), which could leak a fragment of
    // a secret value if one was pasted into this file. Keep the warning generic.
    return warn('is not valid JSON');
  }
  if (!isPlainObject(parsed)) {
    return warn('is not a JSON object at the top level');
  }
  if (parsed.items !== undefined && !Array.isArray(parsed.items)) {
    return warn('has an "items" field that is not an array');
  }

  // A successful read clears any prior warning for this path, so a fixed file
  // warns again cleanly if it later regresses.
  warnedOnce.delete(path);

  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const items = rawItems
    .map((item, i) => coerceItem(item, i))
    .filter((item): item is InfrastructureItem => item !== null);

  return {
    ...parsed,
    version: typeof parsed.version === 'number' ? parsed.version : 1,
    ...(typeof parsed.scannedAt === 'string' ? { scannedAt: parsed.scannedAt } : {}),
    greenfield: parsed.greenfield === true,
    ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
    items,
  };
}
