import {
  mergeMocks,
  startRun,
  type NodeRegistry,
  type ScenarioDefinition,
  type WorkflowDefinition,
} from '../src/engine';
import { loadProjectConfig } from './projectConfig';
import { buildApiStore, buildRegistries, requireProjectWhenExplicit } from './projectMode';
import { loadEnvironments, resolveRunSafety, type EnvironmentsFile } from './environments';
import { evaluateExpectation } from './scenarioTest';
import { makeSubflowRunner } from './subflowRunner';
import { redactSecrets } from './redact';
import type { ApiStore } from './apiStore';

/** Thrown for CLI usage errors (unknown opId / unknown environment) — the CLI
 *  layer turns this into exit code 2, distinct from an assertion failure
 *  (exit 1) or an unexpected error (also exit 1, via runCli's generic catch). */
export class ScenarioTestUsageError extends Error {}

export type SkipReason = 'no expect' | 'empty expect';

export interface ScenarioResult {
  opId: string;
  scenario: string;
  status: 'passed' | 'failed' | 'skipped';
  /** Present only when status === 'failed' — evaluateExpectation's failure strings. */
  failures?: string[];
  /** Present only when status === 'skipped'. */
  reason?: SkipReason;
}

export interface TestReport {
  results: ScenarioResult[];
  passed: number;
  failed: number;
  skipped: number;
}

interface RunEnv {
  secrets: Record<string, string>;
  vars: Record<string, string>;
  environment: string;
  safeMode: boolean;
}

async function runScenario(
  op: WorkflowDefinition,
  scenario: ScenarioDefinition,
  apiStore: ApiStore,
  registry: NodeRegistry,
  env: RunEnv,
  mock: boolean,
): Promise<ScenarioResult> {
  if (!scenario.expect) {
    return { opId: op.id, scenario: scenario.name, status: 'skipped', reason: 'no expect' };
  }
  if (Object.keys(scenario.expect).length === 0) {
    return { opId: op.id, scenario: scenario.name, status: 'skipped', reason: 'empty expect' };
  }

  // INTENTIONAL (controller decision): NO environment auth auto-attach here,
  // unlike POST /runs (server/index.ts attachCredential). Tests are hermetic —
  // auto-attaching the environment's credential would silently satisfy the very
  // auth checks a deliberate 401-expectation scenario exists to exercise. If a
  // scenario needs auth, embed the headers directly in `scenario.input`.
  //
  // --mock: same merge as the live serving mock-run path (mergeMocks,
  // src/engine/scenarios.ts) — op-level `flow.mocks` overlaid by this
  // scenario's `mocks`, scenario wins per nodeId. Nothing real is ever
  // touched: the executor's mockRun short-circuit fails loudly on any
  // infrastructure node (traceKind db/http/llm) that has no mock.
  const handle = startRun({
    flow: op,
    registry,
    secrets: env.secrets,
    vars: env.vars,
    environment: env.environment,
    safeMode: env.safeMode,
    input: scenario.input,
    mockRun: mock,
    mocks: mock ? mergeMocks(op, scenario) : undefined,
    // Shared factory (server/subflowRunner.ts) — same depth cap/cycle guard as
    // the live runner, minus the SSE trace/log plumbing a headless run skips.
    subflowRunner: makeSubflowRunner(
      {
        loadFlow: (id) => apiStore.load(id),
        registry,
        secrets: env.secrets,
        vars: env.vars,
        environment: env.environment,
        safeMode: env.safeMode,
        mockRun: mock,
      },
      [op.id],
    ),
  });
  const run = await handle.runToEnd();
  const { ok, failures } = evaluateExpectation(run, op, scenario.expect);
  return {
    opId: op.id,
    scenario: scenario.name,
    status: ok ? 'passed' : 'failed',
    ...(ok ? {} : { failures }),
  };
}

