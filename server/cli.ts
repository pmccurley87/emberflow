import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findScenario,
  isArtifact,
  publishFlow,
  scenarioNames,
  type PublishedArtifact,
  type WorkflowDefinition,
} from '../src/engine';
import { createDefaultRegistry } from '../src/nodes';
import { parsePathParams } from '../src/lib/pathParams';
import { diagnoseOperation, type OperationDiagnostic } from '../src/engine/diagnostics';
import { seedParamDefaults } from './normalizeFlow';
import { loadProjectConfig } from './projectConfig';
import { loadEnvironments } from './environments';
import { buildApiStore, buildRegistries, requireProjectWhenExplicit } from './projectMode';
import * as client from './client';
import { RunnerUnreachableError } from './client';
import {
  formatScenarioLine,
  formatSummary,
  runScenarioSuite,
  ScenarioTestUsageError,
} from './testRunner';

const USAGE = `Usage: emberflow-cli <command> [args]

Commands:
  list-nodes                  List all registered node types
  node-schema <type>          Print the full NodeDefinition for a node type
  list-workflows               List workflows known to the runner
  get-workflow <id>            Print a workflow's full flow JSON
  get-node <opId> <nodeId>     Print one node's wiring: its instance
                                (config, inputMap, retry/optional), its inbound
                                + outbound edges, and — when the type is
                                registered — a definition summary (input/output
                                field names, traceKind, effects). Runner-
                                preferred; falls back to an in-process offline
                                load when the runner is unreachable. Unknown op
                                or node exits 1.
  list-environments             List configured environments (names + key lists, no values;
                                includes per-env auth: {configured, authenticated} when set).
                                Prefers the runner; if it's unreachable, falls back to an
                                in-process offline load of the same files (NO runner
                                required) — prints "source": "offline" and, since login
                                state lives runner-side, auth.authenticated: "unknown".
  login-environment <name>      Perform the environment's configured login and store the
                                captured credential runner-side; prints {environment,
                                authenticated, secretRef} (never the secret value)
  set-environment-auth <name> --json '<EnvAuth JSON>'
                                Set (or, with --json 'null', clear) an environment's auth
                                config; prints {environment, configured: true}. Carries no
                                secret values — only refs/names.
  serving <real|mock>           Switch whether mounted HTTP endpoints execute for real or
                                answer from scenario expectations (mock); prints
                                {serving: mode}.
  validate <file|id>           Validate a flow (file path or workflow id)
  publish <id|file> [--out <path>]  Publish a flow to a sealed artifact JSON file
  run <file|id> [--input '<json>' | --input-file <path> | --scenario <name>]
      [--env <name>] [--safe | --unsafe] [--confirm <name>] [--full]
                                Run a flow to completion. Prints a CONCISE result by
                                default (per-node status + truncated I/O); --full for raw.
  save <file>                    Save a flow file to the runner
  create <id> --method <M> --path </route> [--name "<display>"]
                                Create a new operation shell (Input → Response + http
                                trigger) at the given apis id. Then edit it to add nodes.
  delete <id>                    Delete an operation/workflow from the runner
  rename <old-id> <new-id> [--name "<display>"]
                                Rename an operation (updates id + display name + http route)
  samples <nodeId>              Print recorded execution samples for a node
  test [opId] [--environment <name>] [--json] [--mock]
                                Run every scenario with an \`expect\` assertion
                                in-process (NO runner required) and report
                                pass/fail/skip. [opId] limits to one operation.
                                Scenarios without \`expect\` (or an empty \`{}\`)
                                are skipped. --json prints a machine-readable
                                array instead of the default text summary.
                                --mock runs each scenario as a Mock run
                                (mockRun: true): infrastructure nodes
                                (traceKind db/http/llm) return their sidecar
                                mock instead of touching real infra — an
                                op-level \`flow.mocks\` overlaid by the
                                scenario's own \`mocks\` (scenario wins per
                                nodeId) — and fail loudly if unmocked. Off by
                                default (real runs). The hermetic way to prove
                                branch coverage for infra-heavy ops without
                                live Postgres/Weld/OpenRouter.
                                Exit 0 all pass, 1 any fail, 2 usage (unknown
                                opId/environment).
  doctor [opId] [--fix]         Diagnose operation(s) in-process (NO runner
                                required): missing path-param defaults, params
                                no scenario exercises, scenarios with no
                                expect. [opId] limits to one operation.
                                --fix seeds '' param defaults in-place (never
                                overwrites an existing value) and re-diagnoses
                                so the report reflects post-fix state.
                                Exit 0 no error-severity diagnostics, 1 at
                                least one error-severity diagnostic, 2 usage
                                (unknown opId / unknown flag).

Env:
  EMBERFLOW_RUNNER_URL   Runner base URL (default http://127.0.0.1:8092)

Notes:
  run --step is not supported by the CLI; step mode is interactive-only.
  run --input, --input-file, and --scenario are mutually exclusive.
  run --scenario <name> looks up a named test input embedded in the flow
  (scenario name or id); artifacts carry no scenarios.
  run accepts either a flow file/id or a published artifact file ($artifact) —
  artifacts always execute under production semantics.
  run --env <name> selects an environment from emberflow.environments.json
  (omitted → the runner's default environment).
  run --safe / --unsafe overrides safe mode (omitted → the environment's
  default: protected environments default to safe).
  run --unsafe on a protected environment additionally requires
  --confirm <name> matching --env exactly, or the runner rejects the run.
`;

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Value after a `--flag` in argv, or undefined. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

