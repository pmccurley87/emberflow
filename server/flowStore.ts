import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorkflowDefinition } from '../src/engine';

export interface FlowStoreOptions {
  /**
   * Project mode: scenarios live in <id>.scenarios.json next to the flow
   * file (reviewable, hand-editable "stories"), not embedded in the flow.
   */
  scenarioSidecars?: boolean;
}

/**
 * Runner-owned store of workflow files. Each flow lives at `<dir>/<id>.json`,
 * pretty-printed. The directory is the source of truth when the runner is
 * online; the browser adopts it on first successful health check.
 */
export class FlowStore {
  readonly dir: string;
  private readonly sidecars: boolean;

  constructor(dir: string = resolve(process.cwd(), 'workflows'), options: FlowStoreOptions = {}) {
    this.dir = dir;
    this.sidecars = options.scenarioSidecars ?? false;
    mkdirSync(this.dir, { recursive: true });
  }

  private sidecarPath(id: string): string {
    return join(this.dir, `${id}.scenarios.json`);
  }

  /** Merge <id>.scenarios.json into the flow when sidecar mode is on. */
  private withSidecar(flow: WorkflowDefinition): WorkflowDefinition {
    if (!this.sidecars) return flow;
    const path = this.sidecarPath(flow.id);
    if (!existsSync(path)) return flow;
    try {
      const scenarios = JSON.parse(readFileSync(path, 'utf8')) as WorkflowDefinition['scenarios'];
      return Array.isArray(scenarios) && scenarios.length > 0 ? { ...flow, scenarios } : flow;
    } catch (err) {
      console.warn(`[flowStore] skipping unparseable ${flow.id}.scenarios.json: ${String(err)}`);
      return flow;
    }
  }

  /** All parseable *.json flows. Unparseable files are skipped with a warning. */
  list(): WorkflowDefinition[] {
    const flows: WorkflowDefinition[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json') || file.endsWith('.scenarios.json')) continue;
      const path = join(this.dir, file);
      try {
        const flow = JSON.parse(readFileSync(path, 'utf8')) as WorkflowDefinition;
        flows.push(this.withSidecar(flow));
      } catch (err) {
        console.warn(`[flowStore] skipping unparseable ${file}: ${String(err)}`);
      }
    }
    return flows;
  }

  /** Load a single flow by id, or undefined when its file is missing/unparseable. */
  load(id: string): WorkflowDefinition | undefined {
    const path = join(this.dir, `${id}.json`);
    if (!existsSync(path)) return undefined;
    try {
      const flow = JSON.parse(readFileSync(path, 'utf8')) as WorkflowDefinition;
      return this.withSidecar(flow);
    } catch (err) {
      console.warn(`[flowStore] skipping unparseable ${id}.json: ${String(err)}`);
      return undefined;
    }
  }

  /** Persist a flow. Its id must be a non-empty string and names the file. */
  save(flow: WorkflowDefinition): void {
    if (!flow || typeof flow.id !== 'string' || flow.id.length === 0) {
      throw new Error('Flow must have a non-empty string id');
    }
    const path = join(this.dir, `${flow.id}.json`);
    if (this.sidecars) {
      const { scenarios, ...rest } = flow;
      writeFileSync(path, `${JSON.stringify(rest, null, 2)}\n`, 'utf8');
      const sidecar = this.sidecarPath(flow.id);
      if (scenarios && scenarios.length > 0) {
        writeFileSync(sidecar, `${JSON.stringify(scenarios, null, 2)}\n`, 'utf8');
      } else if (existsSync(sidecar)) {
        unlinkSync(sidecar);
      }
      return;
    }
    writeFileSync(path, `${JSON.stringify(flow, null, 2)}\n`, 'utf8');
  }

  /** Delete a flow file (and any scenario sidecar). Returns false when it did not exist. */
  remove(id: string): boolean {
    const sidecar = this.sidecarPath(id);
    if (existsSync(sidecar)) unlinkSync(sidecar);
    const path = join(this.dir, `${id}.json`);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }

  /** Seed the given flows only when the directory holds no json files yet. */
  seedIfEmpty(flows: WorkflowDefinition[]): void {
    const hasJson = readdirSync(this.dir).some(
      (f) => f.endsWith('.json') && !f.endsWith('.scenarios.json'),
    );
    if (hasJson) return;
    for (const flow of flows) this.save(flow);
  }

  /**
   * Seed only flows the store doesn't know yet (by id). Existing copies —
   * possibly user-edited — are never overwritten, so new built-in example
   * flows appear after an upgrade without clobbering anything.
   */
  seedMissing(flows: WorkflowDefinition[]): void {
    const known = new Set(this.list().map((f) => f.id));
    for (const flow of flows) {
      if (!known.has(flow.id)) this.save(flow);
    }
  }
}
