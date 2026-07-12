import { describe, expect, it } from 'vitest';
import { NodeRegistry } from './registry';
import { hashImplementation, isArtifact, publishFlow, verifyArtifact } from './publish';
import type { NodeImplementation, WorkflowDefinition, WorkflowNode } from './types';

// Two genuinely different Task implementation *sources* — closure capture does
// not change impl.toString(), so distinct function bodies are what shifts the
// hash. Keyed by a marker so tests can pick a build.
const taskImpls: Record<string, NodeImplementation> = {
  a: async () => ({ result: 'a' }),
  different: async () => {
    const doubled = 2 + 2;
    return { result: 'different', doubled };
  },
};

/** A registry whose `Task` implementation body is chosen by `marker`. */
function makeRegistry(marker: keyof typeof taskImpls): NodeRegistry {
  const registry = new NodeRegistry();
  registry.register(
    { type: 'Input', label: 'Input', category: 'input' },
    async (ctx) => ({ ...ctx.runInput }),
  );
  registry.register({ type: 'Task', label: 'Task' }, taskImpls[marker]);
  return registry;
}

const node = (id: string, type: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id, type, label: id, position: { x: 0, y: 0 }, config: {}, ...extra,
});

function makeFlow(nodes: WorkflowNode[], edges: WorkflowDefinition['edges'] = []): WorkflowDefinition {
  return {
    id: 'f', name: 'f', version: 1, nodes, edges,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

const loginish = (): WorkflowDefinition =>
  makeFlow(
    [
      node('input', 'Input', {
        config: {
          fields: [
            { name: 'username', type: 'string', required: true },
            { name: 'password', type: 'string', required: true },
          ],
          defaults: { username: 'ada' },
        },
      }),
      node('task', 'Task'),
    ],
    [{ id: 'e1', source: 'input', target: 'task' }],
  );

describe('publishFlow', () => {
  it('strips metadata.pinnedOutput from every node (dropping empty metadata)', async () => {
    const flow = makeFlow([
      node('input', 'Input'),
      node('task', 'Task', { metadata: { pinnedOutput: { marker: 'pinned' }, note: 'keep' } }),
    ]);
    const artifact = await publishFlow(flow, makeRegistry('a'), () => '2026-07-02T00:00:00Z');

    const task = artifact.flow.nodes.find((n) => n.id === 'task')!;
    expect(task.metadata).toEqual({ note: 'keep' });
    // Node whose metadata becomes empty loses the key entirely.
    const inputNode = artifact.flow.nodes.find((n) => n.id === 'input')!;
    expect(inputNode.metadata).toBeUndefined();
    // Source flow is untouched (deep copy).
    expect(flow.nodes.find((n) => n.id === 'task')!.metadata).toHaveProperty('pinnedOutput');
  });

  it('drops metadata when pinnedOutput was its only key', async () => {
    const flow = makeFlow([
      node('input', 'Input'),
      node('task', 'Task', { metadata: { pinnedOutput: 42 } }),
    ]);
    const artifact = await publishFlow(flow, makeRegistry('a'));
    expect(artifact.flow.nodes.find((n) => n.id === 'task')!.metadata).toBeUndefined();
  });

  it('lifts the input schema from the Input node config.fields', async () => {
    const artifact = await publishFlow(loginish(), makeRegistry('a'));
    expect(artifact.inputSchema).toEqual([
      { name: 'username', type: 'string', required: true },
      { name: 'password', type: 'string', required: true },
    ]);
  });

  it('uses [] when there is no Input node', async () => {
    const flow = makeFlow([node('task', 'Task')]);
    const artifact = await publishFlow(flow, makeRegistry('a'));
    expect(artifact.inputSchema).toEqual([]);
  });

  it('ignores malformed field entries when lifting the schema', async () => {
    const flow = makeFlow([
      node('input', 'Input', { config: { fields: [{ name: 'ok', type: 'string' }, { type: 'string' }, 'nope'] } }),
    ]);
    const artifact = await publishFlow(flow, makeRegistry('a'));
    expect(artifact.inputSchema).toEqual([{ name: 'ok', type: 'string' }]);
  });

  it('produces the emberflow/v1 envelope with a publishedAt from now()', async () => {
    const artifact = await publishFlow(loginish(), makeRegistry('a'), () => '2026-07-02T12:00:00Z');
    expect(artifact.$artifact).toBe('emberflow/v1');
    expect(artifact.publishedAt).toBe('2026-07-02T12:00:00Z');
    expect(Object.keys(artifact.nodeHashes).sort()).toEqual(['Input', 'Task']);
  });

  it('hashes are stable for the same registry and change for a different implementation', async () => {
    const a1 = await publishFlow(loginish(), makeRegistry('a'));
    const a2 = await publishFlow(loginish(), makeRegistry('a'));
    const b = await publishFlow(loginish(), makeRegistry('different'));
    expect(a1.nodeHashes.Task).toBe(a2.nodeHashes.Task);
    expect(a1.nodeHashes.Task).not.toBe(b.nodeHashes.Task);
    // The Input node is identical across registries.
    expect(a1.nodeHashes.Input).toBe(b.nodeHashes.Input);
  });

  it('strips scenarios on publish without mutating the source flow', async () => {
    const flow = loginish();
    flow.scenarios = [{ id: 's1', name: 'Happy path', input: { username: 'ada', password: 'x' } }];
    const artifact = await publishFlow(flow, makeRegistry('a'));
    expect(artifact.flow.scenarios).toBeUndefined();
    expect(flow.scenarios).toEqual([
      { id: 's1', name: 'Happy path', input: { username: 'ada', password: 'x' } },
    ]);
  });

  it('throws on an invalid flow', async () => {
    const flow = makeFlow([node('ghost', 'Nonexistent')]);
    await expect(publishFlow(flow, makeRegistry('a'))).rejects.toThrow(/Cannot publish/);
  });
});

describe('verifyArtifact', () => {
  it('returns [] when the registry matches', async () => {
    const artifact = await publishFlow(loginish(), makeRegistry('a'));
    expect(await verifyArtifact(artifact, makeRegistry('a'))).toEqual([]);
  });

  it('names the drifted type on an implementation mismatch', async () => {
    const artifact = await publishFlow(loginish(), makeRegistry('a'));
    expect(await verifyArtifact(artifact, makeRegistry('different'))).toEqual(['Task']);
  });

  it('names unknown types missing from the registry', async () => {
    const artifact = await publishFlow(loginish(), makeRegistry('a'));
    const bare = new NodeRegistry();
    // Same Input body as makeRegistry, but Task is absent entirely.
    bare.register({ type: 'Input', label: 'Input' }, async (ctx) => ({ ...ctx.runInput }));
    expect(await verifyArtifact(artifact, bare)).toEqual(['Task']);
  });
});

describe('isArtifact', () => {
  it('accepts a published artifact', async () => {
    const artifact = await publishFlow(loginish(), makeRegistry('a'));
    expect(isArtifact(artifact)).toBe(true);
  });

  it('rejects plain flows and junk', () => {
    expect(isArtifact(loginish())).toBe(false);
    expect(isArtifact(null)).toBe(false);
    expect(isArtifact({ $artifact: 'other' })).toBe(false);
    expect(isArtifact(42)).toBe(false);
  });
});

describe('hashImplementation', () => {
  it('is a 64-char lowercase hex string', async () => {
    const hash = await hashImplementation(async () => ({}));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
