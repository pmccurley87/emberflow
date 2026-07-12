import { getByPath } from '../engine';
import type { NodeRegistry } from '../engine';

/** A single Conditional rule row: `{ name, op, value? }`. */
interface ConditionalRule {
  name?: unknown;
  op?: unknown;
  value?: unknown;
}

const CONDITIONAL_OPS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists', 'truthy',
]);

/**
 * Only numbers and non-empty numeric strings take part in numeric coercion —
 * Number(null), Number(''), and Number([]) are all 0, which would make
 * `eq 0` match null/''/[] and `gt -1` match null.
 */
function asComparableNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/** eq/neq base: strict equality, plus numeric-looking equality (`Number()` on both sides). */
function looksEqual(input: unknown, comparand: unknown): boolean {
  if (input === comparand) return true;
  const a = asComparableNumber(input);
  const b = asComparableNumber(comparand);
  return !Number.isNaN(a) && !Number.isNaN(b) && a === b;
}

function numericMatch(op: 'gt' | 'gte' | 'lt' | 'lte', input: unknown, comparand: unknown): boolean {
  const a = asComparableNumber(input);
  const b = asComparableNumber(comparand);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  switch (op) {
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
  }
}

function ruleMatches(op: string, input: unknown, comparand: unknown): boolean {
  switch (op) {
    case 'eq': return looksEqual(input, comparand);
    case 'neq': return !looksEqual(input, comparand);
    case 'gt': case 'gte': case 'lt': case 'lte':
      return numericMatch(op, input, comparand);
    case 'contains':
      if (typeof input === 'string') return input.includes(String(comparand));
      if (Array.isArray(input)) return input.includes(comparand);
      return false;
    case 'exists':
      return input !== undefined && input !== null;
    case 'truthy':
      return Boolean(input);
    default:
      return false;
  }
}

/**
 * Flow-control nodes. Route reads a field from its input object and emits
 * `$branch`; the executor then skips downstream nodes hanging off untaken
 * branch handles (edge.sourceHandle = branch name).
 */
