import { describe, expect, it } from 'vitest';
import { diagnoseOperation } from './diagnostics';
import type { ScenarioDefinition, WorkflowDefinition, WorkflowNode } from './types';

function inputNode(config: Record<string, unknown> = {}): WorkflowNode {
  return { id: 'input', type: 'Input', label: 'Input', position: { x: 0, y: 0 }, config };
}

function flow(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'f1',
    name: 'Flow',
    version: 1,
    nodes: [],
    edges: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function scenario(over: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    id: 's1',
    name: 'Scenario',
    input: {},
    ...over,
  };
}

describe('diagnoseOperation — missing-param-default', () => {
  it('emits one warning per path param missing a default, in path order', () => {
    const f = flow({
      http: { method: 'GET', path: '/api/channels/:id/approvals/:approvalId' },
      nodes: [inputNode()],
    });
    const diags = diagnoseOperation(f, undefined).filter((d) => d.code === 'missing-param-default');
    expect(diags).toHaveLength(2);
    expect(diags[0]).toMatchObject({ severity: 'warning', code: 'missing-param-default', param: 'id' });
    expect(diags[1]).toMatchObject({ severity: 'warning', code: 'missing-param-default', param: 'approvalId' });
    for (const d of diags) {
      expect(d.message.length).toBeGreaterThan(0);
      expect(d.message).toContain('Add');
    }
  });

  it('emits only for the un-defaulted param when defaults are partial', () => {
    const f = flow({
      http: { method: 'GET', path: '/api/channels/:id/approvals/:approvalId' },
      nodes: [inputNode({ defaults: { params: { id: 'c1' } } })],
    });
    const diags = diagnoseOperation(f, undefined).filter((d) => d.code === 'missing-param-default');
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: 'missing-param-default', param: 'approvalId' });
  });

  it('does not emit when the default is an empty string — presence, not meaningfulness', () => {
    const f = flow({
      http: { method: 'GET', path: '/api/channels/:id' },
      nodes: [inputNode({ defaults: { params: { id: '' } } })],
    });
    const diags = diagnoseOperation(f, undefined).filter((d) => d.code === 'missing-param-default');
    expect(diags).toEqual([]);
  });

  it('does not emit when there is no Input node — nothing consumes params', () => {
    const f = flow({
      http: { method: 'GET', path: '/api/channels/:id' },
      nodes: [],
    });
    const diags = diagnoseOperation(f, undefined).filter((d) => d.code === 'missing-param-default');
    expect(diags).toEqual([]);
  });

  it('does not emit when the flow has no http trigger', () => {
    const f = flow({ nodes: [inputNode()] });
    const diags = diagnoseOperation(f, undefined).filter((d) => d.code === 'missing-param-default');
    expect(diags).toEqual([]);
  });

  it('does not emit when the http path has no params', () => {
    const f = flow({ http: { method: 'GET', path: '/api/channels' }, nodes: [inputNode()] });
    const diags = diagnoseOperation(f, undefined).filter((d) => d.code === 'missing-param-default');
    expect(diags).toEqual([]);
  });
});

describe('diagnoseOperation — param-no-real-scenario', () => {
  it('emits info for a param when no scenario supplies a non-empty value', () => {
    const f = flow({
      http: { method: 'GET', path: '/api/channels/:id' },
      nodes: [inputNode({ defaults: { params: { id: 'c1' } } })],
    });
    const diags = diagnoseOperation(f, undefined).filter((d) => d.code === 'param-no-real-scenario');
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: 'info', code: 'param-no-real-scenario', param: 'id' });
    expect(diags[0].message.length).toBeGreaterThan(0);
    expect(diags[0].message).toContain('scenario');
  });

  it('is silenced by a scenario with a non-empty input.params value', () => {
    const f = flow({
      http: { method: 'GET', path: '/api/channels/:id' },
      nodes: [inputNode({ defaults: { params: { id: 'c1' } } })],
    });
    const scenarios = [scenario({ input: { params: { id: 'real-id' } } })];
    const diags = diagnoseOperation(f, scenarios).filter((d) => d.code === 'param-no-real-scenario');
    expect(diags).toEqual([]);
  });

  it('is not silenced by a scenario with an empty-string value', () => {
    const f = flow({
      http: { method: 'GET', path: '/api/channels/:id' },
      nodes: [inputNode({ defaults: { params: { id: 'c1' } } })],
    });
    const scenarios = [scenario({ input: { params: { id: '' } } })];
    const diags = diagnoseOperation(f, scenarios).filter((d) => d.code === 'param-no-real-scenario');
    expect(diags).toHaveLength(1);
  });

  it('is not silenced by a scenario missing the param entirely', () => {
    const f = flow({
      http: { method: 'GET', path: '/api/channels/:id' },
      nodes: [inputNode({ defaults: { params: { id: 'c1' } } })],
    });
    const scenarios = [scenario({ input: {} })];
    const diags = diagnoseOperation(f, scenarios).filter((d) => d.code === 'param-no-real-scenario');
    expect(diags).toHaveLength(1);
  });

  it('does not emit when there is no Input node', () => {
    const f = flow({ http: { method: 'GET', path: '/api/channels/:id' }, nodes: [] });
    const diags = diagnoseOperation(f, undefined).filter((d) => d.code === 'param-no-real-scenario');
    expect(diags).toEqual([]);
  });
});