/** kebab/snake slug → Title Case display name (e.g. "latest-results" → "Latest Results"). */
function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Shrink a large value to a keys+preview stub so a `run` summary stays readable.
 *  Small values pass through untouched; anything over `cap` chars of JSON is
 *  replaced by its shape (keys/length) + a short preview. */
function summarizeValue(v: unknown, cap = 4000): unknown {
  if (v === undefined || v === null) return v;
  const s = JSON.stringify(v);
  if (s.length <= cap) return v;
  const stub: Record<string, unknown> = { __truncated: true, chars: s.length };
  if (Array.isArray(v)) {
    stub.arrayLength = v.length;
    stub.first = summarizeValue(v[0], 300);
  } else if (typeof v === 'object') {
    stub.keys = Object.keys(v as Record<string, unknown>);
  }
  stub.preview = s.slice(0, 300);
  return stub;
}

/** A concise per-node view of a run: status + error + truncated input/output —
 *  the default `run` output, so a flow whose fetch nodes dump 70KB of raw API
 *  JSON doesn't blow up the agent's context on every run-inspect cycle. */
function summarizeNodeStates(states: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(states)) {
    const st = (raw ?? {}) as { status?: unknown; error?: unknown; output?: unknown; input?: unknown };
    out[id] = {
      status: st.status,
      ...(st.error ? { error: st.error } : {}),
      ...(st.output !== undefined ? { output: summarizeValue(st.output) } : {}),
      ...(st.input !== undefined ? { input: summarizeValue(st.input) } : {}),
    };
  }
  return out;
}

/** Field names of a node schema, tolerant of the loose `unknown` shape the
 *  runner's /nodes payload carries (vs. the typed offline registry). */
function schemaFieldNames(schema: unknown): string[] {
  const fields = (schema as { fields?: Array<{ name?: unknown }> } | undefined)?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.map((f) => f?.name).filter((n): n is string => typeof n === 'string');
}

/** Compact `definition` summary for `get-node`: input/output field names, trace
 *  kind, effects (absent = 'read' per NodeDefinition). Accepts either a runner
 *  NodeMeta or an offline NodeDefinition — both carry these fields. */
function summarizeNodeDefinition(def: {
  type: string;
  label?: string;
  traceKind?: string;
  effects?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}): Record<string, unknown> {
  return {
    type: def.type,
    label: def.label,
    traceKind: def.traceKind,
    effects: def.effects ?? 'read',
    inputFields: schemaFieldNames(def.inputSchema),
    outputFields: schemaFieldNames(def.outputSchema),
  };
}

/** Thrown by `fail` to unwind to `runCli`, which turns it into a return code.
 *  Lets the parse helpers keep their `never`-returning `fail(...)` call sites
 *  while runCli stays in-process (no process.exit) so it's usable as a library. */
class CliExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`CliExit(${code})`);
    this.code = code;
  }
}

/** Prints {error} JSON to stderr and unwinds with the given code. Never returns. */
function fail(message: string, code: number): never {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  throw new CliExit(code);
}

/** File path if it exists on disk, else fetched by id from the runner. */
async function resolveFlow(arg: string): Promise<WorkflowDefinition> {
  if (existsSync(arg)) {
    return JSON.parse(readFileSync(arg, 'utf8')) as WorkflowDefinition;
  }
  const flow = await client.getWorkflow(arg);
  if (!flow) {
    throw new Error(`No flow file at "${arg}" and no workflow with id "${arg}" on the runner`);
  }
  return flow;
}

/** Like resolveFlow, but recognizes a file whose JSON is a published artifact. */
async function resolveFlowOrArtifact(arg: string): Promise<WorkflowDefinition | PublishedArtifact> {
  if (existsSync(arg)) {
    const parsed = JSON.parse(readFileSync(arg, 'utf8')) as unknown;
    return isArtifact(parsed) ? parsed : (parsed as WorkflowDefinition);
  }
  const flow = await client.getWorkflow(arg);
  if (!flow) {
    throw new Error(`No flow file at "${arg}" and no workflow with id "${arg}" on the runner`);
  }
  return flow;
}

/** Parses --env/--safe/--unsafe/--confirm flags. --safe and --unsafe are mutually exclusive. */
function parseEnvFlags(args: string[]): { environment?: string; safeMode?: boolean; confirm?: string } {
  const envIdx = args.indexOf('--env');
  let environment: string | undefined;
  if (envIdx !== -1) {
    environment = args[envIdx + 1];
    if (!environment) fail('Usage: run <file|id> --env <name>', 2);
  }

  const hasSafe = args.includes('--safe');
  const hasUnsafe = args.includes('--unsafe');
  if (hasSafe && hasUnsafe) {
    fail('--safe and --unsafe are mutually exclusive', 2);
  }
  const safeMode = hasSafe ? true : hasUnsafe ? false : undefined;

  const confirmIdx = args.indexOf('--confirm');
  let confirm: string | undefined;
  if (confirmIdx !== -1) {
    confirm = args[confirmIdx + 1];
    if (!confirm) fail('Usage: run <file|id> --confirm <name>', 2);
  }

  return { environment, safeMode, confirm };
}

/** Parses --input/--input-file flags. Mutually exclusive; parse errors exit 2. */
function parseInputFlag(args: string[]): Record<string, unknown> | undefined {
  const inputIdx = args.indexOf('--input');
  const inputFileIdx = args.indexOf('--input-file');
  if (inputIdx !== -1 && inputFileIdx !== -1) {
    fail('--input and --input-file are mutually exclusive', 2);
  }
  if (inputIdx !== -1) {
    const raw = args[inputIdx + 1];
    if (!raw) fail("Usage: run <file|id> --input '<json>'", 2);
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      fail(`Invalid --input JSON: ${err instanceof Error ? err.message : String(err)}`, 2);
    }
  }
  if (inputFileIdx !== -1) {
    const path = args[inputFileIdx + 1];
    if (!path) fail('Usage: run <file|id> --input-file <path>', 2);
    if (!existsSync(path)) fail(`No such --input-file: ${path}`, 2);
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      fail(`Invalid JSON in --input-file ${path}: ${err instanceof Error ? err.message : String(err)}`, 2);
    }
  }
  return undefined;
}

/**
 * Runs a single CLI command in-process and resolves to a process exit code
 * (0 success, non-zero on error) — never calls process.exit, so it's safe to
 * drive from the register-API bin inside a sandbox (no `tsx` child spawn).
 * `argv` is `[command, ...rest]`.
 */
export async function runCli(argv: string[]): Promise<number> {
  const [command, ...args] = argv;

  try {
    return await dispatch(command, args);
  } catch (err) {
    if (err instanceof CliExit) return err.code;
    if (err instanceof RunnerUnreachableError) {
      process.stderr.write(`${JSON.stringify({ error: err.message })}\n`);
      return 2;
    }
    process.stderr.write(
      `${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`,
    );
    return 1;
  }
}