export function registerFlowControlNodes(registry: NodeRegistry): void {
  registry.register(
    {
      type: 'Input',
      label: 'Input',
      description:
        'Entry point — emits the payload the run was invoked with (falling back to configured defaults).',
      simpleDescription: 'Starts the run with its input data',
      category: 'input',
      traceKind: 'compute',
      tags: ['entry'],
      configSchema: {
        fields: [
          { name: 'fields', type: 'array' },
          { name: 'defaults', type: 'object' },
        ],
      },
      // Dynamic — the emitted shape depends on the configured fields.
      outputSchema: { fields: [] },
    },
    async (ctx) => {
      const merged = {
        ...((ctx.config.defaults as Record<string, unknown>) ?? {}),
        ...ctx.runInput,
      };
      const declared = Array.isArray(ctx.config.fields)
        ? (ctx.config.fields as { name: string; required?: boolean }[])
        : [];
      const missing = declared
        .filter((f) => f.required && merged[f.name] === undefined)
        .map((f) => f.name);
      if (missing.length) {
        throw new Error(`Missing required input field(s): ${missing.join(', ')}`);
      }
      const summary = JSON.stringify(merged);
      // Full JSON, untruncated: the log UI renders parseable payloads as
      // collapsible highlighted blocks — a sliced tail breaks the parse and
      // regresses to a wall of escaped text.
      ctx.log('info', `Run input: ${summary}`);
      return merged;
    },
  );

  registry.register(
    {
      type: 'Environment',
      label: 'Environment',
      description:
        'Reports the environment this run targets. Emits `environment` (the run\'s target environment name, e.g. "prod"; "local" when the run carries none) and `isProd` (a convenience boolean, true only when environment === "prod"). PORT NOTE: the name comes from the run\'s target environment threaded through node ctx (ctx.environment) — it is undefined for browser/in-tab runs, which report "local". `isProd` exists so the common case (branch on "is this production?") is a one-field Conditional; branch on `environment` directly for finer-grained routing.',
      simpleDescription: 'Reports which environment this run targets, so steps can branch on it.',
      category: 'logic',
      traceKind: 'compute',
      tags: ['branching'],
      // No inputs — the environment is read from the run context.
      inputSchema: { fields: [] },
      outputSchema: {
        fields: [
          { name: 'environment', type: 'string' },
          { name: 'isProd', type: 'boolean' },
        ],
      },
    },
    async (ctx) => {
      const environment = ctx.environment ?? 'local';
      const isProd = environment === 'prod';
      ctx.log('info', `Environment: ${environment} (isProd=${isProd})`);
      return { environment, isProd };
    },
  );

  registry.register(
    {
      type: 'Route',
      label: 'Route',
      description:
        'Branches the flow on a field of its input. Edges leaving a named branch handle only run when that branch matches.',
      simpleDescription: 'Sends the data down a different path based on one value',
      category: 'logic',
      traceKind: 'compute',
      tags: ['branching'],
      inputSchema: {
        fields: [{ name: 'value', type: 'object', required: true }],
      },
      configSchema: {
        fields: [
          { name: 'field', type: 'string', required: true },
          { name: 'branches', type: 'array', required: true },
          { name: 'fallback', type: 'string' },
        ],
      },
      outputSchema: {
        fields: [{ name: '$branch', type: 'string' }],
      },
    },
    async (ctx) => {
      const value = (ctx.input.value ?? {}) as Record<string, unknown>;
      const field = String(ctx.config.field ?? '');
      const branches = Array.isArray(ctx.config.branches)
        ? (ctx.config.branches as unknown[]).map(String)
        : [];
      const raw = getByPath(value, field);
      const candidate = String(raw);
      let branch: string | undefined = branches.includes(candidate) ? candidate : undefined;
      if (branch === undefined && typeof ctx.config.fallback === 'string' && ctx.config.fallback) {
        branch = ctx.config.fallback;
      }
      if (branch === undefined) {
        throw new Error(
          `Route: "${field}" resolved to "${candidate}", which matches no branch and no fallback is set`,
        );
      }
      ctx.log('info', `Routing ${field}=${candidate} → branch "${branch}"`);
      return { ...value, $branch: branch };
    },
  );

  registry.register(
    {
      type: 'Conditional',
      label: 'Conditional',
      description:
        'Branches the flow on an ordered set of rules evaluated against its input. The first matching rule wins; edges leaving a named branch handle only run when that branch matches.',
      simpleDescription: 'Chooses a path based on the data',
      category: 'logic',
      traceKind: 'compute',
      tags: ['branching'],
      inputSchema: {
        fields: [{ name: 'value', type: 'object', required: true }],
      },
      configSchema: {
        fields: [
          { name: 'branches', type: 'array', required: true },
          { name: 'fallback', type: 'string' },
        ],
      },
      outputSchema: {
        fields: [{ name: '$branch', type: 'string' }],
      },
    },
    async (ctx) => {
      const value = ctx.input.value;
      const rules = Array.isArray(ctx.config.branches) ? (ctx.config.branches as unknown[]) : [];
      let branch: string | undefined;
      for (const raw of rules) {
        const rule = (raw !== null && typeof raw === 'object' ? raw : {}) as ConditionalRule;
        const name = typeof rule.name === 'string' && rule.name ? rule.name : undefined;
        const op = typeof rule.op === 'string' ? rule.op : undefined;
        if (!name || !op || !CONDITIONAL_OPS.has(op)) {
          ctx.log('warn', `Conditional: skipping malformed rule ${JSON.stringify(raw)}`);
          continue;
        }
        if (ruleMatches(op, value, rule.value)) {
          branch = name;
          break;
        }
      }
      if (branch === undefined && typeof ctx.config.fallback === 'string' && ctx.config.fallback) {
        branch = ctx.config.fallback;
      }
      if (branch === undefined) {
        throw new Error('Conditional: no rule matched and no fallback is set');
      }
      ctx.log('info', `Conditional matched → branch "${branch}"`);
      return { value, $branch: branch };
    },
  );

  registry.register(
    {
      type: 'Merge',
      label: 'Merge',
      description:
        'Coalesces converging branch arms into one value: emits `value` = the first of its mapped inputs that is neither undefined nor null, in inputMap declaration order. PORT NOTE: the engine leaves an inputMap field undefined when its source node was skipped (an untaken branch arm), so wiring one input per arm makes `value` resolve to whichever arm actually ran. Use it as the join point after a Conditional whose arms each produce the same downstream value from a DIFFERENT node.',
      simpleDescription: 'Joins branch paths — passes on whichever arm produced a value.',
      category: 'logic',
      traceKind: 'compute',
      tags: ['branching'],
      // Free-form: the converging arm values are supplied via inputMap, one
      // field per arm; declaration order sets coalesce priority.
      inputSchema: { fields: [] },
      outputSchema: {
        fields: [{ name: 'value', type: 'object' }],
      },
    },
    async (ctx) => {
      const entries = Object.entries(ctx.input);
      const chosen = entries.find(([, v]) => v !== undefined && v !== null);
      if (!chosen) {
        ctx.log('warn', 'Merge: no incoming arm produced a value');
        return { value: undefined };
      }
      ctx.log('info', `Merge: passing on value from "${chosen[0]}"`);
      return { value: chosen[1] };
    },
  );

  registry.register(
    {
      type: 'Subflow',
      label: 'Subflow',
      description:
        'Runs another workflow to completion with the mapped input, then emits that child run\'s collected output.',
      simpleDescription: 'Runs another workflow and uses its result',
      category: 'logic',
      traceKind: 'compute',
      tags: ['subflow'],
      // Free-form input: whatever is mapped onto this node becomes the child
      // run's invocation payload (like an Input node's run input).
      inputSchema: { fields: [] },
      configSchema: {
        fields: [{ name: 'workflowId', type: 'string', required: true }],
      },
      // Dynamic — the emitted shape is the child flow's Result output.
      outputSchema: { fields: [] },
    },
    async (ctx) => {
      const workflowId = String(ctx.config.workflowId ?? '');
      if (!workflowId) throw new Error('Subflow: no workflowId configured');
      if (!ctx.runSubflow) {
        throw new Error('subflows need a host that can look up workflows');
      }
      ctx.log('info', `Running subflow "${workflowId}"`);
      const result = await ctx.runSubflow(workflowId, ctx.input);
      if (result.status === 'failed') {
        throw new Error(result.error ?? 'subflow failed');
      }
      const output = result.output;
      // Spread a plain object so downstream nodes can map its fields directly;
      // wrap anything else under `output`.
      if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
        return { ...(output as Record<string, unknown>) };
      }
      return { output };
    },
  );
}