describe('diagnoseOperation — no-expects', () => {
  it('emits info when there are zero scenarios', () => {
    const f = flow();
    const diags = diagnoseOperation(f, undefined).filter((d) => d.code === 'no-expects');
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: 'info', code: 'no-expects' });
    expect(diags[0].message.length).toBeGreaterThan(0);
    expect(diags[0].message).toContain('expect');
  });

  it('emits info when scenarios exist but none carry an expect', () => {
    const f = flow();
    const scenarios = [scenario({ expect: undefined }), scenario({ id: 's2', name: 'S2' })];
    const diags = diagnoseOperation(f, scenarios).filter((d) => d.code === 'no-expects');
    expect(diags).toHaveLength(1);
  });

  it('is silenced when at least one scenario carries an expect', () => {
    const f = flow();
    const scenarios = [scenario({ expect: { status: 200 } })];
    const diags = diagnoseOperation(f, scenarios).filter((d) => d.code === 'no-expects');
    expect(diags).toEqual([]);
  });

  it('is emitted regardless of whether the flow has an http trigger', () => {
    const f = flow({ http: { method: 'GET', path: '/api/x' } });
    const diags = diagnoseOperation(f, undefined).filter((d) => d.code === 'no-expects');
    expect(diags).toHaveLength(1);
  });
});

describe('diagnoseOperation — ordering', () => {
  it('orders all missing-param-default first (path order), then param-no-real-scenario (path order), then no-expects', () => {
    const f = flow({
      http: { method: 'GET', path: '/api/channels/:id/approvals/:approvalId' },
      nodes: [inputNode()],
    });
    const diags = diagnoseOperation(f, undefined);
    expect(diags.map((d) => [d.code, d.param])).toEqual([
      ['missing-param-default', 'id'],
      ['missing-param-default', 'approvalId'],
      ['param-no-real-scenario', 'id'],
      ['param-no-real-scenario', 'approvalId'],
      ['no-expects', undefined],
    ]);
  });

  it('appends missing-node-mock after every other code', () => {
    const f = flow({
      nodes: [{ id: 'db1', type: 'Query', label: 'Query', position: { x: 0, y: 0 }, config: {} }],
    });
    const diags = diagnoseOperation(f, [scenario({ expect: { status: 200 } })], {
      infraNodes: [{ id: 'db1', traceKind: 'db' }],
    });
    expect(diags.map((d) => d.code)).toEqual(['missing-node-mock']);
  });
});

describe('diagnoseOperation — missing-node-mock', () => {
  function dbNode(id = 'db1', label = 'Fetch Users'): WorkflowNode {
    return { id, type: 'Query', label, position: { x: 0, y: 0 }, config: {} };
  }

  const covered = [scenario({ expect: { status: 200 } })];

  it('emits info per uncovered infra node, with the binding message copy', () => {
    const f = flow({ nodes: [dbNode()] });
    const diags = diagnoseOperation(f, covered, { infraNodes: [{ id: 'db1', traceKind: 'db' }] });
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: 'info', code: 'missing-node-mock', nodeId: 'db1' });
    expect(diags[0].message).toBe(
      '"Fetch Users" touches infrastructure (db) but has no mock — plain (no-scenario) Mock runs will fail at it. ' +
        'Cover with AI writes mocks, or add one under "mocks" in the scenarios file.',
    );
  });

  it('emits one diagnostic per uncovered infra node', () => {
    const f = flow({ nodes: [dbNode('db1', 'A'), dbNode('db2', 'B')] });
    const diags = diagnoseOperation(f, covered, {
      infraNodes: [
        { id: 'db1', traceKind: 'db' },
        { id: 'db2', traceKind: 'http' },
      ],
    });
    expect(diags.map((d) => d.nodeId)).toEqual(['db1', 'db2']);
  });

  it('is silenced by an op-level flow.mocks entry for that nodeId', () => {
    const f = flow({ nodes: [dbNode()], mocks: { db1: { rows: [] } } });
    const diags = diagnoseOperation(f, covered, { infraNodes: [{ id: 'db1', traceKind: 'db' }] });
    expect(diags).toEqual([]);
  });

  it('prefers extras.opMocks over flow.mocks when both are present', () => {
    const f = flow({ nodes: [dbNode()], mocks: {} });
    const diags = diagnoseOperation(f, covered, {
      infraNodes: [{ id: 'db1', traceKind: 'db' }],
      opMocks: { db1: { rows: [] } },
    });
    expect(diags).toEqual([]);
  });

  it('is not emitted when extras is absent, even with an infra-shaped node', () => {
    const f = flow({ nodes: [dbNode()] });
    const diags = diagnoseOperation(f, covered);
    expect(diags.filter((d) => d.code === 'missing-node-mock')).toEqual([]);
  });

  it('is not emitted when extras.infraNodes is present but empty', () => {
    const f = flow({ nodes: [dbNode()] });
    const diags = diagnoseOperation(f, covered, { infraNodes: [] });
    expect(diags.filter((d) => d.code === 'missing-node-mock')).toEqual([]);
  });
});

