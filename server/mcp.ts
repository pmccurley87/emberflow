import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  findScenario,
  publishFlow,
  scenarioNames,
  validateFlow,
  type WorkflowDefinition,
} from '../src/engine';
import { createDefaultRegistry } from '../src/nodes';
import * as client from './client';

/** Wraps any value as an MCP text-content result. */
function json(value: unknown, isError = false): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Runs a handler, turning any thrown error into an isError text result. */
async function guard(
  fn: () => Promise<ReturnType<typeof json>>,
): Promise<ReturnType<typeof json>> {
  try {
    return await fn();
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, true);
  }
}

const server = new McpServer({ name: 'emberflow', version: '0.0.0' });

server.tool('list_nodes', 'List all registered node types', {}, () =>
  guard(async () => {
    const registry = createDefaultRegistry();
    return json(
      registry.list().map((d) => ({
        type: d.type,
        label: d.label,
        category: d.category,
        description: d.description,
      })),
    );
  }),
);

server.tool(
  'get_node_schema',
  'Get the full NodeDefinition for a node type',
  { type: z.string() },
  ({ type }) =>
    guard(async () => {
      const registry = createDefaultRegistry();
      if (!registry.has(type)) return json({ error: `Unknown node type: ${type}` }, true);
      return json(registry.get(type).definition);
    }),
);

server.tool(
  'list_operations',
  'List every operation the runner knows, annotated with its API location. Each entry: ' +
    '{ id, name, path, folder, http }. "path" is the apis/ tree location (api/…folders/op) ' +
    'and equals the id. "http" is the HTTP trigger { method, path } for operations exposed as ' +
    'endpoints — an HTTP operation runs as Input({ params, query, body, headers }) → ' +
    'Response({ status, body }); "http" is null for internal sub-flow operations invoked by ' +
    'other operations rather than over HTTP.',
  {},
  () =>
    guard(async () => {
      const ops = await client.listOperations();
      return json(
        ops.map((op) => ({
          id: op.id,
          name: op.name,
          path: op.path,
          folder: op.path.split('/')[0],
          http: op.http ? { method: op.http.method, path: op.http.path } : null,
        })),
      );
    }),
);

server.tool(
  'list_apis',
  'Return the API tree: top-level APIs → folders → operations (each op carries its ' +
    'id, name, path, and http trigger, if any). Built from the operations\' apis/ paths so an ' +
    'agent can see how operations are organised across APIs and which are HTTP endpoints ' +
    'vs internal sub-flows.',
  {},
  () => guard(async () => json(await client.apiTree())),
);

server.tool(
  'get_operation',
  "Get an operation's full JSON by id (its nodes, edges, http trigger + auth, scenarios). " +
    'The id equals the operation\'s apis/ path.',
  { id: z.string() },
  ({ id }) =>
    guard(async () => {
      const flow = await client.getWorkflow(id);
      if (!flow) return json({ error: `Unknown operation: ${id}` }, true);
      return json(flow);
    }),
);

server.tool(
  'create_operation',
  'Create a brand-new operation at an explicit apis/ path via POST /operations. "path" is the ' +
    'apis/ tree location (api/…folders/op) and MUST equal flow.id — the runner rejects a ' +
    'mismatch and 409s if an operation already exists at that path (use save_operation to ' +
    'update an existing one). Set flow.http = { method, path[, auth] } to expose it as an HTTP ' +
    'endpoint (Input({ params, query, body, headers }) → Response({ status, body })); omit http ' +
    'for an internal sub-flow.',
  {
    flow: z.record(z.string(), z.unknown()),
    path: z.string(),
  },
  ({ flow, path }) =>
    guard(async () => {
      const definition = flow as unknown as WorkflowDefinition;
      const registry = createDefaultRegistry();
      const issues = validateFlow(definition, registry);
      if (issues.some((i) => i.severity === 'error')) return json({ issues }, true);
      const result = await client.createOperation(definition, path);
      if (!result.ok) return json({ error: result.error }, true);
      return json({ ok: true, id: definition.id, path });
    }),
);

server.tool(
  'delete_operation',
  'Delete an operation by id (its apis/ tree path, e.g. "billing/charge"). Removes the ' +
    'operation file and its scenarios sidecar from the runner. Prefer this over editing files ' +
    'for removals — a deleted op is unmounted immediately. Returns { ok } or an error if the id ' +
    'is unknown.',
  { id: z.string() },
  ({ id }) =>
    guard(async () => {
      const result = await client.deleteOperation(id);
      if (!result.ok) return json({ error: result.error }, true);
      return json({ ok: true, id });
    }),
);

