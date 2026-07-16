import { dirname, join, resolve } from 'node:path';
import { FlowStore } from './flowStore';
import { ApiStore } from './apiStore';
import { migrateFlowsToApis } from './migrateFlows';
import { createDefaultRegistry } from '../src/nodes';
import type { NodeRegistry } from '../src/engine';
import type { ProjectConfig } from './projectConfig';

/**
 * Project-mode wiring, kept Express-free so tests exercise exactly what the
 * runner boots with. Two registries because validation and execution are
 * separate instances in the runner — the consumer's nodes must exist in both.
 */
/**
 * Boot-time guard: an explicit EMBERFLOW_PROJECT env var must fail loudly
 * when no config was found there, mirroring the environments-file stance.
 * Implicit cwd detection stays lenient (silent fallback to default mode).
 */
export function requireProjectWhenExplicit(
  project: ProjectConfig | null,
  explicitPath: string | undefined,
  resolvedDir: string,
): ProjectConfig | null {
  if (explicitPath !== undefined && project === null) {
    throw new Error(
      `EMBERFLOW_PROJECT points at ${resolvedDir} but no emberflow.config.(mjs|js|ts) was found there`,
    );
  }
  return project;
}

export function buildFlowStore(project: ProjectConfig | null): FlowStore {
  return project ? new FlowStore(project.flowsDir, { scenarioSidecars: true }) : new FlowStore();
}

/**
 * The `apis/` tree replaces the flat `flows/` layout. Runs the one-time
 * migration before constructing the store so a legacy project boots straight
 * into the new layout.
 */
export function buildApiStore(project: ProjectConfig | null): ApiStore {
  const flowsDir = project ? project.flowsDir : resolve(process.cwd(), 'workflows', 'flows');
  const apisDir = join(dirname(flowsDir), 'apis');
  migrateFlowsToApis(flowsDir, apisDir);
  return new ApiStore(apisDir);
}

export function buildRegistries(project: ProjectConfig | null): {
  validation: NodeRegistry;
  execution: NodeRegistry;
} {
  // Server-side registries capture registration provenance (file:line of each
  // register() call) so the studio can navigate to a node's real source.
  // Browser registries never enable this — see createDefaultRegistry.
  // Consumer projects get CORE nodes only (control flow, Response,
  // requireAuth) — the demo domain nodes (weather/anomaly/EV)
  // exist for the no-project sandbox and would otherwise tempt agents into
  // building real operations on demo infrastructure.
  const includeDemoNodes = !project;
  const validation = createDefaultRegistry(undefined, { captureSourceRefs: true, includeDemoNodes });
  const execution = createDefaultRegistry(undefined, { captureSourceRefs: true, includeDemoNodes });
  if (project?.registerNodes) {
    project.registerNodes(validation);
    project.registerNodes(execution);
  }
  return { validation, execution };
}
