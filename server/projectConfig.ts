import { existsSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NodeRegistry } from '../src/engine';
import type { VerifierRegistry } from './auth/verifiers';

/**
 * Project mode: a consumer repo drops an emberflow.config file at its root
 * and Emberflow serves THEIR flows and nodes. This loader finds and imports
 * that config. The runner runs under tsx, so dynamic import handles .ts
 * configs as well as .js/.mjs.
 */

const CONFIG_BASENAMES = ['emberflow.config.mjs', 'emberflow.config.js', 'emberflow.config.ts'];

export interface EmberflowUserConfig {
  /** Directory holding <flowId>.json flow files (+ <flowId>.scenarios.json sidecars). Relative to the config file. */
  flowsDir?: string;
  /** Register the project's own node types. */
  registerNodes?: (registry: NodeRegistry) => void;
  /** Register custom auth verifiers (e.g. real JWT) alongside the default bearer/apiKey ones. */
  registerVerifiers?: (registry: VerifierRegistry) => void;
  /** Op id to run when any run finishes with status 'failed' (best-effort; never blocks the failed run). */
  errorOperation?: string;
  /** Authoritative signal for agents/tooling about which language this project's
   *  APIs/nodes are authored in. When absent, it's inferred from the config file's
   *  own extension (`emberflow.config.ts` → 'typescript', else 'javascript'). */
  language?: 'javascript' | 'typescript';
}

/** Identity helper so consumer configs get typing: `export default defineConfig({...})`. */
export function defineConfig(config: EmberflowUserConfig): EmberflowUserConfig {
  return config;
}

export interface ProjectConfig {
  root: string;
  flowsDir: string;
  language: 'javascript' | 'typescript';
  /** Present only when the config's `language` field was EXPLICIT and
   *  disagrees with the config file's own extension (e.g. `language:
   *  'javascript'` in an `emberflow.config.ts`). Inference makes language and
   *  extension agree by construction, so this is the only detectable drift —
   *  see src/engine/diagnostics.ts's `language-drift` check, which callers
   *  (server/index.ts's diagnostics route, `doctor`) feed this into. */
  languageDrift?: { projectLanguage: 'javascript' | 'typescript'; configPathExtension: string };
  registerNodes?: (registry: NodeRegistry) => void;
  registerVerifiers?: (registry: VerifierRegistry) => void;
  errorOperation?: string;
}

/** The resolved emberflow.config.* path for a project dir, or undefined. */
export function configPathFor(dir: string): string | undefined {
  const root = resolve(dir);
  return CONFIG_BASENAMES.map((b) => join(root, b)).find(existsSync);
}

/**
 * Loads a project's config. `fresh: true` cache-busts the dynamic import so an
 * edited config re-imports (the module loader caches by URL) — used by the
 * in-process node hot-reload so editing registerNodes takes effect without a
 * process restart (which would kill in-flight agent runs).
 */
export async function loadProjectConfig(
  dir: string,
  opts: { fresh?: boolean } = {},
): Promise<ProjectConfig | null> {
  const root = resolve(dir);
  const file = CONFIG_BASENAMES.map((b) => join(root, b)).find(existsSync);
  if (!file) return null;
  let raw: EmberflowUserConfig;
  try {
    const url = pathToFileURL(file).href + (opts.fresh ? `?t=${Date.now()}` : '');
    const mod = (await import(url)) as { default?: EmberflowUserConfig };
    raw = mod.default ?? {};
  } catch (err) {
    throw new Error(`Failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const flowsDir = raw.flowsDir
    ? isAbsolute(raw.flowsDir) ? raw.flowsDir : join(root, raw.flowsDir)
    : join(root, 'emberflow', 'flows');
  // Explicit `language` wins; otherwise infer from the config file's own
  // extension — a .ts config implies a TypeScript project, everything else JS.
  const inferredLanguage: 'javascript' | 'typescript' = file.endsWith('.ts') ? 'typescript' : 'javascript';
  const language: 'javascript' | 'typescript' = raw.language ?? inferredLanguage;
  // Drift is only detectable when the field is EXPLICIT: inferred language
  // agrees with the extension by construction, so there's nothing to flag.
  const languageDrift =
    raw.language && raw.language !== inferredLanguage
      ? { projectLanguage: raw.language, configPathExtension: extname(file) }
      : undefined;
  return {
    root,
    flowsDir,
    language,
    ...(languageDrift ? { languageDrift } : {}),
    ...(raw.registerNodes ? { registerNodes: raw.registerNodes } : {}),
    ...(raw.registerVerifiers ? { registerVerifiers: raw.registerVerifiers } : {}),
    ...(raw.errorOperation ? { errorOperation: raw.errorOperation } : {}),
  };
}
