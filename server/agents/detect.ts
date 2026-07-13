import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentKind } from './types';

const VERSION_RE = /\d+\.\d+\.\d+/;

/**
 * Where each agent CLI may live, beyond whatever PATH resolves. PATH shims can
 * pin an OLD version (e.g. a superset-managed ~/.superset/bin/codex frozen at
 * a release the API no longer accepts) while a newer binary sits elsewhere —
 * so we probe every known location and pick the NEWEST, never just the first.
 */
const CANDIDATE_BINS: Record<AgentKind, string[]> = {
  codex: [
    'codex', // PATH resolution (may be a pinned shim)
    join(homedir(), '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    // The ChatGPT desktop app bundles its own codex, updated with the app.
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  ],
  claude: ['claude', join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
};

export interface DetectedAgent {
  kind: AgentKind;
  version: string | null;
  /** The concrete binary the newest version was found at — what spawns should use. */
  bin: string;
}

/**
 * Real probe: runs `<bin> --version` and parses the first semver-ish token out
 * of stdout. Returns `undefined` when the binary isn't present/runnable (spawn
 * error, timeout, or nonzero exit); `null` version when it ran but produced no
 * parseable version string.
 */
export function probe(bin: string): { version: string | null } | undefined {
  const result = spawnSync(bin, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 3000,
    encoding: 'utf8',
  });
  if (result.error !== undefined || result.status !== 0) return undefined;
  const match = result.stdout?.match(VERSION_RE);
  return { version: match ? match[0] : null };
}

/** Numeric segment compare; a parseable version always beats null. */
function newer(a: string | null, b: string | null): boolean {
  if (a === null) return false;
  if (b === null) return true;
  const as = a.split('.').map(Number);
  const bs = b.split('.').map(Number);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const d = (as[i] ?? 0) - (bs[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * Detects which coding-agent CLIs are available — probing PATH plus the known
 * install locations for each kind — and keeps the NEWEST version found per
 * kind, with the binary path it came from. `probeBin` is injectable so tests
 * can stub presence/version per location without shelling out.
 */
export function detectAgents(
  probeBin: (bin: string) => { version: string | null } | undefined = probe,
): DetectedAgent[] {
  const found: DetectedAgent[] = [];
  for (const kind of Object.keys(CANDIDATE_BINS) as AgentKind[]) {
    let best: DetectedAgent | undefined;
    const seen = new Set<string>();
    for (const bin of CANDIDATE_BINS[kind]) {
      if (seen.has(bin)) continue;
      seen.add(bin);
      const result = probeBin(bin);
      if (!result) continue;
      if (!best || newer(result.version, best.version)) {
        best = { kind, version: result.version, bin };
      }
    }
    if (best) found.push(best);
  }
  return found;
}

// Probing every candidate spawns several subprocesses; /setup-status and
// /agent/available are polled by the studio, so cache briefly.
const RESOLVE_TTL_MS = 30_000;
let cachedAt = 0;
let cached: DetectedAgent[] | null = null;

/** Cached detection — the newest binary per kind, refreshed every 30s. */
export function detectAgentsCached(): DetectedAgent[] {
  const now = Date.now();
  if (!cached || now - cachedAt > RESOLVE_TTL_MS) {
    cached = detectAgents();
    cachedAt = now;
  }
  return cached;
}

/** The concrete binary path spawns should use for `kind` — the newest found. */
export function resolveAgentBin(kind: AgentKind): string | undefined {
  return detectAgentsCached().find((a) => a.kind === kind)?.bin;
}
