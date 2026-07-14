import { readFileSync, statSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type * as TS from 'typescript';
import { isPathWithin } from './pathSafety';

/**
 * Source navigation for the studio's node-implementation view: serve a whole
 * project file plus a flat symbol table (top-level declarations, imports with
 * resolutions, re-exports) so the client can render identifiers as links and
 * navigate file-by-file. One flat parse per file, mtime-cached; recursion
 * happens client-side by fetching the next file — except re-export chains,
 * which the server follows (bounded, cycle-safe) so an import through an
 * index module resolves straight to the declaring file.
 *
 * TypeScript is loaded lazily on first use (`await import('typescript')`);
 * when that fails the file is still served with `resolver: 'unavailable'`
 * and empty symbols, and the studio shows unresolved-with-reason.
 */

export type Resolution =
  | { kind: 'project'; path: string; line?: number }
  | { kind: 'external'; package: string }
  | { kind: 'builtin' }
  | { kind: 'unresolved'; reason: string };

export interface SourceDeclaration {
  name: string;
  kind: 'fn' | 'const' | 'class' | 'other';
  line: number;
  endLine: number;
  exported: boolean;
}

export interface SourceImport {
  /** Imported name in the source module ('default', '*' for namespace, 'import()' for dynamic). */
  name: string;
  /** Local binding name in the served file ('' when there is none). */
  local: string;
  /** The specifier as written. */
  from: string;
  resolution: Resolution;
}

export interface SourceReexport {
  name: string;
  from: string;
  resolution: Resolution;
}

export interface SourceFilePayload {
  path: string;
  content: string;
  language: 'ts' | 'js';
  /** Present (as 'unavailable') only when the typescript module could not be loaded. */
  resolver?: 'unavailable';
  symbols: {
    declarations: SourceDeclaration[];
    imports: SourceImport[];
    reexports: SourceReexport[];
  };
}

export type SourceFileResult =
  | { ok: true; payload: SourceFilePayload }
  | { ok: false; status: 400 | 404; error: string };

export interface SourceNavOptions {
  /** Test seam: overrides the lazy `import('typescript')` for this call only. */
  tsLoader?: () => Promise<TsModule>;
}

type TsModule = typeof TS;

// ---------------------------------------------------------------------------
// Lazy typescript module

let tsModulePromise: Promise<TsModule> | undefined;

async function loadTs(loader?: () => Promise<TsModule>): Promise<TsModule | undefined> {
  if (loader) {
    try {
      return await loader();
    } catch {
      return undefined;
    }
  }
  if (!tsModulePromise) {
    tsModulePromise = import('typescript').then(
      (m) => ((m as { default?: TsModule }).default ?? m) as TsModule,
    );
  }
  try {
    return await tsModulePromise;
  } catch {
    tsModulePromise = undefined; // allow a later retry (e.g. install completed)
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Path guards

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);

function languageOf(file: string): 'ts' | 'js' {
  return TS_EXTS.has(extname(file)) ? 'ts' : 'js';
}

/** Deny-list beyond isPathWithin: node_modules anywhere, secret basenames. */
function isRequestPathAllowed(projectRoot: string, rel: string): boolean {
  if (!isPathWithin(projectRoot, rel)) return false;
  const segments = rel.split('/');
  if (segments.includes('node_modules')) return false;
  const base = (segments[segments.length - 1] ?? '').toLowerCase();
  if (base.startsWith('.env')) return false;
  if (base === 'emberflow.secrets.json') return false;
  if (base.endsWith('.pem') || base.endsWith('.key')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Parse cache (mtime-keyed, per absolute path)

interface RawImport {
  name: string;
  local: string;
  from: string;
}

interface RawDynamicImport {
  /** Specifier when it was a string literal; undefined for computed ones. */
  from?: string;
}

interface RawReexport {
  /** Exported name; '*' for `export * from`. */
  exported: string;
  /** Name in the source module (propertyName), when this is a named re-export. */
  source?: string;
  from: string;
}

interface ParsedFile {
  content: string;
  language: 'ts' | 'js';
  declarations: SourceDeclaration[];
  imports: RawImport[];
  dynamicImports: RawDynamicImport[];
  reexports: RawReexport[];
}

const parseCache = new Map<string, { mtimeMs: number; parsed: ParsedFile }>();

/** Clears all sourceNav caches (parse, tsconfig, ts module) — tests only. */
export function resetSourceNavCaches(): void {
  parseCache.clear();
  tsconfigCache.clear();
  tsModulePromise = undefined;
}

function scriptKindFor(ts: TsModule, file: string): TS.ScriptKind {
  switch (extname(file)) {
    case '.ts':
    case '.mts':
    case '.cts':
      return ts.ScriptKind.TS;
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}

function parseFile(ts: TsModule, absPath: string, content: string): ParsedFile {
  const sf = ts.createSourceFile(
    absPath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(ts, absPath),
  );
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const hasExportModifier = (node: TS.Node): boolean => {
    const mods = (node as { modifiers?: readonly TS.Node[] }).modifiers;
    return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  };

  const declarations: SourceDeclaration[] = [];
  const imports: RawImport[] = [];
  const reexports: RawReexport[] = [];
  const dynamicImports: RawDynamicImport[] = [];
  /** Names exported post-hoc via a specifier-less `export { x }`. */
  const localExports = new Set<string>();

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      declarations.push({
        name: stmt.name.text,
        kind: 'fn',
        line: lineOf(stmt.getStart(sf)),
        endLine: lineOf(stmt.end),
        exported: hasExportModifier(stmt),
      });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      declarations.push({
        name: stmt.name.text,
        kind: 'class',
        line: lineOf(stmt.getStart(sf)),
        endLine: lineOf(stmt.end),
        exported: hasExportModifier(stmt),
      });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          declarations.push({
            name: decl.name.text,
            kind: 'const',
            line: lineOf(decl.getStart(sf)),
            endLine: lineOf(stmt.end),
            exported: hasExportModifier(stmt),
          });
        }
      }
    } else if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      declarations.push({
        name: stmt.name.text,
        kind: 'other',
        line: lineOf(stmt.getStart(sf)),
        endLine: lineOf(stmt.end),
        exported: hasExportModifier(stmt),
      });
    } else if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const from = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (!clause) {
        imports.push({ name: '*', local: '', from }); // side-effect import
        continue;
      }
      if (clause.name) imports.push({ name: 'default', local: clause.name.text, from });
      const bindings = clause.namedBindings;
      if (bindings) {
        if (ts.isNamespaceImport(bindings)) {
          imports.push({ name: '*', local: bindings.name.text, from });
        } else {
          for (const el of bindings.elements) {
            imports.push({ name: (el.propertyName ?? el.name).text, local: el.name.text, from });
          }
        }
      }
    } else if (ts.isExportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) {
        const from = spec.text;
        if (!stmt.exportClause) {
          reexports.push({ exported: '*', from });
        } else if (ts.isNamespaceExport(stmt.exportClause)) {
          reexports.push({ exported: stmt.exportClause.name.text, source: '*', from });
        } else {
          for (const el of stmt.exportClause.elements) {
            reexports.push({
              exported: el.name.text,
              source: (el.propertyName ?? el.name).text,
              from,
            });
          }
        }
      } else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          localExports.add((el.propertyName ?? el.name).text);
        }
      }
    }
  }

  // `export { x }` after the declaration marks it exported.
  for (const d of declarations) {
    if (!d.exported && localExports.has(d.name)) d.exported = true;
  }

  // Dynamic imports live anywhere in the tree.
  const visit = (node: TS.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = node.arguments[0];
      dynamicImports.push(
        arg && ts.isStringLiteral(arg) ? { from: arg.text } : {},
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { content, language: languageOf(absPath), declarations, imports, dynamicImports, reexports };
}

/** Parse (or reuse the cached parse of) an absolute path. Throws when unreadable. */
function getParsed(ts: TsModule, absPath: string): ParsedFile {
  const stat = statSync(absPath);
  const cached = parseCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.parsed;
  const content = readFileSync(absPath, 'utf8');
  const parsed = parseFile(ts, absPath, content);
  parseCache.set(absPath, { mtimeMs: stat.mtimeMs, parsed });
  return parsed;
}

function getParsedSafe(ts: TsModule, absPath: string): ParsedFile | undefined {
  try {
    return getParsed(ts, absPath);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Specifier resolution

const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
/** TS-style specifier mapping: an emitted-extension specifier may point at TS source. */
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Extension ladder: exact → +ext → TS .js→.ts mapping → /index.*  */
function resolveWithLadder(base: string): string | undefined {
  if (isFile(base)) return base;
  for (const ext of RESOLVE_EXTS) {
    if (isFile(base + ext)) return base + ext;
  }
  for (const [jsExt, tsExts] of Object.entries(JS_TO_TS)) {
    if (base.endsWith(jsExt)) {
      const stem = base.slice(0, -jsExt.length);
      for (const tsExt of tsExts) {
        if (isFile(stem + tsExt)) return stem + tsExt;
      }
    }
  }
  for (const ext of RESOLVE_EXTS) {
    const idx = join(base, 'index' + ext);
    if (isFile(idx)) return idx;
  }
  return undefined;
}

// tsconfig `paths` support (single-star patterns), mtime-cached per root.
interface TsconfigPaths {
  base: string;
  entries: Array<{ prefix: string; suffix: string; exact?: string; targets: string[] }>;
}

const tsconfigCache = new Map<string, { mtimeMs: number; paths: TsconfigPaths | undefined }>();

function tsconfigPathsFor(ts: TsModule, projectRoot: string): TsconfigPaths | undefined {
  const cfgPath = join(projectRoot, 'tsconfig.json');
  let mtimeMs: number;
  try {
    mtimeMs = statSync(cfgPath).mtimeMs;
  } catch {
    return undefined;
  }
  const cached = tsconfigCache.get(cfgPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.paths;

  let paths: TsconfigPaths | undefined;
  try {
    // ts.readConfigFile parses leniently — tsconfig.json is JSONC.
    const { config } = ts.readConfigFile(cfgPath, (p) => readFileSync(p, 'utf8'));
    const options = (config as { compilerOptions?: { baseUrl?: string; paths?: Record<string, unknown> } })
      ?.compilerOptions;
    const rawPaths = options?.paths;
    if (rawPaths && typeof rawPaths === 'object') {
      const entries: TsconfigPaths['entries'] = [];
      for (const [pattern, targetsRaw] of Object.entries(rawPaths)) {
        if (!Array.isArray(targetsRaw)) continue;
        const targets = targetsRaw.filter((t): t is string => typeof t === 'string');
        const stars = pattern.split('*').length - 1;
        if (stars === 0) {
          entries.push({ prefix: '', suffix: '', exact: pattern, targets });
        } else if (stars === 1) {
          const [prefix = '', suffix = ''] = pattern.split('*');
          entries.push({ prefix, suffix, targets });
        }
        // multi-star patterns are invalid tsconfig anyway — ignored
      }
      // Longest prefix wins, mirroring TS's matching order.
      entries.sort((a, b) => (b.exact ?? b.prefix).length - (a.exact ?? a.prefix).length);
      paths = { base: resolve(projectRoot, options?.baseUrl ?? '.'), entries };
    }
  } catch {
    paths = undefined;
  }
  tsconfigCache.set(cfgPath, { mtimeMs, paths });
  return paths;
}

function resolveViaTsconfigPaths(ts: TsModule, projectRoot: string, spec: string): string | undefined {
  const cfg = tsconfigPathsFor(ts, projectRoot);
  if (!cfg) return undefined;
  for (const entry of cfg.entries) {
    let substituted: string[] | undefined;
    if (entry.exact !== undefined) {
      if (spec === entry.exact) substituted = entry.targets;
    } else if (
      spec.startsWith(entry.prefix) &&
      spec.endsWith(entry.suffix) &&
      spec.length >= entry.prefix.length + entry.suffix.length
    ) {
      const middle = spec.slice(entry.prefix.length, spec.length - entry.suffix.length);
      substituted = entry.targets.map((t) => t.replace('*', middle));
    }
    if (!substituted) continue;
    for (const target of substituted) {
      const found = resolveWithLadder(resolve(cfg.base, target));
      if (found) return found;
    }
  }
  return undefined;
}

const NODE_BUILTINS = new Set(builtinModules);

/** Repo-relative POSIX path when `abs` sits inside the root (and outside node_modules). */
function projectRelative(projectRoot: string, abs: string): string | undefined {
  const rel = relative(projectRoot, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  if (rel.split('/').includes('node_modules')) return undefined;
  return rel;
}

/**
 * Resolve a specifier from `importerAbs`. Project results carry the ABSOLUTE
 * target path in `absPath` (for chain following); callers convert to
 * repo-relative for the response.
 */
function resolveSpecifier(
  ts: TsModule,
  projectRoot: string,
  importerAbs: string,
  spec: string,
): Resolution & { absPath?: string } {
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const target = resolveWithLadder(resolve(dirname(importerAbs), spec));
    if (!target) return { kind: 'unresolved', reason: `cannot resolve relative import '${spec}'` };
    const rel = projectRelative(projectRoot, target);
    if (!rel) return { kind: 'unresolved', reason: 'resolves outside the project root' };
    return { kind: 'project', path: rel, absPath: target };
  }
  if (isAbsolute(spec)) return { kind: 'unresolved', reason: 'absolute-path specifier' };
  if (spec.startsWith('node:')) return { kind: 'builtin' };
  const viaPaths = resolveViaTsconfigPaths(ts, projectRoot, spec);
  if (viaPaths) {
    const rel = projectRelative(projectRoot, viaPaths);
    if (!rel) return { kind: 'unresolved', reason: 'resolves outside the project root' };
    return { kind: 'project', path: rel, absPath: viaPaths };
  }
  if (NODE_BUILTINS.has(spec)) return { kind: 'builtin' };
  const parts = spec.split('/');
  const pkg = spec.startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
  return { kind: 'external', package: pkg };
}

// ---------------------------------------------------------------------------
// Re-export chain following

const REEXPORT_DEPTH_CAP = 8;

/**
 * Find the file+line where `exportName` is actually DECLARED, starting at
 * `absFile` and following named/star re-exports. Depth-capped, cycle-safe.
 */
function findExportedDeclaration(
  ts: TsModule,
  projectRoot: string,
  absFile: string,
  exportName: string,
  depth = 0,
  seen = new Set<string>(),
): { absFile: string; line: number } | undefined {
  if (depth > REEXPORT_DEPTH_CAP) return undefined;
  const key = `${absFile}::${exportName}`;
  if (seen.has(key)) return undefined;
  seen.add(key);

  const parsed = getParsedSafe(ts, absFile);
  if (!parsed) return undefined;

  const decl =
    parsed.declarations.find((d) => d.exported && d.name === exportName) ??
    parsed.declarations.find((d) => d.name === exportName);
  if (decl) return { absFile, line: decl.line };

  const named = parsed.reexports.find((r) => r.exported === exportName && r.source && r.source !== '*');
  if (named) {
    const res = resolveSpecifier(ts, projectRoot, absFile, named.from);
    if (res.kind === 'project' && res.absPath) {
      return findExportedDeclaration(ts, projectRoot, res.absPath, named.source!, depth + 1, seen);
    }
    return undefined;
  }

  for (const star of parsed.reexports.filter((r) => r.exported === '*')) {
    const res = resolveSpecifier(ts, projectRoot, absFile, star.from);
    if (res.kind !== 'project' || !res.absPath) continue;
    const found = findExportedDeclaration(ts, projectRoot, res.absPath, exportName, depth + 1, seen);
    if (found) return found;
  }
  return undefined;
}

/** Resolution for an import/re-export entry, chased to the declaring file when possible. */
function resolveEntry(
  ts: TsModule,
  projectRoot: string,
  importerAbs: string,
  spec: string,
  symbolName: string | undefined,
): Resolution {
  const res = resolveSpecifier(ts, projectRoot, importerAbs, spec);
  if (res.kind !== 'project' || !res.absPath) {
    const { absPath: _drop, ...pub } = res;
    return pub;
  }
  if (symbolName && symbolName !== '*' && symbolName !== 'default') {
    const found = findExportedDeclaration(ts, projectRoot, res.absPath, symbolName);
    if (found) {
      const rel = projectRelative(projectRoot, found.absFile);
      if (rel) return { kind: 'project', path: rel, line: found.line };
    }
  }
  return { kind: 'project', path: res.path };
}

// ---------------------------------------------------------------------------
// Entry point

export async function getSourceFile(
  projectRoot: string,
  relPath: string,
  opts?: SourceNavOptions,
): Promise<SourceFileResult> {
  const root = resolve(projectRoot);
  // Generic 400: never echo the requested path back to the client.
  if (typeof relPath !== 'string' || !isRequestPathAllowed(root, relPath)) {
    return { ok: false, status: 400, error: 'Invalid or denied path' };
  }
  const abs = resolve(root, relPath);
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return { ok: false, status: 404, error: 'File not found' };
  }
  if (!stat.isFile()) return { ok: false, status: 404, error: 'File not found' };

  const responsePath = relative(root, abs);

  const ts = await loadTs(opts?.tsLoader);
  if (!ts) {
    const content = await fsp.readFile(abs, 'utf8');
    return {
      ok: true,
      payload: {
        path: responsePath,
        content,
        language: languageOf(abs),
        resolver: 'unavailable',
        symbols: { declarations: [], imports: [], reexports: [] },
      },
    };
  }

  let parsed: ParsedFile;
  try {
    parsed = getParsed(ts, abs);
  } catch {
    return { ok: false, status: 404, error: 'File not found' };
  }

  const imports: SourceImport[] = parsed.imports.map((raw) => ({
    name: raw.name,
    local: raw.local,
    from: raw.from,
    resolution: resolveEntry(ts, root, abs, raw.from, raw.name),
  }));
  for (const dyn of parsed.dynamicImports) {
    if (dyn.from !== undefined) {
      imports.push({
        name: 'import()',
        local: '',
        from: dyn.from,
        resolution: resolveEntry(ts, root, abs, dyn.from, undefined),
      });
    } else {
      imports.push({
        name: 'import()',
        local: '',
        from: '(computed)',
        resolution: { kind: 'unresolved', reason: 'dynamic import with a computed specifier' },
      });
    }
  }

  const reexports: SourceReexport[] = parsed.reexports.map((raw) => ({
    name: raw.exported,
    from: raw.from,
    resolution: resolveEntry(
      ts,
      root,
      abs,
      raw.from,
      raw.source && raw.source !== '*' ? raw.source : undefined,
    ),
  }));

  return {
    ok: true,
    payload: {
      path: responsePath,
      content: parsed.content,
      language: parsed.language,
      symbols: { declarations: parsed.declarations, imports, reexports },
    },
  };
}
