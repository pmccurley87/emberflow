import { spawnSync } from 'node:child_process';
import type { AgentKind } from './types';

const CANDIDATES: AgentKind[] = ['codex', 'claude'];

const VERSION_RE = /\d+\.\d+\.\d+/;

export interface DetectedAgent {
  kind: AgentKind;
  version: string | null;
}

/**
 * Real PATH probe: runs `<bin> --version` and parses the first semver-ish
 * token out of stdout. Returns `undefined` when the binary isn't present/
 * runnable (spawn error, timeout, or nonzero exit); `null` version when it
 * ran but produced no parseable version string.
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

/**
 * Detects which coding-agent CLIs are available on PATH, and the version
 * each reports (null when present but unparseable). `probeBin` is
 * injectable so tests can stub PATH presence/version without shelling out
 * for real binaries.
 */
export function detectAgents(probeBin: (bin: string) => { version: string | null } | undefined = probe): DetectedAgent[] {
  const found: DetectedAgent[] = [];
  for (const kind of CANDIDATES) {
    const result = probeBin(kind);
    if (result) found.push({ kind, version: result.version });
  }
  return found;
}