server.tool(
  'save_operation',
  'Validate then save an existing operation to the runner (rejects operations with ' +
    'error-severity issues). Persists the whole flow including its http trigger ' +
    '({ method, path, auth }) and auth fields. Use create_operation for a brand-new op.',
  { flow: z.record(z.string(), z.unknown()) },
  ({ flow }) =>
    guard(async () => {
      const definition = flow as unknown as WorkflowDefinition;
      const registry = createDefaultRegistry();
      const issues = validateFlow(definition, registry);
      if (issues.some((i) => i.severity === 'error')) return json({ issues }, true);
      await client.saveWorkflow(definition);
      return json({ ok: true, id: definition.id });
    }),
);

server.tool(
  'validate_operation',
  'Validate an operation flow and return its issues (does not save).',
  { flow: z.record(z.string(), z.unknown()) },
  ({ flow }) =>
    guard(async () => {
      const registry = createDefaultRegistry();
      const issues = validateFlow(flow as unknown as WorkflowDefinition, registry);
      const valid = !issues.some((i) => i.severity === 'error');
      return json({ valid, issues });
    }),
);

server.tool(
  'run_operation',
  'Run an operation to completion by id or inline flow; returns status, nodeStates, logs. ' +
    'Accepts either an explicit "input" payload or a "scenario" name/id naming a test input ' +
    'embedded in the operation. For an HTTP operation the input is the request shape ' +
    '{ params, query, body, headers } and the run resolves a Response({ status, body }). ' +
    '"environment" selects a named environment from emberflow.environments.json (default: the ' +
    "runner's default environment). \"safeMode\" overrides safe mode (default: the environment's " +
    'default — protected environments default to safe). Disabling safe mode on a protected ' +
    'environment additionally requires "confirm" to equal "environment" exactly, or the run is ' +
    'rejected.',
  {
    id: z.string().optional(),
    flow: z.record(z.string(), z.unknown()).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    scenario: z.string().optional(),
    environment: z.string().optional(),
    safeMode: z.boolean().optional(),
    confirm: z.string().optional(),
  },
  ({ id, flow, input, scenario, environment, safeMode, confirm }) =>
    guard(async () => {
      let definition: WorkflowDefinition | undefined;
      if (flow) {
        definition = flow as unknown as WorkflowDefinition;
      } else if (id) {
        definition = await client.getWorkflow(id);
        if (!definition) return json({ error: `Unknown operation: ${id}` }, true);
      } else {
        return json({ error: 'run_operation requires either "id" or "flow"' }, true);
      }
      if (scenario && input) {
        return json({ error: 'run_operation accepts either "scenario" or "input", not both' }, true);
      }
      let resolvedInput = input;
      if (scenario) {
        const found = findScenario(definition, scenario);
        if (!found) {
          const names = scenarioNames(definition);
          return json(
            { error: `Unknown scenario: "${scenario}". Available: ${names.length ? names.join(', ') : 'none'}` },
            true,
          );
        }
        resolvedInput = found.input;
      }
      const runId = await client.startRun({
        flow: definition,
        input: resolvedInput,
        environment,
        safeMode,
        confirm,
      });
      const { run, logs } = await client.waitForRun(runId);
      return json(
        { status: run.status, environment: run.environment, safeMode: run.safeMode, nodeStates: run.nodeStates, logs },
        run.status !== 'succeeded',
      );
    }),
);

server.tool(
  'list_environments',
  'List the named environments the runner offers (from emberflow.environments.json): each ' +
    'entry is { name, protected, varKeys, secretKeys } — only key NAMES are returned, never ' +
    'values/secrets. Also returns defaultEnvironment. Use a name as run_operation\'s ' +
    '"environment". Protected environments default to safe mode.',
  {},
  () => guard(async () => json(await client.listEnvironments())),
);

server.tool(
  'publish_operation',
  'Publish an operation by id into a sealed emberflow/v1 artifact (validates, strips pins, ' +
    'hashes node implementations); does not write any files.',
  { id: z.string() },
  ({ id }) =>
    guard(async () => {
      const flow = await client.getWorkflow(id);
      if (!flow) return json({ error: `Unknown operation: ${id}` }, true);
      const registry = createDefaultRegistry();
      const artifact = await publishFlow(flow, registry);
      return json(artifact);
    }),
);

server.tool(
  'get_node_samples',
  'Get recorded execution samples for a node',
  { nodeId: z.string() },
  ({ nodeId }) => guard(async () => json(await client.samples(nodeId))),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