describe('diagnoseOperation — simulated-commit', () => {
  const covered = [scenario({ expect: { status: 200 } })];

  function mutationNode(id: string, type = 'CreateRecord', label = 'Create Record'): WorkflowNode {
    return { id, type, label, position: { x: 0, y: 0 }, config: {} };
  }

  it('warns when a mutation node has a [SIMULATED] marker in its impl source', () => {
    const f = flow({ nodes: [mutationNode('m1')] });
    const source = 'async function CreateRecord(ctx) { if (commit) { console.log("[SIMULATED] write"); return { ok: true }; } }';
    const diags = diagnoseOperation(f, covered, { mutationSourcesByNode: { m1: source } }).filter(
      (d) => d.code === 'simulated-commit',
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: 'warning', code: 'simulated-commit', nodeId: 'm1' });
    expect(diags[0].message).toContain('m1');
    expect(diags[0].message).toContain('CreateRecord');
  });

  it('does not warn when the mutation node impl source is clean', () => {
    const f = flow({ nodes: [mutationNode('m1')] });
    const source = 'async function CreateRecord(ctx) { return db.insert(ctx.params); }';
    const diags = diagnoseOperation(f, covered, { mutationSourcesByNode: { m1: source } }).filter(
      (d) => d.code === 'simulated-commit',
    );
    expect(diags).toEqual([]);
  });

  it('does not warn for a non-mutation node even if its source contains [SIMULATED] (effects gate is the caller\'s job — absence from the map means it was gated out)', () => {
    const f = flow({ nodes: [mutationNode('c1', 'ComputeStub', 'Compute')] });
    // A compute node's source is never placed in mutationSourcesByNode by a
    // well-behaved caller (effects !== 'mutation'), so it's simply absent here.
    const diags = diagnoseOperation(f, covered, { mutationSourcesByNode: {} }).filter(
      (d) => d.code === 'simulated-commit',
    );
    expect(diags).toEqual([]);
  });

  it('does not warn for an unregistered node type — absent from the map, no crash', () => {
    const f = flow({ nodes: [mutationNode('u1', 'UnknownType')] });
    const diags = diagnoseOperation(f, covered, { mutationSourcesByNode: {} }).filter(
      (d) => d.code === 'simulated-commit',
    );
    expect(diags).toEqual([]);
  });

  it('is not emitted when extras is absent', () => {
    const f = flow({ nodes: [mutationNode('m1')] });
    const diags = diagnoseOperation(f, covered).filter((d) => d.code === 'simulated-commit');
    expect(diags).toEqual([]);
  });

  it('flags each node instance separately — no dedupe per type', () => {
    const f = flow({ nodes: [mutationNode('m1'), mutationNode('m2')] });
    const source = 'function CreateRecord() { return "[SIMULATED] ok"; }';
    const diags = diagnoseOperation(f, covered, {
      mutationSourcesByNode: { m1: source, m2: source },
    }).filter((d) => d.code === 'simulated-commit');
    expect(diags.map((d) => d.nodeId)).toEqual(['m1', 'm2']);
  });
});

