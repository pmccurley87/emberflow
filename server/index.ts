import { existsSync, watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import {
  findScenario,
  isArtifact,
  mergeMocks,
  validateFlow,
  verifyArtifact,
  type LogLine,
  type ScenarioDefinition,
  type WorkflowDefinition,
} from '../src/engine';
import { createLoginFlow } from '../src/flows/login-flow';
import { createWeatherFlow } from '../src/flows/weather-flow';
import { createAnomalyFlows } from '../src/flows/anomaly-flows';
import { createPradarFlows } from '../src/flows/pradar-flows';
import { RunRegistry, type RunEvent } from './runRegistry';
import {
  loadEnvironments,
  resolveRunSafety,
  setEnvironmentAuth,
  setEnvironmentSecret,
  deleteEnvironmentSecret,
  type EnvAuth,
} from './environments';
import { performLogin } from './login';
import { loadInfrastructure } from './infrastructure';
import { configPathFor, loadProjectConfig } from './projectConfig';
import { buildApiStore, buildRegistries, requireProjectWhenExplicit } from './projectMode';
import { nodesPayload } from './nodesPayload';
import { openBrowser } from './openBrowser';
import { AgentRunManager, AgentStartError } from './agents/runManager';
import { isMountablePath } from './pathGuard';
import { detectAgents } from './agents/detect';
import type { AgentEvent } from './agents/types';
import type { AgentIntent } from './agents/prompt';
import { ExpressAdapter } from './runtime/expressAdapter';
import { makeOperationHandler } from './httpOperations';
import { mockResponseFor } from './mockHandler';
import { createDefaultVerifierRegistry } from './auth/verifiers';
import { isPathWithin } from './pathSafety';
import { attachCredential } from './authAttach';
import { redactSecrets } from './redact';
import { runScenarioSuiteFor, ScenarioTestUsageError } from './testRunner';
import { diagnoseOperation } from '../src/engine/diagnostics';
import { seedParamDefaults } from './normalizeFlow';

const PORT = Number(process.env.EMBERFLOW_RUNNER_PORT ?? 8092);
const HOST = '127.0.0.1';
const HEARTBEAT_MS = 15_000;

// Runtime serving mode: mock vs real. EMBERFLOW_MOCK only seeds the initial
// value at boot — POST /serving flips it live thereafter (see below). Every
// mounted operation route dispatches on this flag per-request rather than
// being built (or not) once at boot for a fixed mode.
// Provisional: EMBERFLOW_MOCK=1 forces mock regardless of environments.
// Reseeded below once environmentsFile is loaded, to also default to mock
// when no environments are configured.
let servingMode: 'real' | 'mock' = process.env.EMBERFLOW_MOCK === '1' ? 'mock' : 'real';

/**
 * Wire up an SSE response safely: guards every write against a client that has
 * already disconnected (writing to an ended/destroyed response throws
 * ERR_STREAM_WRITE_AFTER_END, which — unhandled — crashes the whole runner),
 * swallows stream errors, and drives a heartbeat. Returns { write, close } plus
 * an `onClose` you pass your unsubscribe to. Both event streams use this.
 */
function openSse(req: Request, res: Response, onClientGone: () => void): {
  write: (s: string) => void;
  end: () => void;
} {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  let closed = false;
  const write = (s: string): void => {
    if (closed || res.writableEnded || res.destroyed) return;
    try {
      res.write(s);
    } catch {
      // client vanished mid-write — treat as closed
      closed = true;
    }
  };
  const end = (): void => {
    if (closed) return;
    closed = true;
    try {
      res.end();
    } catch {
      /* already gone */
    }
  };
  const heartbeat = setInterval(() => write(': heartbeat\n\n'), HEARTBEAT_MS);
  const cleanup = (): void => {
    closed = true;
    clearInterval(heartbeat);
    onClientGone();
  };
  // A stream 'error' (EPIPE/write-after-end) must be handled or Node throws it
  // as an uncaught exception and the process dies.
  res.on('error', cleanup);
  req.on('close', cleanup);
  return { write, end };
}

const projectDir = process.env.EMBERFLOW_PROJECT
  ? resolve(process.cwd(), process.env.EMBERFLOW_PROJECT)
  : process.cwd();
const project = requireProjectWhenExplicit(
  await loadProjectConfig(projectDir),
  process.env.EMBERFLOW_PROJECT,
  projectDir,
);
if (project) console.log(`[runner] project mode: ${project.root} (flows: ${project.flowsDir})`);

// Malformed environments file fails the boot loudly, by design.
const environmentsFile = loadEnvironments(project ? project.root : process.cwd());

// Default-mock: a project that never configured environments (loadEnvironments
// synthesized its bare "local" fallback) has nothing real to serve against, so
// boot into mock unless EMBERFLOW_MOCK already forced a mode above. A project
// WITH an environments file (or legacy secrets) keeps booting real exactly as
// before — even when its environments carry no vars/secrets yet. Reads the
// SAME environmentsFile loaded above — no second file read that could disagree.
if (process.env.EMBERFLOW_MOCK !== '1' && !environmentsFile.configured) {
  servingMode = 'mock';
}

// Validation-only registry; RunRegistry owns the execution registry.
const { validation: validationRegistry, execution: executionRegistry } = buildRegistries(project);

// Workflow files: seed with the example flows the first time we boot (skipped in project mode).
// Runs the flows/ -> apis/default/ migration on boot when needed.
const apiStore = buildApiStore(project);
// Subflow nodes resolve child workflows from the same file store.
const runs = new RunRegistry((id) => apiStore.load(id), executionRegistry, project?.errorOperation);
if (!project) {
  for (const flow of [
    createWeatherFlow(),
    createLoginFlow(),
    ...createAnomalyFlows(),
    ...createPradarFlows(),
  ]) {
    if (!apiStore.load(flow.id)) apiStore.save(flow, flow.id.includes('/') ? flow.id : `default/${flow.id}`);
  }
}

const agentRuns = new AgentRunManager(
  project ? project.root : projectDir,
  apiStore.dir,
  apiStore.pathOf.bind(apiStore),
  () => nodesPayload(validationRegistry).nodes.map(({ type, label, description }) => ({ type, label, description })),
  project?.language ?? 'typescript',
  // Fresh per run: re-read emberflow/infrastructure.json so a scout that ran
  // earlier this session primes later prompts. Malformed → null (agent guesses).
  () => loadInfrastructure(project ? project.root : projectDir),
);

// Hot-reload agent-authored nodes: watch the project's config and rebuild the
// node registries IN-PROCESS (no process restart), so registering a node in
// `registerNodes` takes effect live. Critically, this survives an in-flight
// agent run — the agent edits the config to author a node mid-build, and a full
// restart (what `tsx watch` would do) kills its stream + child process. Under
// `tsx watch`, the project dir is excluded from the watcher (see run.sh) so tsx
// doesn't reboot and undo this.
if (project) {
  const cfgPath = configPathFor(project.root);
  if (cfgPath) {
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    watch(cfgPath, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        void (async () => {
          try {
            const fresh = await loadProjectConfig(project.root, { fresh: true });
            const rebuilt = buildRegistries(fresh);
            validationRegistry.adopt(rebuilt.validation);
            executionRegistry.adopt(rebuilt.execution);
            console.log(
              `[runner] reloaded project nodes in-process — ${executionRegistry.list().length} registered (no restart)`,
            );
          } catch (err) {
            console.warn(
              `[runner] project config reload failed, keeping previous nodes: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })();
      }, 150);
    });
  }
}

const app = express();
// strict: false so a literal `null` JSON body (used by PUT
// /environments/:name/auth to clear auth config) parses instead of being
// rejected as invalid JSON — strict mode only accepts objects/arrays.
app.use(express.json({ limit: '5mb', strict: false }));

const api = express.Router();

api.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', mock: servingMode === 'mock' });
});

// Runtime serving-mode switch: mock is a LIVE flag, not a boot-time
// decision. EMBERFLOW_MOCK only seeds the initial value (below); this route
// flips it while the process keeps running, so every already-mounted
// operation route (built once at boot with BOTH a real and a mock handler,
// see the mounting loop further down) starts dispatching to the other
// handler on the very next request — no remount, no restart.
api.post('/serving', (req: Request, res: Response) => {
  const { mode } = (req.body ?? {}) as { mode?: unknown };
  if (mode !== 'real' && mode !== 'mock') {
    res.status(400).json({ error: `mode must be 'real' or 'mock', got: ${String(mode)}` });
    return;
  }
  if (mode !== servingMode) {
    servingMode = mode;
    console.log(`[emberflow] serving mode → ${servingMode}`);
  }
  res.status(204).end();
});

api.get('/nodes', (_req, res) => {
  res.json(nodesPayload(validationRegistry));
});

// Validate a flow against the runner's LIVE registry (built-ins + project
// nodes) so the CLI `validate` command doesn't false-reject ops that use
// project-registered node types (which a local createDefaultRegistry lacks).
api.post('/validate', (req, res) => {
  const body = (req.body ?? {}) as { flow?: unknown };
  const flow = (body.flow ?? req.body) as WorkflowDefinition;
  if (!flow || typeof flow !== 'object' || !Array.isArray((flow as { nodes?: unknown }).nodes)) {
    res.status(400).json({ error: 'Body must be a flow (or { flow })' });
    return;
  }
  const issues = validateFlow(flow, validationRegistry);
  res.json({ valid: !issues.some((i) => i.severity === 'error'), issues });
});

api.get('/samples', (req: Request, res: Response) => {
  const nodeId = req.query.nodeId;
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    res.status(400).json({ error: 'Query param nodeId is required' });
    return;
  }
  // Samples are recorded per-node across runs and may originate from any
  // environment, so redact against EVERY environment's secrets. Each env is
  // applied as an independent pass (not one merged map): two envs may define
  // the same secret KEY with different VALUES, and a merged map would keep
  // only one of them, letting the other pass through raw. Record-time
  // storage stays raw; this is response-time only.
  let out: unknown = { samples: runs.samplesFor(nodeId) };
  for (const env of Object.values(environmentsFile.environments)) {
    out = redactSecrets(out, env.secrets);
  }
  res.json(out);
});

api.get('/environments', (_req, res) => {
  // The agent (setup-environments / setup-auth) edits emberflow.environments.json
  // directly on disk — re-read it here so the studio sees new environments
  // without a runner restart. Mutate the shared object in place (every other
  // route closes over it); a malformed mid-edit file keeps the last good state.
  try {
    const fresh = loadEnvironments(project ? project.root : process.cwd());
    environmentsFile.defaultEnvironment = fresh.defaultEnvironment;
    environmentsFile.environments = fresh.environments;
    environmentsFile.configured = fresh.configured;
  } catch {
    // keep serving the last successfully loaded state
  }
  res.json({
    // False while the project has no environments file — the studio shows
    // its zero-environment onboarding state instead of the synthesized
    // "local" fallback entry.
    configured: environmentsFile.configured,
    defaultEnvironment: environmentsFile.defaultEnvironment,
    environments: Object.entries(environmentsFile.environments).map(([name, env]) => ({
      name,
      protected: !!env.protected,
      varKeys: Object.keys(env.vars),
      secretKeys: Object.keys(env.secrets),
      auth: {
        configured: !!env.auth,
        authenticated: !!(env.auth && env.secrets[env.auth.attach.secretRef]),
        ...(env.auth ? { secretRef: env.auth.attach.secretRef, config: env.auth } : {}),
      },
    })),
  });
});

// The infrastructure scout writes emberflow/infrastructure.json on disk; like
// /environments, re-read it per request so the studio's Infra tab reflects a
// just-completed scout without a runner restart. Keep-last-good semantics:
// a MALFORMED mid-write file (loadInfrastructure → null while the file exists)
// keeps the last successfully-loaded manifest served; a genuinely ABSENT file
// reports not-present and clears the cache.
let lastGoodInfrastructure = loadInfrastructure(project ? project.root : process.cwd());
function readInfrastructure(): ReturnType<typeof loadInfrastructure> {
  const infraPath = join(project ? project.root : process.cwd(), 'emberflow', 'infrastructure.json');
  if (!existsSync(infraPath)) {
    lastGoodInfrastructure = null;
    return null;
  }
  const fresh = loadInfrastructure(project ? project.root : process.cwd());
  if (fresh) lastGoodInfrastructure = fresh;
  return fresh ?? lastGoodInfrastructure;
}

api.get('/infrastructure', (_req: Request, res: Response) => {
  const manifest = readInfrastructure();
  if (!manifest) {
    res.json({ present: false });
    return;
  }
  res.json({ present: true, manifest });
});

// A second POST for the same environment while one is already in flight
// awaits the same promise instead of double-firing the upstream login
// request. Different environments don't block each other.
const loginsInFlight = new Map<string, Promise<{ secretRef: string }>>();

api.post('/environments/:name/login', async (req: Request, res: Response) => {
  const name = String(req.params.name);
  const envDef = environmentsFile.environments[name];
  if (!envDef) {
    res.status(404).json({ error: `unknown environment "${name}"` });
    return;
  }
  if (!envDef.auth?.login) {
    res.status(400).json({ error: `environment "${name}" has no auth.login configured` });
    return;
  }
  try {
    let inFlight = loginsInFlight.get(name);
    if (!inFlight) {
      inFlight = performLogin(project ? project.root : process.cwd(), name, envDef).finally(() => {
        loginsInFlight.delete(name);
      });
      loginsInFlight.set(name, inFlight);
    }
    const { secretRef } = await inFlight;
    // Reload from disk so this in-process copy (and subsequent GET/runs) see
    // the secret performLogin just persisted via setEnvironmentSecret.
    const reloaded = loadEnvironments(project ? project.root : process.cwd());
    environmentsFile.environments[name] = reloaded.environments[name];
    res.status(200).json({ authenticated: true, secretRef });
  } catch (err) {
    // Never leak the captured credential — only the failure reason.
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  }
});

/** Reloads `environmentsFile.environments[name]` from disk after a write, so
 *  this in-process copy (and subsequent GET/runs) see what the writer just
 *  persisted — same reload pattern as the login route above. */
function refreshEnvironmentFromDisk(name: string): void {
  const reloaded = loadEnvironments(project ? project.root : process.cwd());
  environmentsFile.environments[name] = reloaded.environments[name];
}

api.put('/environments/:name/auth', async (req: Request, res: Response) => {
  const name = String(req.params.name);
  if (!environmentsFile.environments[name]) {
    res.status(404).json({ error: `unknown environment "${name}"` });
    return;
  }
  const auth = (req.body ?? null) as EnvAuth | null;
  try {
    await setEnvironmentAuth(project ? project.root : process.cwd(), name, auth);
    refreshEnvironmentFromDisk(name);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

api.put('/environments/:name/secrets/:key', async (req: Request, res: Response) => {
  const name = String(req.params.name);
  const key = String(req.params.key);
  if (!environmentsFile.environments[name]) {
    res.status(404).json({ error: `unknown environment "${name}"` });
    return;
  }
  const value = (req.body as { value?: unknown } | undefined)?.value;
  if (typeof value !== 'string') {
    res.status(400).json({ error: 'Body must include { value: string }' });
    return;
  }
  try {
    // Never log or echo `value` — it is a secret and must not transit back
    // to the caller or appear in any log line.
    await setEnvironmentSecret(project ? project.root : process.cwd(), name, key, value);
    refreshEnvironmentFromDisk(name);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

api.delete('/environments/:name/secrets/:key', async (req: Request, res: Response) => {
  const name = String(req.params.name);
  const key = String(req.params.key);
  if (!environmentsFile.environments[name]) {
    res.status(404).json({ error: `unknown environment "${name}"` });
    return;
  }
  try {
    await deleteEnvironmentSecret(project ? project.root : process.cwd(), name, key);
    refreshEnvironmentFromDisk(name);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

api.get('/workflows', (_req, res) => {
  res.json({ flows: apiStore.list(), operations: apiStore.listSummaries() });
});

api.put('/workflows/:id', (req: Request, res: Response) => {
  const body = req.body as WorkflowDefinition | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.id !== String(req.params.id)) {
    res.status(400).json({ error: 'Body must be a flow object whose id matches the URL' });
    return;
  }
  // Normalize before validation/persist so what's saved to disk (and served
  // back to studio/CLI) already carries seeded param defaults.
  const { flow } = seedParamDefaults(body);
  try {
    const relPath = apiStore.pathOf(flow.id) ?? `default/${flow.id}`;
    apiStore.save(flow, relPath);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.status(200).json({ ok: true });
});

api.delete('/workflows/:id', (req, res) => {
  if (apiStore.remove(req.params.id)) res.status(204).end();
  else res.status(404).json({ error: `Unknown workflow: ${req.params.id}` });
});

// Studio "Test" button: runs one op's `expect`-carrying scenarios in-process,
// reusing this already-booted server's apiStore/executionRegistry/
// environmentsFile (no re-read from disk, no drift from in-memory writes)
// via the shared seam server/testRunner.ts exports — same suite/evaluation/
// redaction path the CLI's `emberflow test` uses, NO second expectation
// engine. Deliberately bypasses RunRegistry (bare `startRun`, same as the
// CLI path): these runs must never surface as SSE events or run history.
api.post('/workflows/:id/test', async (req: Request, res: Response) => {
  const opId = String(req.params.id);
  if (!apiStore.load(opId)) {
    res.status(404).json({ error: `Unknown workflow: ${opId}` });
    return;
  }
  const { environment } = (req.body ?? {}) as { environment?: unknown };
  if (environment !== undefined && typeof environment !== 'string') {
    res.status(400).json({ error: 'environment must be a string' });
    return;
  }
  try {
    const report = await runScenarioSuiteFor(
      { apiStore, registry: executionRegistry, environmentsFile },
      { opId, environmentName: environment },
    );
    res.json(report);
  } catch (err) {
    if (err instanceof ScenarioTestUsageError) {
      res.status(400).json({ error: err.message });
      return;
    }
    // Unexpected error (e.g. startRun rejecting an invalid flow): the studio
    // consumes this route, so answer JSON like every sibling route — never
    // Express's default HTML 500 page.
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// `emberflow doctor` / studio diagnostics panel: loads the op + its
// scenarios sidecar exactly as POST /workflows/:id/test does (apiStore.load
// merges <op>.scenarios.json in), then runs the pure src/engine/diagnostics
// check — no execution, no environment needed.
api.get('/workflows/:id/diagnostics', (req: Request, res: Response) => {
  const opId = String(req.params.id);
  const flow = apiStore.load(opId);
  if (!flow) {
    res.status(404).json({ error: `Unknown workflow: ${opId}` });
    return;
  }
  const infraNodes: Array<{ id: string; traceKind: string }> = [];
  const mutationSourcesByNode: Record<string, string> = {};
  for (const n of flow.nodes) {
    if (!validationRegistry.has(n.type)) continue;
    const { definition, implementation } = validationRegistry.get(n.type);
    const { traceKind } = definition;
    if (traceKind === 'db' || traceKind === 'http' || traceKind === 'llm') {
      infraNodes.push({ id: n.id, traceKind });
    }
    if (definition.effects === 'mutation' && typeof implementation === 'function') {
      mutationSourcesByNode[n.id] = String(implementation);
    }
  }
  const diagnostics = diagnoseOperation(flow, flow.scenarios, {
    infraNodes,
    mutationSourcesByNode,
    languageDrift: project?.languageDrift,
  });
  res.json({ diagnostics });
});

/** A relative `apis/` path is safe when it has no `..` segment, isn't
 *  absolute, and doesn't carry a Windows-only backslash separator that could
 *  otherwise escape `apiStore.dir` via `path.join` on Windows — it must stay
 *  inside the project's apis/ directory. */
function isSafeApiPath(path: string): boolean {
  return isPathWithin(apiStore.dir, path);
}

// The studio creates new operations here (not via PUT /workflows/:id): a
// brand-new operation isn't yet in apiStore's id->path index, so PUT's
// `pathOf(id) ?? default/${id}` fallback would bury a nested new op under
// `default/` instead of at its intended api/folder path. This endpoint takes
// the intended path explicitly.
api.post('/operations', (req: Request, res: Response) => {
  const body = req.body as { flow?: WorkflowDefinition; path?: string } | undefined;
  const rawFlow = body?.flow;
  const path = body?.path;
  if (!rawFlow || typeof rawFlow !== 'object' || Array.isArray(rawFlow)) {
    res.status(400).json({ error: 'Body must include a flow object' });
    return;
  }
  if (!isSafeApiPath(path ?? '')) {
    res.status(400).json({ error: 'Body must include a safe relative path (no ".." or absolute paths)' });
    return;
  }
  // The id-as-path invariant: createOperation always mints id === path, so a
  // mismatch means the caller isn't using this endpoint as intended — reject
  // rather than let the op's id and its on-disk path drift apart.
  if (rawFlow.id !== path) {
    res.status(400).json({ error: 'flow.id must equal path' });
    return;
  }
  // This endpoint is for creating brand-new operations, not overwriting ones
  // that already exist at that path (that's PUT /workflows/:id) — silently
  // clobbering an existing file here would be data loss.
  if (apiStore.existsAt(path!)) {
    res.status(409).json({ error: `operation already exists at ${path}` });
    return;
  }
  // Normalize before persist — belt-and-braces alongside `emberflow create`'s
  // own scaffolding, so a new op is guaranteed to already satisfy the
  // missing-param-default guard whatever created it.
  const { flow } = seedParamDefaults(rawFlow);
  try {
    apiStore.save(flow, path!);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.status(201).json({ ok: true });
});

/** Deep-copy a flow with every node's metadata.pinnedOutput removed. */
function stripMetadataPins(flow: WorkflowDefinition): WorkflowDefinition {
  const copy = structuredClone(flow);
  for (const node of copy.nodes) {
    if (!node.metadata) continue;
    delete node.metadata.pinnedOutput;
    if (Object.keys(node.metadata).length === 0) delete node.metadata;
  }
  return copy;
}

api.post('/runs', async (req: Request, res: Response) => {
  const { flow, artifact, mode, pins, input, env, environment, safeMode, confirm, scenarioName } = req.body ?? {};
  if (mode !== 'run' && mode !== 'step') {
    res.status(400).json({ error: 'Body must include mode: "run"|"step"' });
    return;
  }
  if (scenarioName !== undefined && typeof scenarioName !== 'string') {
    res.status(400).json({ error: 'scenarioName must be a string' });
    return;
  }
  if (pins !== undefined && (typeof pins !== 'object' || pins === null || Array.isArray(pins))) {
    res.status(400).json({ error: 'pins must be a plain object of nodeId -> output' });
    return;
  }
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    res.status(400).json({ error: 'input must be a plain object' });
    return;
  }
  if (environment !== undefined && typeof environment !== 'string') {
    res.status(400).json({ error: 'environment must be a string' });
    return;
  }
  if (safeMode !== undefined && typeof safeMode !== 'boolean') {
    res.status(400).json({ error: 'safeMode must be a boolean' });
    return;
  }
  if (confirm !== undefined && typeof confirm !== 'string') {
    res.status(400).json({ error: 'confirm must be a string' });
    return;
  }

  const environmentName = environment ?? environmentsFile.defaultEnvironment;
  const environmentDef = environmentsFile.environments[environmentName];
  if (!environmentDef) {
    res.status(400).json({ error: `Unknown environment: '${environmentName}'` });
    return;
  }
  const safety = resolveRunSafety(environmentName, environmentDef, { safeMode, confirm });
  if (!safety.ok) {
    res.status(400).json({ error: safety.error });
    return;
  }

  // Artifact runs force production semantics; env may also request it explicitly.
  const isArtifactRun = artifact !== undefined;
  const production = isArtifactRun || env === 'production';

  // Production rejects request pins (metadata pins are ignored, never derived).
  if (production && pins !== undefined && Object.keys(pins).length > 0) {
    res.status(400).json({ error: 'pins are not allowed in production runs' });
    return;
  }

  let effectiveFlow: WorkflowDefinition;
  if (isArtifactRun) {
    if (!isArtifact(artifact)) {
      res.status(400).json({ error: 'artifact must be a valid emberflow/v1 artifact' });
      return;
    }
    const drift = await verifyArtifact(artifact, runs.executionRegistry);
    if (drift.length > 0) {
      res.status(400).json({ error: `implementation drift: ${drift.join(', ')}` });
      return;
    }
    effectiveFlow = artifact.flow;
  } else if (flow) {
    effectiveFlow = flow;
  } else {
    res.status(400).json({ error: 'Body must include either flow or artifact' });
    return;
  }

  // In production, strip metadata pins so no node can be pin-shortcut.
  if (production) effectiveFlow = stripMetadataPins(effectiveFlow);

  const errors = validateFlow(effectiveFlow, validationRegistry).filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    res.status(400).json({ error: errors.map((i) => i.message).join('; ') });
    return;
  }

  // Dev runs honour request pins; production runs never do.
  const effectivePins = production ? undefined : pins;

  // Mock serving mode reads `servingMode` live (a module-level flag flipped
  // by POST /serving, not a boot-time decision) — a production/artifact run
  // always runs for real regardless of serving mode, same as the pins guard
  // above. Nothing real is ever touched in a mock run: no credential
  // auto-attach, no infra implementation calls — the engine's mockRun
  // short-circuit is the ONLY thing that changes execution.
  const mockRun = servingMode === 'mock' && !production;
  let effectiveMocks: Record<string, unknown> | undefined;
  if (mockRun) {
    let scenario: ScenarioDefinition | undefined;
    if (scenarioName !== undefined) {
      scenario = findScenario(effectiveFlow, scenarioName);
      if (!scenario) {
        res.status(400).json({ error: `Unknown scenario: "${scenarioName}"` });
        return;
      }
    }
    effectiveMocks = mergeMocks(effectiveFlow, scenario);
  }

  // Auto-attach the environment's credential (if configured) before the run
  // starts. Non-destructive: attachCredential leaves caller-supplied
  // header/cookie values untouched. Never log the secret value. Skipped
  // entirely in a mock run — nothing real is ever touched.
  let effectiveInput = input;
  if (!mockRun) {
    const attach = environmentDef.auth?.attach;
    if (attach) {
      const secretValue = environmentDef.secrets[attach.secretRef];
      if (secretValue !== undefined) {
        effectiveInput = {
          ...(input ?? {}),
          headers: attachCredential((input ?? {}).headers ?? {}, attach, secretValue),
        };
      }
    }
  }

  let runId: string;
  let handle;
  try {
    ({ runId, handle } = runs.create(effectiveFlow, {
      secrets: environmentDef.secrets,
      vars: environmentDef.vars,
      environment: environmentName,
      safeMode: safety.safeMode,
      pins: effectivePins,
      input: effectiveInput,
      mockRun,
      mocks: effectiveMocks,
    }));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  if (mode === 'run') {
    handle.runToEnd().catch((err: unknown) => {
      console.error(`[run ${runId}] runToEnd failed:`, err);
    });
  }
  res.status(201).json({ runId });
});

// Run a single node in isolation (studio's "Run node" affordance). Executes the
// node's implementation in-process against the resolved environment's
// secrets/vars, honouring safe mode via resolveRunSafety, and redacts the
// output through the same choke point runs use. Unknown type → 404. The studio
// bundles no implementations, so this is the ONLY path to a lone node run.
api.post('/node-run', async (req: Request, res: Response) => {
  const { type, input, config, environment, safeMode, confirm } = req.body ?? {};
  if (typeof type !== 'string' || type.length === 0) {
    res.status(400).json({ error: 'Body must include a node "type"' });
    return;
  }
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    res.status(400).json({ error: 'input must be a plain object' });
    return;
  }
  if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
    res.status(400).json({ error: 'config must be a plain object' });
    return;
  }
  if (environment !== undefined && typeof environment !== 'string') {
    res.status(400).json({ error: 'environment must be a string' });
    return;
  }
  if (safeMode !== undefined && typeof safeMode !== 'boolean') {
    res.status(400).json({ error: 'safeMode must be a boolean' });
    return;
  }
  if (!runs.executionRegistry.has(type)) {
    res.status(404).json({ error: `Unknown node type: ${type}` });
    return;
  }
  const environmentName = environment ?? environmentsFile.defaultEnvironment;
  const environmentDef = environmentsFile.environments[environmentName];
  if (!environmentDef) {
    res.status(400).json({ error: `Unknown environment: '${environmentName}'` });
    return;
  }
  const safety = resolveRunSafety(environmentName, environmentDef, { safeMode, confirm });
  if (!safety.ok) {
    res.status(400).json({ error: safety.error });
    return;
  }

  const { implementation } = runs.executionRegistry.get(type);
  const runId = `node-run-${randomUUID().slice(0, 8)}`;
  const logs: LogLine[] = [];
  const log = (level: LogLine['level'], message: string): void => {
    logs.push({ timestamp: new Date().toISOString(), level, runId, message });
  };
  const nodeInput = (input ?? {}) as Record<string, unknown>;

  let result: { output?: unknown; error?: string; logs: LogLine[] };
  try {
    const output = await implementation({
      input: nodeInput,
      config: (config ?? {}) as Record<string, unknown>,
      secrets: environmentDef.secrets,
      vars: environmentDef.vars,
      environment: environmentName,
      safeMode: safety.safeMode,
      runInput: nodeInput,
      log,
      // A node run in isolation has no flow context to resolve child workflows.
      runSubflow: async () => ({
        status: 'failed',
        error: 'Subflow nodes cannot be run in isolation — run the whole operation instead',
      }),
    });
    result = { output, logs };
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err), logs };
  }
  // Redact secret values from the output AND captured logs before responding.
  res.json(redactSecrets(result, environmentDef.secrets));
});

api.post('/runs/:id/step', async (req, res) => {
  const handle = runs.get(req.params.id);
  if (!handle) {
    res.status(404).json({ error: `Unknown run: ${req.params.id}` });
    return;
  }
  const more = await handle.step();
  res.json({ done: !more });
});

api.post('/runs/:id/cancel', (req, res) => {
  const handle = runs.get(req.params.id);
  if (!handle) {
    res.status(404).json({ error: `Unknown run: ${req.params.id}` });
    return;
  }
  handle.cancel();
  res.status(204).end();
});

api.get('/runs/:id/events', (req, res) => {
  const runId = req.params.id;
  if (!runs.get(runId)) {
    res.status(404).json({ error: `Unknown run: ${runId}` });
    return;
  }

  let unsubscribe: (() => void) | undefined;
  const sse = openSse(req, res, () => unsubscribe?.());

  const listener = (event: RunEvent): void => {
    sse.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'finished') {
      unsubscribe?.();
      sse.end();
    }
  };

  unsubscribe = runs.subscribe(runId, listener);
});

api.get('/agent/available', (_req: Request, res: Response) => {
  res.json({ agents: detectAgents() });
});

// First-run onboarding aggregate for the Welcome checklist (studio's
// WelcomeDialog). Recomputed per request (cheap; mirrors /environments'
// re-read-on-GET) so a freshly-detected agent, a just-written environments
// file, or an installed skill shows up without a runner restart. All fields
// are derived from what already exists on disk/PATH — no probes, no side
// effects.
api.get('/setup-status', (_req: Request, res: Response) => {
  const root = project ? project.root : process.cwd();
  // Fresh environments read (malformed mid-edit file → last good state).
  let envs = environmentsFile;
  try {
    envs = loadEnvironments(root);
  } catch {
    // keep the last successfully loaded state
  }
  const envList = Object.values(envs.environments);
  const ops = apiStore.list();
  // A pristine project ships exactly the single `default/hello` example op.
  const onlyHello = ops.length === 1 && ops[0]?.id === 'default/hello';
  res.json({
    agents: detectAgents(),
    environments: {
      configured: envs.configured,
      // The synthesized "local" fallback is "no environments yet" — report 0.
      count: envs.configured ? envList.length : 0,
      protectedCount: envList.filter((e) => e.protected).length,
      anyAuthConfigured: envList.some((e) => !!e.auth),
    },
    // Skills count as installed at either scope: repo (`init --local`) or the
    // user's home dir (`init --global`) — both teach the agent equally.
    skills: {
      claude: skillInstalled(root, 'claude'),
      codex: skillInstalled(root, 'codex'),
    },
    language: project?.language ?? 'typescript',
    ops: { count: ops.length, onlyHello },
    servingMode,
    // Infrastructure scout: present + a shallow summary (scannedAt/itemCount)
    // from the same loader the /infrastructure route uses (re-read per request).
    infrastructure: infraStatus(),
  });
});

/** Whether the emberflow-basics skill exists for a harness, repo- or home-scoped. */
function skillInstalled(root: string, harness: 'claude' | 'codex'): boolean {
  return [root, homedir()].some((base) =>
    existsSync(join(base, `.${harness}`, 'skills', 'emberflow-basics', 'SKILL.md')),
  );
}

/** The /setup-status `infrastructure` field: presence + a shallow summary. */
function infraStatus(): { present: boolean; scannedAt?: string; itemCount?: number } {
  const manifest = readInfrastructure();
  if (!manifest) return { present: false };
  return {
    present: true,
    ...(manifest.scannedAt ? { scannedAt: manifest.scannedAt } : {}),
    itemCount: manifest.items.length,
  };
}

api.post('/agent', (req: Request, res: Response) => {
  const { agent, model, intent } = req.body ?? {};
  if (agent !== undefined && agent !== 'codex' && agent !== 'claude') {
    res.status(400).json({ error: `Unsupported agent: ${agent}` });
    return;
  }
  if (!intent || typeof intent !== 'object' || typeof intent.action !== 'string' || typeof intent.instruction !== 'string') {
    res.status(400).json({ error: 'Body must include intent: { action, flowId, instruction, ... }' });
    return;
  }
  if (
    intent.action !== 'new-scenario' &&
    intent.action !== 'edit-node' &&
    intent.action !== 'edit-flow' &&
    intent.action !== 'new-operation' &&
    intent.action !== 'setup-auth' &&
    intent.action !== 'setup-environments' &&
    intent.action !== 'scout-infrastructure' &&
    intent.action !== 'cover-operation' &&
    intent.action !== 'ask'
  ) {
    res.status(400).json({
      error: `Unsupported intent.action: ${intent.action}. Must be one of new-scenario, edit-node, edit-flow, new-operation, setup-auth, setup-environments, scout-infrastructure, cover-operation, ask.`,
    });
    return;
  }
  if (intent.action === 'new-operation') {
    if (typeof intent.location !== 'string') {
      res.status(400).json({ error: 'Body must include intent: { action: "new-operation", location, instruction }' });
      return;
    }
  } else if (intent.action === 'setup-auth') {
    if (typeof intent.environment !== 'string') {
      res.status(400).json({ error: 'Body must include intent: { action: "setup-auth", environment, instruction }' });
      return;
    }
  } else if (intent.action === 'setup-environments' || intent.action === 'scout-infrastructure') {
    // instruction alone is required, already validated above; no flowId/environment needed.
  } else if (intent.action === 'ask') {
    if (intent.flowId !== undefined && typeof intent.flowId !== 'string') {
      res.status(400).json({ error: 'ask intent: flowId must be a string when present' });
      return;
    }
  } else if (typeof intent.flowId !== 'string') {
    res.status(400).json({ error: 'Body must include intent: { action, flowId, instruction, ... }' });
    return;
  }
  if (model !== undefined && typeof model !== 'string') {
    res.status(400).json({ error: 'model must be a string' });
    return;
  }
  const { reasoning } = req.body ?? {};
  if (reasoning !== undefined && reasoning !== 'low' && reasoning !== 'medium' && reasoning !== 'high') {
    res.status(400).json({ error: "reasoning must be 'low' | 'medium' | 'high'" });
    return;
  }

  let agentRunId: string;
  try {
    agentRunId = agentRuns.start(intent as AgentIntent, { agent, model, reasoning });
  } catch (err) {
    const status = err instanceof AgentStartError ? err.status : 400;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.status(201).json({ agentRunId });
});

api.get('/agent/:id/events', (req, res) => {
  const runId = req.params.id;
  if (!agentRuns.has(runId)) {
    res.status(404).json({ error: `Unknown agent run: ${runId}` });
    return;
  }

  let unsubscribe: (() => void) | undefined;
  const sse = openSse(req, res, () => unsubscribe?.());

  const listener = (event: AgentEvent): void => {
    sse.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'done' || event.type === 'error') {
      unsubscribe?.();
      sse.end();
    }
  };

  unsubscribe = agentRuns.subscribe(runId, listener);
});

api.get('/agent/:id/diff', (req, res) => {
  const result = agentRuns.diff(req.params.id);
  if (!result) {
    res.status(404).json({ error: `Unknown agent run: ${req.params.id}` });
    return;
  }
  res.json(result);
});

api.post('/agent/:id/revert', (req, res) => {
  const result = agentRuns.revert(req.params.id);
  if (!result) {
    res.status(404).json({ error: `Unknown agent run: ${req.params.id}` });
    return;
  }
  res.json(result);
});

api.post('/agent/:id/cancel', (req, res) => {
  if (!agentRuns.cancel(req.params.id)) {
    res.status(404).json({ error: `Unknown agent run: ${req.params.id}` });
    return;
  }
  res.json({ cancelled: true });
});

app.use(api);        // root paths — CLI/MCP compatibility
app.use('/api', api); // same-origin studio paths

// Routed operations run with the project's DEFAULT environment's secrets/vars,
// resolved once here at boot (mirrors how POST /runs resolves environmentDef
// for a request, but there's no per-request environment override for a live
// HTTP endpoint — it always runs as the default environment).
const defaultEnvironmentName = environmentsFile.defaultEnvironment;
const defaultEnvironmentDef = environmentsFile.environments[defaultEnvironmentName];
if (!defaultEnvironmentDef) {
  throw new Error(`defaultEnvironment '${defaultEnvironmentName}' is not defined in emberflow.environments.json`);
}
const operationRunEnv = {
  secrets: defaultEnvironmentDef.secrets,
  vars: defaultEnvironmentDef.vars,
  environment: defaultEnvironmentName,
  safeMode: false,
};

// Internal routes mounted at root via `app.use(api)` above. A routed
// operation whose http.path collides with one of these would silently never
// be reached (the internal route, registered first, always wins) — guarded
// against below rather than left as a silent trap.
const RESERVED_ROOT_PATHS = ['/healthz', '/nodes', '/samples', '/environments', '/workflows', '/runs', '/node-run', '/agent', '/serving'];

function collidesWithReservedPath(path: string): boolean {
  return RESERVED_ROOT_PATHS.some((reserved) => path === reserved || path.startsWith(`${reserved}/`));
}


// Mount every operation with `http` metadata as a live endpoint, at the ROOT
// (not under /api) — e.g. an op with http.path '/ping' serves GET /ping.
// NOTE: operations are read once at boot; adding/editing an operation's http
// trigger after boot needs a restart to take effect (live re-mount is a later
// increment). A duplicate method+path across operations throws here — a
// clear, loud boot failure rather than a silently shadowed route.
const verifiers = createDefaultVerifierRegistry();
project?.registerVerifiers?.(verifiers);

const adapter = new ExpressAdapter(app);
const candidateOps = apiStore.list().filter((op) => op.http);
let invalidPathCount = 0;
let reservedCollisionCount = 0;
const routedOps = candidateOps.filter((op) => {
  const path = op.http!.path;
  if (!isMountablePath(path)) {
    invalidPathCount += 1;
    console.warn(
      `[runner] operation ${op.id} has an invalid/root path "${path}" — skipping (would shadow the studio)`,
    );
    return false;
  }
  if (collidesWithReservedPath(path)) {
    reservedCollisionCount += 1;
    console.warn(
      `[runner] operation ${op.id} path ${op.http!.method} ${path} collides with a reserved internal route — skipping`,
    );
    return false;
  }
  return true;
});
if (servingMode === 'mock') {
  console.log('[emberflow] MOCK MODE — responses come from scenario expectations; no nodes execute, no auth enforced');
}

/** Mock-mode route handler: NO auth, NO node execution — answers purely from
 *  the op's scenario `expect`s via `mockResponseFor` (Task 5). Scenarios are
 *  re-read from disk per request (via `apiStore.load`, already a cheap full
 *  rescan used elsewhere in this file) rather than captured once at boot, so
 *  a mock author editing a scenario's `expect` sees it on the next request
 *  without restarting the runner. */
function makeMockHandler(op: WorkflowDefinition): import('express').RequestHandler {
  return (req, res) => {
    const fresh = apiStore.load(op.id) ?? op;
    const { status, body } = mockResponseFor(fresh, fresh.scenarios ?? [], {
      headers: req.headers as Record<string, unknown>,
      query: req.query as Record<string, unknown>,
    });
    res.setHeader('x-emberflow-mock', 'true');
    res.status(status).json(body ?? null);
  };
}

let failClosedCount = 0;
for (const op of routedOps) {
  // Build BOTH handlers once at mount time (mirroring today's boot-time
  // resolveAuth + makeOperationHandler construction exactly on the real
  // side) and dispatch between them per-request on the live `servingMode`
  // flag — mock is now a runtime switch, not a structural boot decision.
  // Auth is resolved once here, same as before; it is never re-resolved
  // per request.
  const mockHandler = makeMockHandler(op);
  let realHandler: import('express').RequestHandler;
  try {
    const policy = apiStore.resolveAuth(op.id);
    realHandler = makeOperationHandler({ runs, op, env: operationRunEnv, policy, verifiers });
  } catch (err) {
    // resolveAuth throws when a PRESENT _meta.json in this op's ancestor
    // chain is corrupt (partial write, typo, etc.) — we cannot know what
    // auth policy was intended, so we must not mount the op open. Contain
    // the blast radius to just this op/route: deny it with a 500 rather
    // than skipping it (which would leave the route unmounted and 404,
    // less honest than "misconfigured") or, worse, silently falling back to
    // public. The rest of the runner still boots normally. This fail-closed
    // handler only applies to the real path — mock mode still answers from
    // scenarios regardless of a broken auth config, since mock never
    // enforces auth.
    failClosedCount += 1;
    console.error(`[runner] operation ${op.id} has broken auth config — mounted as fail-closed (500): ${String(err)}`);
    realHandler = (_req, res) => res.status(500).json({ error: 'auth misconfigured' });
  }
  adapter.registerOperation({ method: op.http!.method, path: op.http!.path }, (req, res) => {
    if (servingMode === 'mock') mockHandler(req, res, () => {});
    else void realHandler(req, res, () => {});
  });
}
console.log(
  `[runner] mounted ${routedOps.length} HTTP operation(s)${invalidPathCount > 0 ? ` (${invalidPathCount} skipped — invalid/root path)` : ''}${reservedCollisionCount > 0 ? ` (${reservedCollisionCount} skipped — reserved route collision)` : ''}${failClosedCount > 0 ? ` (${failClosedCount} fail-closed — broken auth config)` : ''}`,
);

const serveStudio = process.env.EMBERFLOW_SERVE_STUDIO === '1';
if (serveStudio) {
  // fileURLToPath, not import.meta.dirname — the latter is undefined on Node
  // < 20.11, which would silently break studio serving for consumers on older
  // Node (404 at the studio root).
  const here = dirname(fileURLToPath(import.meta.url));
  // studio-dist ships at the PACKAGE ROOT (a `files` entry), next to server/ in
  // source but two levels up from the compiled `dist/server/index.js`. Probe
  // both layouts so JS consumers on plain-node dist serve the studio too, not
  // just tsx/source runs (`../studio-dist` alone resolves to a non-existent
  // `dist/studio-dist` under dist and 404s the studio root).
  const studioDir = [join(here, '..', 'studio-dist'), join(here, '..', '..', 'studio-dist')].find(
    existsSync,
  );
  if (studioDir) {
    app.use(express.static(studioDir));
    // SPA fallback: any non-API GET returns index.html.
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(studioDir, 'index.html')));
  } else {
    console.warn(
      `[runner] EMBERFLOW_SERVE_STUDIO=1 but no studio-dist found near ${here} — run \`npm run build:studio\``,
    );
  }
}

app.listen(PORT, HOST, () => {
  console.log(`[emberflow-runner] listening on http://${HOST}:${PORT} — ${runs.nodeCount} nodes registered`);
  if (serveStudio) {
    const url = `http://${HOST}:${PORT}`;
    console.log(`[runner] studio at ${url}`);
    // Opt-in only. Under `tsx watch` the server reboots on every file change,
    // and an unconditional open spawns a browser tab per restart (a tab storm
    // during rapid edits). run.sh opens the browser once after readiness, so
    // the default is off; set EMBERFLOW_OPEN_BROWSER=1 for a one-shot launch.
    if (process.env.EMBERFLOW_OPEN_BROWSER === '1') openBrowser(url);
  }
});