/**
 * Runs every scenario with `expect` across the given ops (or a single op when
 * `opId` is given), entirely in-process: `startRun` is called directly per
 * scenario, mirroring the options shape `RunRegistry.create` passes
 * (server/runRegistry.ts) — but bypassing RunRegistry entirely, so these runs
 * never enter it (no SSE, no run history).
 *
 * This is the shared seam both the CLI (`runScenarioSuite`, which bootstraps
 * its own project/registries/apiStore from disk) and the studio route
 * (`POST /workflows/:id/test` in server/index.ts, which reuses the
 * already-booted server's apiStore/registry/environmentsFile — no re-read
 * from disk, no drift from in-memory writes) call into. NO second expectation
 * engine — both paths land here.
 *
 * Throws `ScenarioTestUsageError` for usage problems (unknown opId, unknown
 * environment) — the CLI layer maps that to exit code 2; the route maps it to
 * 400/404.
 */
export async function runScenarioSuiteFor(
  ctx: { apiStore: ApiStore; registry: NodeRegistry; environmentsFile: EnvironmentsFile },
  opts: { opId?: string; environmentName?: string; mock?: boolean },
): Promise<TestReport> {
  const { apiStore, registry, environmentsFile } = ctx;
  const { opId, environmentName, mock = false } = opts;

  const envName = environmentName ?? environmentsFile.defaultEnvironment;
  const envDef = environmentsFile.environments[envName];
  if (!envDef) {
    throw new ScenarioTestUsageError(`Unknown environment: '${envName}'`);
  }
  const safety = resolveRunSafety(envName, envDef, {});
  const runEnv: RunEnv = {
    secrets: envDef.secrets,
    vars: envDef.vars,
    environment: envName,
    safeMode: safety.ok ? safety.safeMode : false,
  };

  const allOps = apiStore.list();
  let targetOps = allOps;
  if (opId !== undefined) {
    const op = allOps.find((o) => o.id === opId);
    if (!op) throw new ScenarioTestUsageError(`Unknown operation: '${opId}'`);
    targetOps = [op];
  }

  const rawResults: ScenarioResult[] = [];
  for (const op of targetOps) {
    for (const scenario of op.scenarios ?? []) {
      rawResults.push(await runScenario(op, scenario, apiStore, registry, runEnv, mock));
    }
  }

  // evaluateExpectation diffs RAW run state, so a failure string can quote a
  // secret value the flow echoed into its response body. Redact the whole
  // reporter payload (value-based; raw/url-encoded/base64 forms) before it can
  // reach stdout/CI logs — same redactSecrets the SSE event path uses.
  const results = redactSecrets(rawResults, runEnv.secrets);

  return {
    results,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };
}

/**
 * CLI entry point: bootstraps a project from disk (loadProjectConfig/
 * buildRegistries/buildApiStore/loadEnvironments — the same bootstrap
 * `server/index.ts` uses) and delegates to `runScenarioSuiteFor`. NO runner
 * process, no HTTP.
 */
export async function runScenarioSuite(opts: {
  projectDir: string;
  opId?: string;
  environmentName?: string;
  mock?: boolean;
}): Promise<TestReport> {
  const { projectDir, opId, environmentName, mock } = opts;

  const project = requireProjectWhenExplicit(
    await loadProjectConfig(projectDir),
    process.env.EMBERFLOW_PROJECT,
    projectDir,
  );
  const environmentsFile = loadEnvironments(project ? project.root : projectDir);
  const { execution } = buildRegistries(project);
  const apiStore = buildApiStore(project);

  return runScenarioSuiteFor({ apiStore, registry: execution, environmentsFile }, { opId, environmentName, mock });
}

/** `✓ opId · scenario` / `✗ opId · scenario (failure; failure)` — undefined for
 *  skipped scenarios, which aren't printed as individual lines (only counted
 *  in the summary), keeping default output focused on assertable scenarios. */
export function formatScenarioLine(r: ScenarioResult): string | undefined {
  if (r.status === 'skipped') return undefined;
  if (r.status === 'passed') return `✓ ${r.opId} · ${r.scenario}`;
  return `✗ ${r.opId} · ${r.scenario} (${(r.failures ?? []).join('; ')})`;
}

/** `12 passed, 1 failed, 3 skipped (no expect)` — the parenthetical lists the
 *  distinct skip reasons present (omitted entirely when nothing was skipped). */
export function formatSummary(report: TestReport): string {
  const reasons = [...new Set(report.results.filter((r) => r.status === 'skipped').map((r) => r.reason))];
  const suffix = report.skipped > 0 ? ` (${reasons.join(', ')})` : '';
  return `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped${suffix}`;
}