async function dispatch(command: string | undefined, args: string[]): Promise<number> {
  switch (command) {
    case 'list-nodes': {
      // The RUNNER's live registry — built-ins + the project's registerNodes —
      // NOT a local createDefaultRegistry(), which is blind to project nodes.
      const nodes = await client.listNodes();
      printJson(
        nodes.map((d) => ({
          type: d.type,
          label: d.label,
          category: d.category,
          description: d.description,
        })),
      );
      return 0;
    }

    case 'node-schema': {
      const type = args[0];
      if (!type) fail('Usage: node-schema <type>', 2);
      const nodes = await client.listNodes();
      const node = nodes.find((n) => n.type === type);
      if (!node) {
        fail(`Unknown node type: ${type}. (Run list-nodes to see registered types.)`, 2);
      }
      printJson(node);
      return 0;
    }

    case 'list-workflows': {
      const flows = await client.listWorkflows();
      printJson(flows.map((f) => ({ id: f.id, name: f.name, folder: f.folder, nodes: f.nodes.length })));
      return 0;
    }

    case 'get-workflow': {
      const id = args[0];
      if (!id) fail('Usage: get-workflow <id>', 2);
      const flow = await client.getWorkflow(id);
      if (!flow) fail(`Unknown workflow: ${id}`, 1);
      printJson(flow);
      return 0;
    }

    case 'get-node': {
      const opId = args[0];
      const nodeId = args[1];
      if (!opId || !nodeId) fail('Usage: get-node <opId> <nodeId>', 2);

      // Resolve the flow + a node-type definition lookup. Runner-preferred
      // (mirrors get-workflow / node-schema); falls back to an in-process
      // offline load of the project files when the runner is unreachable, so
      // node inspection works with no server up.
      let flow: WorkflowDefinition | undefined;
      let lookupDef: (type: string) => Record<string, unknown> | undefined;
      try {
        flow = await client.getWorkflow(opId);
        const nodes = await client.listNodes();
        lookupDef = (type) => {
          const def = nodes.find((n) => n.type === type);
          return def ? summarizeNodeDefinition(def) : undefined;
        };
      } catch (err) {
        if (!(err instanceof RunnerUnreachableError)) throw err;
        const projectDir = process.env.EMBERFLOW_PROJECT
          ? resolve(process.cwd(), process.env.EMBERFLOW_PROJECT)
          : process.cwd();
        const project = requireProjectWhenExplicit(
          await loadProjectConfig(projectDir),
          process.env.EMBERFLOW_PROJECT,
          projectDir,
        );
        const apiStore = buildApiStore(project);
        flow = apiStore.load(opId);
        const { validation } = buildRegistries(project);
        lookupDef = (type) =>
          validation.has(type) ? summarizeNodeDefinition(validation.get(type).definition) : undefined;
      }

      if (!flow) fail(`Unknown operation: ${opId}`, 1);
      const node = flow.nodes.find((n) => n.id === nodeId);
      if (!node) fail(`Unknown node "${nodeId}" in operation "${opId}"`, 1);

      const edges = flow.edges ?? [];
      const inbound = edges
        .filter((e) => e.target === nodeId)
        .map((e) => ({ source: e.source, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle }));
      const outbound = edges
        .filter((e) => e.source === nodeId)
        .map((e) => ({ target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle }));

      printJson({
        operation: opId,
        node: {
          id: node.id,
          type: node.type,
          label: node.label,
          config: node.config,
          inputMap: node.inputMap,
          ...(node.retry ? { retry: node.retry } : {}),
          ...(node.optional !== undefined ? { optional: node.optional } : {}),
        },
        inbound,
        outbound,
        definition: lookupDef(node.type) ?? null,
      });
      return 0;
    }

    case 'list-environments': {
      try {
        printJson({ source: 'runner', ...(await client.listEnvironments()) });
      } catch (err) {
        if (!(err instanceof RunnerUnreachableError)) throw err;
        // Runner unreachable — fall back to an in-process offline load of the
        // same emberflow.environments.json/emberflow.secrets.json the runner
        // would read, so intake (which the skills tell agents to run before a
        // runner is up) still works. Auth *status* (logged-in state) lives
        // runner-side (it's set by a live login run) — offline we can only
        // report whether auth is *configured*, not whether it's authenticated.
        const projectDir = process.env.EMBERFLOW_PROJECT
          ? resolve(process.cwd(), process.env.EMBERFLOW_PROJECT)
          : process.cwd();
        const envFile = loadEnvironments(projectDir);
        printJson({
          source: 'offline',
          defaultEnvironment: envFile.defaultEnvironment,
          environments: Object.entries(envFile.environments).map(([name, env]) => ({
            name,
            protected: !!env.protected,
            varKeys: Object.keys(env.vars),
            secretKeys: Object.keys(env.secrets),
            ...(env.auth ? { auth: { configured: true, authenticated: 'unknown' as const } } : {}),
          })),
        });
      }
      return 0;
    }

    case 'login-environment': {
      const name = args[0];
      if (!name) fail('Usage: login-environment <name>', 2);
      // Errors (unknown env 404, no auth.login 400, upstream login failure 502)
      // bubble to runCli's catch-all, which prints {error} and returns 1.
      const { authenticated, secretRef } = await client.loginEnvironment(name);
      printJson({ environment: name, authenticated, secretRef });
      return 0;
    }

    case 'set-environment-auth': {
      const name = args[0];
      if (!name) fail("Usage: set-environment-auth <name> --json '<EnvAuth JSON>'", 2);
      const raw = flagValue(args, '--json');
      if (!raw) fail("Usage: set-environment-auth <name> --json '<EnvAuth JSON>'", 2);
      let auth: unknown;
      try {
        auth = JSON.parse(raw);
      } catch (err) {
        fail(`Invalid --json: ${err instanceof Error ? err.message : String(err)}`, 2);
      }
      // Errors (unknown env 404, invalid auth shape 400) bubble to runCli's
      // catch-all, which prints {error} and returns 1.
      await client.setEnvironmentAuth(name, auth);
      printJson({ environment: name, configured: true });
      return 0;
    }

    case 'serving': {
      const mode = args[0];
      if (mode !== 'real' && mode !== 'mock') {
        fail('Usage: serving <real|mock>', 2);
      }
      // Errors (e.g. runner rejects the mode) bubble to runCli's catch-all,
      // which prints {error} and returns 1.
      await client.setServingMode(mode);
      printJson({ serving: mode });
      return 0;
    }

    case 'validate': {
      const arg = args[0];
      if (!arg) fail('Usage: validate <file|id>', 2);
      const flow = await resolveFlow(arg);
      // Validate against the runner's live registry (built-ins + project nodes),
      // not a project-blind local createDefaultRegistry().
      const { valid, issues } = await client.validateOperation(flow);
      printJson({ valid, issues });
      return valid ? 0 : 1;
    }

    case 'run': {
      if (args.includes('--step')) {
        fail('run --step is not supported by the CLI; step mode is interactive-only', 2);
      }
      const arg = args[0];
      if (!arg) {
        fail("Usage: run <file|id> [--input '<json>' | --input-file <path> | --scenario <name>]", 2);
      }
      const scenarioIdx = args.indexOf('--scenario');
      if (scenarioIdx !== -1 && (args.includes('--input') || args.includes('--input-file'))) {
        fail('--scenario and --input/--input-file are mutually exclusive', 2);
      }
      let scenarioName: string | undefined;
      if (scenarioIdx !== -1) {
        scenarioName = args[scenarioIdx + 1];
        if (!scenarioName) fail('Usage: run <file|id> --scenario <name>', 2);
      }
      let input = parseInputFlag(args);
      const { environment, safeMode, confirm } = parseEnvFlags(args);
      const resolved = await resolveFlowOrArtifact(arg);
      if (scenarioName !== undefined) {
        if (isArtifact(resolved)) {
          fail('Artifacts carry no scenarios; pass --input instead', 2);
        }
        const scenario = findScenario(resolved, scenarioName);
        if (!scenario) {
          const names = scenarioNames(resolved);
          fail(
            `Unknown scenario: "${scenarioName}". Available: ${names.length ? names.join(', ') : 'none'}`,
            1,
          );
        }
        input = scenario.input;
      }
      const runId = isArtifact(resolved)
        ? await client.startRun({ artifact: resolved, input, environment, safeMode, confirm })
        : await client.startRun({ flow: resolved, input, environment, safeMode, confirm });
      const { run: finished, logs } = await client.waitForRun(runId);
      const full = args.includes('--full');
      printJson({
        status: finished.status,
        environment: finished.environment,
        safeMode: finished.safeMode,
        nodeStates: full ? finished.nodeStates : summarizeNodeStates(finished.nodeStates),
        logs,
        ...(full ? {} : { note: 'node inputs/outputs over 4000 chars are truncated (keys + preview shown); pass --full for the raw nodeStates.' }),
      });
      return finished.status === 'succeeded' ? 0 : 1;
    }

    case 'publish': {
      const arg = args[0];
      if (!arg) fail('Usage: publish <id|file> [--out <path>]', 2);
      const outIdx = args.indexOf('--out');
      const outPathArg = outIdx !== -1 ? args[outIdx + 1] : undefined;
      if (outIdx !== -1 && !outPathArg) fail('Usage: publish <id|file> [--out <path>]', 2);

      const flow = await resolveFlow(arg);
      const registry = createDefaultRegistry();
      const artifact = await publishFlow(flow, registry);

      const outPath = outPathArg ?? `artifacts/${flow.id}.json`;
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
      printJson({ ok: true, path: outPath, nodeTypes: Object.keys(artifact.nodeHashes).length });
      return 0;
    }

    case 'save': {
      const file = args[0];
      if (!file) fail('Usage: save <file>', 2);
      if (!existsSync(file)) fail(`No such file: ${file}`, 2);
      const flow = JSON.parse(readFileSync(file, 'utf8')) as WorkflowDefinition;
      await client.saveWorkflow(flow);
      printJson({ ok: true, id: flow.id });
      return 0;
    }

    case 'delete': {
      const id = args[0];
      if (!id) fail('Usage: delete <id>', 2);
      const result = await client.deleteOperation(id);
      printJson(result);
      return result.ok ? 0 : 1;
    }

    case 'plan': {
      // Declares the surface a build run intends to create, BEFORE creating
      // anything — the studio shows each op as a planned row that becomes real
      // as the corresponding `create` lands.
      const location = args.filter((a) => !a.startsWith('--'))[0];
      const opsJson = flagValue(args, '--ops');
      if (!location || !opsJson) {
        fail('Usage: plan <location> --ops \'[{"id":"<slug>","name":"<display>","method":"POST","path":"/route"}, …]\'', 2);
      }
      let ops: unknown;
      try {
        ops = JSON.parse(opsJson);
      } catch {
        fail('--ops must be a JSON array', 2);
      }
      const result = await client.declarePlan(location, ops as unknown[]);
      printJson(result);
      return result.ok ? 0 : 1;
    }

    case 'create': {
      const id = args.filter((a) => !a.startsWith('--'))[0];
      if (!id) {
        fail('Usage: create <id> --method <GET|POST|PATCH|PUT|DELETE> --path </route> [--name "<display>"]', 2);
      }
      const method = flagValue(args, '--method')?.toUpperCase();
      const path = flagValue(args, '--path');
      const name = flagValue(args, '--name') ?? titleCaseSlug(id.split('/').filter(Boolean).pop() ?? id);
      const now = new Date().toISOString();
      // Minimal valid shell: Input → terminus. HTTP endpoints get a Response
      // node + http trigger (method decided up front); non-HTTP ops get a Result.
      // A path with :params (e.g. /channels/:id) needs a matching Input default
      // so a plain "Run" (no scenario) doesn't crash the first node reading
      // ctx.input.params.<name> — seed empty-string placeholders up front.
      const pathParams = path ? parsePathParams(path) : [];
      const inputConfig =
        pathParams.length > 0
          ? { defaults: { params: Object.fromEntries(pathParams.map((p) => [p, ''])) } }
          : {};
      const nodes: unknown[] = [{ id: 'input', type: 'Input', label: 'Input', position: { x: 0, y: 0 }, config: inputConfig }];
      const edges: unknown[] = [];
      const terminus = method ? 'response' : 'result';
      nodes.push({ id: terminus, type: method ? 'Response' : 'Result', label: method ? 'Response' : 'Result', position: { x: 320, y: 0 }, config: {} });
      edges.push({ id: 'input-' + terminus, source: 'input', target: terminus });
      const flow = {
        id,
        name,
        version: 1,
        nodes,
        edges,
        createdAt: now,
        updatedAt: now,
        ...(method && path ? { http: { method, path } } : {}),
      };
      const result = await client.createOperation(flow as never, id);
      printJson(result.ok ? { ok: true, id, name, ...(method && path ? { http: { method, path } } : {}) } : { error: result.error });
      return result.ok ? 0 : 1;
    }

    case 'rename': {
      const positional = args.filter((a) => !a.startsWith('--'));
      const [oldId, newId] = positional;
      if (!oldId || !newId) fail('Usage: rename <old-id> <new-id> [--name "<display>"]', 2);
      const nameIdx = args.indexOf('--name');
      const customName = nameIdx !== -1 ? args[nameIdx + 1] : undefined;
      const flow = (await client.getWorkflow(oldId)) as
        | { id: string; name?: string; http?: { path?: string } }
        | null;
      if (!flow) fail(`Unknown operation: ${oldId}`, 1);
      // The op id IS its apis path. Rename it AND bring the human-facing bits
      // along: the display `name` (so the sidebar/title stops showing a vague
      // auto-generated label) and the http path when it mirrored the old id.
      const leaf = newId.split('/').filter(Boolean).pop() ?? newId;
      const displayName = customName ?? titleCaseSlug(leaf);
      const next: typeof flow = { ...flow, id: newId, name: displayName };
      if (next.http && next.http.path === `/${oldId}`) {
        next.http = { ...next.http, path: `/${newId}` };
      }
      const created = await client.createOperation(next as never, newId);
      if (!created.ok) {
        printJson({ error: `rename failed at create: ${created.error}` });
        return 1;
      }
      const removed = await client.deleteOperation(oldId);
      printJson({ ok: true, from: oldId, to: newId, name: displayName, httpPath: next.http?.path, oldRemoved: removed.ok });
      return 0;
    }

    case 'samples': {
      const nodeId = args[0];
      if (!nodeId) fail('Usage: samples <nodeId>', 2);
      printJson(await client.samples(nodeId));
      return 0;
    }

    case 'test': {
      let opId: string | undefined;
      let environmentName: string | undefined;
      let json = false;
      let mock = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--environment') {
          environmentName = args[++i];
        } else if (a === '--json') {
          json = true;
        } else if (a === '--mock') {
          mock = true;
        } else if (opId === undefined) {
          opId = a;
        }
      }

      const projectDir = process.env.EMBERFLOW_PROJECT
        ? resolve(process.cwd(), process.env.EMBERFLOW_PROJECT)
        : process.cwd();

      let report;
      try {
        report = await runScenarioSuite({ projectDir, opId, environmentName, mock });
      } catch (err) {
        if (err instanceof ScenarioTestUsageError) fail(err.message, 2);
        throw err;
      }

      if (json) {
        printJson(report.results);
      } else {
        for (const r of report.results) {
          const line = formatScenarioLine(r);
          if (line) process.stdout.write(`${line}\n`);
        }
        process.stdout.write(`${formatSummary(report)}\n`);
      }
      // CI foot-gun guard: a suite that asserted NOTHING still exits 0, but
      // that green is vacuous — say so on stderr (stdout stays parseable).
      if (report.passed + report.failed === 0) {
        process.stderr.write(`warning: no scenarios asserted (${report.skipped} skipped)\n`);
      }
      return report.failed > 0 ? 1 : 0;
    }

    case 'doctor': {
      let opId: string | undefined;
      let fix = false;
      for (const a of args) {
        if (a === '--fix') {
          fix = true;
        } else if (a.startsWith('--')) {
          fail(`Unknown flag: ${a}. Usage: doctor [opId] [--fix]`, 2);
        } else if (opId === undefined) {
          opId = a;
        } else {
          fail('Usage: doctor [opId] [--fix]', 2);
        }
      }

      const projectDir = process.env.EMBERFLOW_PROJECT
        ? resolve(process.cwd(), process.env.EMBERFLOW_PROJECT)
        : process.cwd();

      let project;
      try {
        project = requireProjectWhenExplicit(
          await loadProjectConfig(projectDir),
          process.env.EMBERFLOW_PROJECT,
          projectDir,
        );
      } catch (err) {
        // Unreadable project (EMBERFLOW_PROJECT points at a dir with no
        // emberflow.config.*) is a usage-shaped failure for `doctor`, not an
        // internal error — exit 2 per the documented contract, not the
        // generic-catch 1 in runCli.
        fail(err instanceof Error ? err.message : String(err), 2);
      }
      const apiStore = buildApiStore(project);
      const { validation: doctorRegistry } = buildRegistries(project);

      const allOps = apiStore.list();
      let targetOps = allOps;
      if (opId !== undefined) {
        const op = allOps.find((o) => o.id === opId);
        if (!op) fail(`Unknown operation: '${opId}'`, 2);
        targetOps = [op];
      }

      let errors = 0;
      let warnings = 0;
      let info = 0;
      const lines: string[] = [];

      for (const op of targetOps) {
        let flow = op;
        lines.push(op.id);

        if (fix) {
          const relPath = apiStore.pathOf(op.id);
          const { flow: seededFlow, seeded } = seedParamDefaults(op);
          if (seeded.length > 0 && relPath) {
            apiStore.save(seededFlow, relPath);
            flow = apiStore.load(op.id) ?? seededFlow;
            lines.push(`fixed ${op.id}: seeded params — ${seeded.join(', ')}`);
          } else {
            flow = seededFlow;
          }
        }

        const infraNodes: Array<{ id: string; traceKind: string }> = [];
        const outputFieldsByNode: Record<string, string[]> = {};
        const mutationSourcesByNode: Record<string, string> = {};
        for (const n of flow.nodes) {
          if (!doctorRegistry.has(n.type)) continue;
          const { definition, implementation } = doctorRegistry.get(n.type);
          const { traceKind } = definition;
          if (traceKind === 'db' || traceKind === 'http' || traceKind === 'llm') {
            infraNodes.push({ id: n.id, traceKind });
          }
          // Declared output fields for inputmap-schema-mismatch — only when the
          // node's outputSchema actually declares fields (empty/absent → skip, so
          // dynamic-output nodes like Input/Subflow never false-positive).
          const fields = definition.outputSchema?.fields;
          if (fields && fields.length > 0) {
            outputFieldsByNode[n.id] = fields.map((f) => f.name);
          }
          // Implementation source for simulated-commit — only mutation nodes,
          // and only when the implementation is a function (String() is always
          // safe, but a native/bound stub's source never carries the marker).
          if (definition.effects === 'mutation' && typeof implementation === 'function') {
            mutationSourcesByNode[n.id] = String(implementation);
          }
        }
        const diagnostics: OperationDiagnostic[] = diagnoseOperation(flow, flow.scenarios, {
          infraNodes,
          outputFieldsByNode,
          mutationSourcesByNode,
          languageDrift: project?.languageDrift,
        });
        for (const d of diagnostics) {
          lines.push(`  ${d.severity} ${d.code}: ${d.message}`);
          if (d.severity === 'error') errors++;
          else if (d.severity === 'warning') warnings++;
          else info++;
        }
      }

      lines.push(`${errors} errors, ${warnings} warnings, ${info} info across ${targetOps.length} operations`);
      process.stdout.write(`${lines.join('\n')}\n`);
      return errors > 0 ? 1 : 0;
    }

    default: {
      process.stderr.write(USAGE);
      return 2;
    }
  }
}

/** True when this module is the process entry point (run directly, not imported). */
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