describe('diagnoseOperation — inputmap-schema-mismatch', () => {
  const covered = [scenario({ expect: { status: 200 } })];

  function node(id: string, over: Partial<WorkflowNode> = {}): WorkflowNode {
    return { id, type: 'X', label: id, position: { x: 0, y: 0 }, config: {}, ...over };
  }

  it('warns when an inputMap reads a field the source node never declares', () => {
    const f = flow({
      nodes: [
        node('src'),
        node('dst', { inputMap: { trends: { sourceNodeId: 'src', sourceField: 'trend' } } }),
      ],
    });
    const diags = diagnoseOperation(f, covered, { outputFieldsByNode: { src: ['trendRows', 'rCV'] } }).filter(
      (d) => d.code === 'inputmap-schema-mismatch',
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: 'warning', code: 'inputmap-schema-mismatch', nodeId: 'dst', param: 'trends' });
    expect(diags[0].message).toContain('trend');
    expect(diags[0].message).toContain('src');
  });

  it('checks only the FIRST dotted segment', () => {
    const f = flow({
      nodes: [
        node('src'),
        node('dst', { inputMap: { v: { sourceNodeId: 'src', sourceField: 'signals.0.signalId' } } }),
      ],
    });
    const ok = diagnoseOperation(f, covered, { outputFieldsByNode: { src: ['signals'] } }).filter(
      (d) => d.code === 'inputmap-schema-mismatch',
    );
    expect(ok).toEqual([]);
    const bad = diagnoseOperation(f, covered, { outputFieldsByNode: { src: ['items'] } }).filter(
      (d) => d.code === 'inputmap-schema-mismatch',
    );
    expect(bad).toHaveLength(1);
  });

  it('ignores a "$" whole-output sourceField (and a leading $.)', () => {
    const f = flow({
      nodes: [
        node('src'),
        node('a', { inputMap: { v: { sourceNodeId: 'src', sourceField: '$' } } }),
        node('b', { inputMap: { v: { sourceNodeId: 'src', sourceField: '$.foo' } } }),
      ],
    });
    // '$' → skip; '$.foo' → first real segment is 'foo', not declared → warn once.
    const diags = diagnoseOperation(f, covered, { outputFieldsByNode: { src: ['bar'] } }).filter(
      (d) => d.code === 'inputmap-schema-mismatch',
    );
    expect(diags.map((d) => d.nodeId)).toEqual(['b']);
  });

  it('does not fire for a source node absent from outputFieldsByNode (unregistered or no declared fields)', () => {
    const f = flow({
      nodes: [
        node('src'),
        node('dst', { inputMap: { v: { sourceNodeId: 'src', sourceField: 'anything' } } }),
      ],
    });
    // Input/Subflow convention: no entry → never flagged.
    const diags = diagnoseOperation(f, covered, { outputFieldsByNode: {} }).filter(
      (d) => d.code === 'inputmap-schema-mismatch',
    );
    expect(diags).toEqual([]);
  });

  it('does not fire at all when extras.outputFieldsByNode is omitted', () => {
    const f = flow({
      nodes: [
        node('src'),
        node('dst', { inputMap: { v: { sourceNodeId: 'src', sourceField: 'nope' } } }),
      ],
    });
    const diags = diagnoseOperation(f, covered).filter((d) => d.code === 'inputmap-schema-mismatch');
    expect(diags).toEqual([]);
  });
});

describe('diagnoseOperation — language-drift', () => {
  const covered = [scenario({ expect: { status: 200 } })];

  it('warns (info) when extras carries an explicit javascript language against a .ts config', () => {
    const f = flow();
    const diags = diagnoseOperation(f, covered, {
      languageDrift: { projectLanguage: 'javascript', configPathExtension: '.ts' },
    }).filter((d) => d.code === 'language-drift');
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: 'info', code: 'language-drift' });
    expect(diags[0].message).toContain('javascript');
    expect(diags[0].message).toContain('.ts');
  });

  it('warns (info) when extras carries an explicit typescript language against a .mjs config', () => {
    const f = flow();
    const diags = diagnoseOperation(f, covered, {
      languageDrift: { projectLanguage: 'typescript', configPathExtension: '.mjs' },
    }).filter((d) => d.code === 'language-drift');
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: 'info', code: 'language-drift' });
    expect(diags[0].message).toContain('typescript');
    expect(diags[0].message).toContain('.mjs');
  });

  it('is not emitted when extras.languageDrift is absent — inference agrees by construction', () => {
    const f = flow();
    const diags = diagnoseOperation(f, covered).filter((d) => d.code === 'language-drift');
    expect(diags).toEqual([]);
  });

  it('is appended after every other code', () => {
    const f = flow({
      http: { method: 'GET', path: '/api/x/:id' },
      nodes: [inputNode()],
    });
    const diags = diagnoseOperation(f, undefined, {
      languageDrift: { projectLanguage: 'javascript', configPathExtension: '.ts' },
    });
    expect(diags[diags.length - 1].code).toBe('language-drift');
  });
});
