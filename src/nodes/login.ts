import { NodeRegistry } from '../engine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Strip the `user-` prefix from a userId to get the username part. */
function usernamePart(userId: string): string {
  return userId.startsWith('user-') ? userId.slice('user-'.length) : userId;
}

/**
 * Build a NodeRegistry populated with the five login example nodes.
 * `delayMs` is injected into every implementation via `await sleep(delayMs)`
 * so tests can run with no delay by passing `0`.
 */
export function createLoginRegistry(
  delayMs = 300,
  opts?: { captureSourceRefs?: boolean },
): NodeRegistry {
  const registry = new NodeRegistry(opts);

  registry.register(
    {
      type: 'ValidateCredentials',
      label: 'Validate Credentials',
      description: 'Validates a username and password.',
      category: 'auth',
      traceKind: 'compute',
      inputSchema: {
        fields: [
          { name: 'username', type: 'string', required: true },
          { name: 'password', type: 'string', required: true },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'userId', type: 'string' },
          { name: 'username', type: 'string' },
        ],
      },
    },
    async (ctx) => {
      await sleep(delayMs);
      const username = String(ctx.input.username ?? '');
      const password = String(ctx.input.password ?? '');
      if (password.length < 4) {
        throw new Error('Password too short');
      }
      ctx.log('info', `Credentials accepted for ${username}`);
      return { userId: `user-${username}`, username };
    },
  );

  registry.register(
    {
      type: 'FetchUser',
      label: 'Fetch User',
      description: 'Fetches a user record derived from a userId.',
      category: 'data',
      traceKind: 'compute',
      inputSchema: {
        fields: [{ name: 'userId', type: 'string', required: true }],
      },
      outputSchema: {
        fields: [
          { name: 'id', type: 'string' },
          { name: 'name', type: 'string' },
          { name: 'plan', type: 'enum', enumValues: ['free', 'pro'] },
          { name: 'isNew', type: 'boolean' },
        ],
      },
    },
    async (ctx) => {
      await sleep(delayMs);
      const userId = String(ctx.input.userId ?? '');
      const name = usernamePart(userId);
      const plan = name.includes('pro') ? 'pro' : 'free';
      const isNew = name.startsWith('new');
      ctx.log('info', `Fetched user ${name}: plan=${plan}, isNew=${isNew}`);
      return { id: userId, name, plan, isNew };
    },
  );

  registry.register(
    {
      type: 'CheckPlan',
      label: 'Check Plan',
      description: 'Resolves the feature set for a user plan.',
      category: 'logic',
      traceKind: 'compute',
      inputSchema: {
        fields: [{ name: 'user', type: 'object', required: true }],
      },
      outputSchema: {
        fields: [
          { name: 'plan', type: 'enum', enumValues: ['free', 'pro'] },
          { name: 'features', type: 'array' },
        ],
      },
    },
    async (ctx) => {
      await sleep(delayMs);
      const user = (ctx.input.user ?? {}) as { plan?: string };
      const plan = user.plan ?? 'free';
      const features = plan === 'pro' ? ['sso', 'audit-log', 'priority-support'] : ['basic'];
      ctx.log('info', `Plan ${plan} resolves to features: ${features.join(', ')}`);
      return { plan, features };
    },
  );

  registry.register(
    {
      type: 'WelcomeUser',
      label: 'Welcome User',
      description: 'Greets a freshly created user by name.',
      category: 'auth',
      traceKind: 'compute',
      inputSchema: {
        fields: [{ name: 'user', type: 'object', required: true }],
      },
      outputSchema: {
        fields: [
          { name: 'message', type: 'string' },
          { name: 'userId', type: 'string' },
        ],
      },
    },
    async (ctx) => {
      await sleep(delayMs);
      const user = (ctx.input.user ?? {}) as { id?: string; name?: string };
      const message = `Welcome aboard, ${user.name}!`;
      ctx.log('info', message);
      return { message, userId: user.id };
    },
  );

  registry.register(
    {
      type: 'IssueToken',
      label: 'Issue Token',
      description: 'Issues an access token for a userId.',
      category: 'auth',
      traceKind: 'compute',
      inputSchema: {
        fields: [
          { name: 'userId', type: 'string', required: true },
          { name: 'plan', type: 'enum', enumValues: ['free', 'pro'] },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'token', type: 'string' },
          { name: 'issuedTo', type: 'string' },
          { name: 'plan', type: 'string' },
        ],
      },
    },
    async (ctx) => {
      await sleep(delayMs);
      const userId = String(ctx.input.userId ?? '');
      const plan = String(ctx.input.plan ?? 'free');
      ctx.log('info', `Token issued for plan=${plan}`);
      return { token: `tok_${userId}`, issuedTo: userId, plan };
    },
  );

  registry.register(
    {
      type: 'Result',
      label: 'Result',
      description: 'Terminal node that passes its input through and displays it on the canvas.',
      category: 'output',
      traceKind: 'compute',
      tags: ['display'],
      inputSchema: {
        fields: [{ name: 'data', type: 'object' }],
      },
      outputSchema: {
        fields: [{ name: 'data', type: 'object' }],
      },
    },
    async (ctx) => {
      await sleep(delayMs);
      ctx.log('info', 'Result collected');
      return ctx.input;
    },
  );

  return registry;
}
