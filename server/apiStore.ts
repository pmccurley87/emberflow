import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuthPolicy, HttpTrigger, WorkflowDefinition } from '../src/engine';

export interface OpSummary { id: string; name: string; path: string; http?: HttpTrigger }
export interface FolderNode { name: string; folders: FolderNode[]; operations: OpSummary[] }
export interface ApiNode { name: string; folders: FolderNode[]; operations: OpSummary[] }
export interface ApiTree { apis: ApiNode[] }

/** File-backed store over an `apis/<api>/<folder…>/<op>.json` tree. Keys ops by
 *  their in-file `id`; tracks each op's relative path (POSIX, no `.json`). */
export class ApiStore {
  readonly dir: string;
  /** id → relative path (POSIX, no extension). Rebuilt on every scan. */
  private index = new Map<string, string>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }

  private sidecarFor(relPath: string): string {
    return join(this.dir, ...relPath.split('/')) + '.scenarios.json';
  }

  /** Sidecar files come in two shapes: the legacy bare array (scenarios only —
   *  still written when an op has no mocks, for human-editability/back-compat)
   *  and `{ scenarios?, mocks? }`, used once an op carries op-level mocks. */
  private withSidecar(flow: WorkflowDefinition, relPath: string): WorkflowDefinition {
    const path = this.sidecarFor(relPath);
    if (!existsSync(path)) return flow;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        return raw.length > 0 ? { ...flow, scenarios: raw as WorkflowDefinition['scenarios'] } : flow;
      }
      if (raw && typeof raw === 'object') {
        const { scenarios, mocks } = raw as { scenarios?: WorkflowDefinition['scenarios']; mocks?: Record<string, unknown> };
        let out = flow;
        if (Array.isArray(scenarios) && scenarios.length > 0) out = { ...out, scenarios };
        if (mocks && typeof mocks === 'object') out = { ...out, mocks };
        return out;
      }
      return flow;
    } catch (err) {
      console.warn(`[apiStore] skipping unparseable ${relPath}.scenarios.json: ${String(err)}`);
      return flow;
    }
  }

  /** Reads just the sidecar's top-level `mocks`, ignoring `scenarios` — used
   *  by `save` to preserve mocks when the incoming flow doesn't carry them. */
  private readSidecarMocks(relPath: string): Record<string, unknown> | undefined {
    const path = this.sidecarFor(relPath);
    if (!existsSync(path)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (Array.isArray(raw) || !raw || typeof raw !== 'object') return undefined;
      const { mocks } = raw as { mocks?: Record<string, unknown> };
      return mocks && typeof mocks === 'object' ? mocks : undefined;
    } catch {
      return undefined;
    }
  }

  /** Recursively collect operation files as { flow, relPath }. */
  private scan(): Array<{ flow: WorkflowDefinition; relPath: string }> {
    const out: Array<{ flow: WorkflowDefinition; relPath: string }> = [];
    this.index = new Map();
    const walk = (absDir: string, relParts: string[]): void => {
      for (const entry of readdirSync(absDir)) {
        const abs = join(absDir, entry);
        if (statSync(abs).isDirectory()) {
          walk(abs, [...relParts, entry]);
          continue;
        }
        if (entry === '_meta.json') continue;
        if (!entry.endsWith('.json') || entry.endsWith('.scenarios.json')) continue;
        const relPath = [...relParts, entry.slice(0, -'.json'.length)].join('/');
        try {
          const flow = JSON.parse(readFileSync(abs, 'utf8')) as WorkflowDefinition;
          const existing = this.index.get(flow.id);
          if (existing !== undefined && existing !== relPath) {
            console.warn(`[apiStore] duplicate operation id "${flow.id}" at ${existing} and ${relPath} — only one is reachable`);
          } else {
            this.index.set(flow.id, relPath);
          }
          out.push({ flow, relPath });
        } catch (err) {
          console.warn(`[apiStore] skipping unparseable ${relPath}.json: ${String(err)}`);
        }
      }
    };
    walk(this.dir, []);
    return out;
  }

  list(): WorkflowDefinition[] {
    return this.scan().map(({ flow, relPath }) => this.withSidecar(flow, relPath));
  }

  /** One entry per operation with its on-disk relative path and `http` metadata
   *  (id/name/http from the file itself), for the studio's tree view. */
  listSummaries(): OpSummary[] {
    return this.scan().map(({ flow, relPath }) => ({ id: flow.id, name: flow.name, path: relPath, http: flow.http }));
  }

  /** True when an operation file already sits at `relPath` — used by
   *  POST /operations to refuse to silently overwrite an existing op with a
   *  brand-new one saved at the same path. */
  existsAt(relPath: string): boolean {
    const abs = join(this.dir, ...relPath.split('/')) + '.json';
    return existsSync(abs);
  }

  load(id: string): WorkflowDefinition | undefined {
    const relPath = this.pathOf(id);
    if (!relPath) return undefined;
    const abs = join(this.dir, ...relPath.split('/')) + '.json';
    if (!existsSync(abs)) return undefined;
    try {
      const flow = JSON.parse(readFileSync(abs, 'utf8')) as WorkflowDefinition;
      return this.withSidecar(flow, relPath);
    } catch (err) {
      console.warn(`[apiStore] skipping unparseable ${relPath}.json: ${String(err)}`);
      return undefined;
    }
  }

  /** id → relative path. Always rescans so it reflects the current on-disk state
   *  (files may be added/renamed/deleted out-of-band by a coding agent). */
  pathOf(id: string): string | undefined {
    this.scan();
    return this.index.get(id);
  }

  tree(): ApiTree {
    const ops = this.scan();
    const apis = new Map<string, ApiNode>();
    const folderAt = (parent: { folders: FolderNode[] }, name: string): FolderNode => {
      let f = parent.folders.find((x) => x.name === name);
      if (!f) { f = { name, folders: [], operations: [] }; parent.folders.push(f); }
      return f;
    };
    for (const { flow, relPath } of ops) {
      const parts = relPath.split('/'); // [api, ...folders, opName]
      const apiName = parts[0];
      let api = apis.get(apiName);
      if (!api) { api = { name: apiName, folders: [], operations: [] }; apis.set(apiName, api); }
      const folderParts = parts.slice(1, -1);
      let container: { folders: FolderNode[]; operations: OpSummary[] } = api;
      for (const fp of folderParts) container = folderAt(container, fp);
      container.operations.push({ id: flow.id, name: flow.name, path: relPath, http: flow.http });
    }
    return { apis: [...apis.values()] };
  }

  save(flow: WorkflowDefinition, relPath: string): void {
    const abs = join(this.dir, ...relPath.split('/')) + '.json';
    if (existsSync(abs)) {
      try {
        const existing = JSON.parse(readFileSync(abs, 'utf8')) as WorkflowDefinition;
        if (existing.id !== undefined && existing.id !== flow.id) {
          console.warn(`[apiStore] overwriting ${relPath} which held a different op id "${existing.id}"`);
        }
      } catch {
        // unparseable existing file — nothing sensible to compare, proceed with the write.
      }
    }
    mkdirSync(dirname(abs), { recursive: true });
    const { scenarios, mocks, ...rest } = flow;
    writeFileSync(abs, `${JSON.stringify(rest, null, 2)}\n`, 'utf8');
    const sidecar = this.sidecarFor(relPath);
    // A flow argument that doesn't carry `mocks` at all (undefined — not an
    // empty object) means the caller never touched op-level mocks (e.g. a
    // scenario-only edit round-tripped through a client that doesn't forward
    // unknown fields) — preserve whatever is already on disk rather than
    // silently dropping it.
    const effectiveMocks = mocks !== undefined ? mocks : this.readSidecarMocks(relPath);
    const hasScenarios = scenarios !== undefined && scenarios.length > 0;
    const hasMocks = effectiveMocks !== undefined && Object.keys(effectiveMocks).length > 0;
    if (hasMocks) {
      writeFileSync(
        sidecar,
        `${JSON.stringify({ ...(hasScenarios ? { scenarios } : {}), mocks: effectiveMocks }, null, 2)}\n`,
        'utf8',
      );
    } else if (hasScenarios) {
      writeFileSync(sidecar, `${JSON.stringify(scenarios, null, 2)}\n`, 'utf8');
    } else if (existsSync(sidecar)) {
      rmSync(sidecar);
    }
    this.index.set(flow.id, relPath);
  }

  remove(id: string): boolean {
    const relPath = this.pathOf(id);
    if (!relPath) return false;
    const abs = join(this.dir, ...relPath.split('/')) + '.json';
    if (!existsSync(abs)) return false;
    rmSync(abs);
    const sidecar = this.sidecarFor(relPath);
    if (existsSync(sidecar)) rmSync(sidecar);
    this.index.delete(id);
    return true;
  }

  /** Resolves the effective auth policy for an operation: walks the op's path
   *  from the API root down through each folder, reading `_meta.json`'s `auth`
   *  (nearest ancestor default), then applies the op's own `http.auth`
   *  override — `'none'` -> explicitly public (null), a policy object -> that
   *  policy, `'inherit'`/absent -> the inherited default. Returns the
   *  effective policy or null (no auth — public by default). */
  resolveAuth(id: string): AuthPolicy | null {
    const relPath = this.pathOf(id);
    if (!relPath) return null;
    const parts = relPath.split('/'); // [api, ...folders, opName]
    let inherited: AuthPolicy | null = null;
    for (let depth = 1; depth < parts.length; depth++) {
      const metaPath = join(this.dir, ...parts.slice(0, depth), '_meta.json');
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { auth?: AuthPolicy };
        if (meta.auth) inherited = meta.auth;
      } catch (err) {
        // A present-but-corrupt _meta.json (partial write, typo, etc.) must
        // never silently resolve to `null` (= public) — that's a fail-open
        // security hole. Fail closed: throw and let the caller deny the op
        // rather than mount it open. A merely ABSENT _meta.json is fine (see
        // the `existsSync` check above) — only a broken one throws.
        const metaRelPath = `${parts.slice(0, depth).join('/')}/_meta.json`;
        throw new Error(`unparseable _meta.json at ${metaRelPath} — refusing to resolve auth (fail closed): ${String(err)}`);
      }
    }
    const op = this.load(id);
    const override = op?.http?.auth;
    if (override === 'none') return null;
    if (override && override !== 'inherit') return override;
    return inherited;
  }
}
