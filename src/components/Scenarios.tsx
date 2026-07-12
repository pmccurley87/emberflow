import { useEffect, useState } from 'react';
import { FlaskConicalIcon, Loader2Icon, PencilIcon, PlayIcon, PlusIcon, SparklesIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useBuilderStore } from '../store/builderStore';
import { cn } from '@/lib/utils';
import type {
  FieldDefinition, ScenarioDefinition, ScenarioExpectation, WorkflowDefinition,
} from '../engine';
import type { ScenarioTestResult } from '../store/serverRunner';

const statusDot: Record<string, string> = {
  succeeded: 'bg-success',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground',
  running: 'bg-highlight animate-pulse',
};

/** Compact single-line payload preview: {points: 30, spikeIndex: 25}. */
function previewPayload(input: Record<string, unknown>): string {
  const parts = Object.entries(input).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `{${parts.join(', ')}}`;
}

/** Starter payload from the Input node: defaults, plus blanks for declared fields. */
function seedPayload(flow: WorkflowDefinition): Record<string, unknown> {
  const inputNode = flow.nodes.find((n) => n.type === 'Input');
  if (!inputNode) return {};
  const fields = Array.isArray(inputNode.config.fields)
    ? (inputNode.config.fields as FieldDefinition[])
    : [];
  const defaults =
    inputNode.config.defaults && typeof inputNode.config.defaults === 'object'
      ? (inputNode.config.defaults as Record<string, unknown>)
      : {};
  const blank: Record<string, unknown> = {
    string: '', number: 0, boolean: false, object: {}, array: [], enum: '', datetime: '',
  };
  const seed: Record<string, unknown> = {};
  for (const f of fields) {
    seed[f.name] = f.name in defaults ? defaults[f.name] : (blank[f.type] ?? '');
  }
  return seed;
}

interface EditorState {
  /** Scenario id being edited, or 'new'. */
  target: string;
  name: string;
  description: string;
  payload: string;
  /** Expect fields, all as raw editor strings; empty = unset. */
  expectStatus: string;
  expectNodes: string;
  expectBody: string;
  error: string | null;
}

/** Editor strings → ScenarioExpectation (undefined when all empty), or an error. */
function buildExpect(state: EditorState): { expect?: ScenarioExpectation } | { error: string } {
  const expect: ScenarioExpectation = {};
  if (state.expectStatus.trim()) {
    const status = Number(state.expectStatus.trim());
    if (!Number.isInteger(status) || status <= 0) {
      return { error: 'Expected status must be a positive integer' };
    }
    expect.status = status;
  }
  const nodes = state.expectNodes.split(',').map((s) => s.trim()).filter(Boolean);
  if (nodes.length > 0) expect.executedNodes = nodes;
  if (state.expectBody.trim()) {
    try {
      expect.body = JSON.parse(state.expectBody) as unknown;
    } catch {
      return { error: 'Expected body must be valid JSON' };
    }
  }
  return Object.keys(expect).length > 0 ? { expect } : {};
}

/** Compact chip text for a scenario's expectation: "→ 401 · body · nodes". */
function expectChipText(expect: ScenarioExpectation): string {
  const parts: string[] = [];
  if (expect.status !== undefined) parts.push(String(expect.status));
  if (expect.body !== undefined) parts.push('body');
  if (expect.executedNodes?.length) parts.push('nodes');
  return `→ ${parts.join(' · ')}`;
}

function ScenarioEditor({
  state,
  onChange,
  onSave,
  onCancel,
}: {
  state: EditorState;
  onChange: (next: EditorState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-1 space-y-2 rounded-md border border-border bg-card/50 p-3">
      <div className="grid grid-cols-2 gap-2">
        <Input
          value={state.name}
          onChange={(e) => onChange({ ...state, name: e.target.value })}
          placeholder="Scenario name"
          autoFocus
        />
        <Input
          value={state.description}
          onChange={(e) => onChange({ ...state, description: e.target.value })}
          placeholder="What this scenario demonstrates (optional)"
        />
      </div>
      <textarea
        value={state.payload}
        onChange={(e) => onChange({ ...state, payload: e.target.value, error: null })}
        spellCheck={false}
        rows={5}
        className="w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-relaxed outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]"
      />
      <div className="space-y-1.5 rounded-md border border-border/60 bg-background/50 p-2.5">
        <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          Expect <span className="normal-case tracking-normal">(optional — makes this scenario a test for `emberflow test` and the Test all button)</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Input
            value={state.expectStatus}
            onChange={(e) => onChange({ ...state, expectStatus: e.target.value, error: null })}
            placeholder="status, e.g. 200"
            spellCheck={false}
            className="font-mono text-[12px]"
          />
          <Input
            value={state.expectNodes}
            onChange={(e) => onChange({ ...state, expectNodes: e.target.value, error: null })}
            placeholder="executed nodes, e.g. response-ok"
            spellCheck={false}
            className="font-mono text-[12px]"
          />
        </div>
        <textarea
          value={state.expectBody}
          onChange={(e) => onChange({ ...state, expectBody: e.target.value, error: null })}
          spellCheck={false}
          rows={2}
          placeholder='body subset, e.g. {"ok": true} — extra keys in the real response are fine'
          className="w-full resize-y rounded-md border border-border bg-background p-2.5 font-mono text-[11.5px] leading-relaxed outline-none placeholder:text-muted-foreground/50 focus-visible:ring-ring/50 focus-visible:ring-[3px]"
        />
      </div>
      {state.error && <div className="text-[12px] text-destructive">{state.error}</div>}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={state.name.trim().length === 0}>
          Save scenario
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Storybook-style list of a flow's named test inputs. Each scenario runs the
 * whole flow with its payload so branches can be exercised one story at a time.
 */
export function ScenariosPanel({ autoNew = false }: { autoNew?: boolean } = {}) {
  const flow = useBuilderStore((s) => s.flow);
  const run = useBuilderStore((s) => s.run);
  const runHistory = useBuilderStore((s) => s.runHistory);
  const runScenario = useBuilderStore((s) => s.runScenario);
  const addScenario = useBuilderStore((s) => s.addScenario);
  const updateScenario = useBuilderStore((s) => s.updateScenario);
  const removeScenario = useBuilderStore((s) => s.removeScenario);
  const testWorkflow = useBuilderStore((s) => s.testWorkflow);
  const testReport = useBuilderStore((s) => s.scenarioTestReports[s.flow.id]);
  const testPending = useBuilderStore((s) => s.scenarioTestPending === s.flow.id);
  const runnerOnline = useBuilderStore((s) => s.runnerOnline);
  const runAgent = useBuilderStore((s) => s.runAgent);
  const agentRunning = useBuilderStore((s) => s.agentRun?.status === 'running');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const scenarios = flow.scenarios ?? [];
  const hasInputNode = flow.nodes.some((n) => n.type === 'Input');
  const busy = run?.status === 'running';
  const hasExpects = scenarios.some((sc) => sc.expect && Object.keys(sc.expect).length > 0);

  const resultFor = (sc: ScenarioDefinition): ScenarioTestResult | undefined =>
    testReport?.results.find((r) => r.scenario === sc.name);

  const onCoverWithAi = () =>
    void runAgent({
      action: 'cover-operation',
      flowId: flow.id,
      instruction:
        'Cover this operation: one scenario per branch, each with an expect, verified with the test command.',
    });

  const onTestAll = async () => {
    setTestError(null);
    try {
      await testWorkflow(flow.id);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Test run failed');
    }
  };

  // Opened via "New scenario…": jump straight into the create editor.
  const blankEditor = (): EditorState => ({
    target: 'new',
    name: '',
    description: '',
    payload: JSON.stringify(seedPayload(flow), null, 2),
    expectStatus: '',
    expectNodes: '',
    expectBody: '',
    error: null,
  });

  useEffect(() => {
    if (autoNew) setEditor(blankEditor());
    // Seed once on mount for the create entry point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoNew]);

  const lastRunFor = (sc: ScenarioDefinition) =>
    runHistory.find((r) => r.workflowId === flow.id && r.scenarioName === sc.name);

  const openEditor = (sc?: ScenarioDefinition) =>
    setEditor(
      sc
        ? {
            target: sc.id,
            name: sc.name,
            description: sc.description ?? '',
            payload: JSON.stringify(sc.input, null, 2),
            expectStatus: sc.expect?.status !== undefined ? String(sc.expect.status) : '',
            expectNodes: sc.expect?.executedNodes?.join(', ') ?? '',
            expectBody:
              sc.expect?.body !== undefined ? JSON.stringify(sc.expect.body, null, 2) : '',
            error: null,
          }
        : blankEditor(),
    );

  const saveEditor = () => {
    if (!editor) return;
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(editor.payload);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Payload must be a JSON object');
      }
      input = parsed as Record<string, unknown>;
    } catch (err) {
      setEditor({ ...editor, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const built = buildExpect(editor);
    if ('error' in built) {
      setEditor({ ...editor, error: built.error });
      return;
    }
    const description = editor.description.trim() || undefined;
    if (editor.target === 'new') {
      addScenario(editor.name.trim(), input, description, built.expect);
    } else {
      // `expect: undefined` deliberately clears a removed expectation —
      // JSON serialization drops the key on save.
      updateScenario(editor.target, {
        name: editor.name.trim(),
        description,
        input,
        expect: built.expect,
      });
    }
    setEditor(null);
  };

  if (scenarios.length === 0 && !editor) {
    return (
      <div className="px-1 py-2.5">
        <div className="text-[12.5px] leading-relaxed text-muted-foreground/70">
          Scenarios are example inputs for this operation — one per situation you want to see
          it handle. Give a scenario an <span className="font-mono text-[11.5px]">expect</span>{' '}
          and it becomes a test: <span className="font-mono text-[11.5px]">emberflow test</span>{' '}
          and the Test all button will assert it.
        </div>
        <div className="mt-2.5 flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={agentRunning}
            onClick={onCoverWithAi}
          >
            <SparklesIcon className="size-3.5" />
            Cover with AI
          </Button>
          <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" onClick={() => openEditor()}>
            <PlusIcon className="size-3.5" />
            Add manually
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {!hasInputNode && (
        <div className="px-2 py-1.5 text-[12px] text-muted-foreground/70">
          This flow has no Input node, so scenario payloads are never consumed. Add an
          Input node to drive it.
        </div>
      )}
      <div className="flex items-center gap-2.5 px-2 pb-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1.5 text-muted-foreground"
          disabled={agentRunning}
          title="Ask the agent to write one scenario per branch of this operation, each with an expect, and verify them"
          onClick={onCoverWithAi}
        >
          <SparklesIcon className="size-3" />
          Cover with AI
        </Button>
        {hasExpects && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1.5"
              disabled={testPending || runnerOnline !== true}
              title={runnerOnline !== true ? 'Runner offline — tests run on the runner' : 'Run every scenario that has an expect and check its assertions'}
              onClick={() => void onTestAll()}
            >
              {testPending ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <FlaskConicalIcon className="size-3" />
              )}
              Test all
            </Button>
            {testReport && !testPending && (
              <span className="text-[11.5px] text-muted-foreground">
                <span className={cn(testReport.failed > 0 ? 'text-destructive' : 'text-success')}>
                  {testReport.failed > 0
                    ? `${testReport.failed} failed`
                    : `${testReport.passed} passed`}
                </span>
                {testReport.failed > 0 && ` · ${testReport.passed} passed`}
                {testReport.skipped > 0 && ` · ${testReport.skipped} skipped`}
              </span>
            )}
          </>
        )}
        {testError && <span className="truncate text-[11.5px] text-destructive">{testError}</span>}
      </div>
      {scenarios.map((sc) => {
        const last = lastRunFor(sc);
        const result = resultFor(sc);
        return (
          <div key={sc.id}>
            <div className="group flex items-center gap-2.5 rounded-md px-2 py-1 hover:bg-card">
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0 text-muted-foreground hover:text-highlight"
                disabled={busy}
                onClick={() => void runScenario(sc.id)}
                title={`Run "${sc.name}"`}
              >
                <PlayIcon className="size-3.5" />
              </Button>
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  last ? statusDot[last.status] : 'bg-border',
                )}
                title={last ? `Last run ${last.status}` : 'Not run yet'}
              />
              <span className="shrink-0 text-[12.5px] font-medium text-foreground">{sc.name}</span>
              {sc.expect && Object.keys(sc.expect).length > 0 && (
                <span
                  className={cn(
                    'shrink-0 rounded-sm border border-border/60 px-1 font-mono text-[10.5px]',
                    result?.status === 'passed' && 'border-success/40 text-success',
                    result?.status === 'failed' && 'border-destructive/40 text-destructive',
                    !result && 'text-muted-foreground/70',
                  )}
                  title={
                    result?.status === 'passed'
                      ? 'Last test passed'
                      : result?.status === 'failed'
                        ? 'Last test failed'
                        : 'Expectation — run Test all to assert'
                  }
                >
                  {result?.status === 'passed' && '✓ '}
                  {result?.status === 'failed' && '✗ '}
                  {expectChipText(sc.expect)}
                </span>
              )}
              {sc.description && (
                <span className="truncate text-[12px] text-muted-foreground">{sc.description}</span>
              )}
              <span className="ml-auto max-w-72 truncate font-mono text-[11px] text-muted-foreground/60">
                {previewPayload(sc.input)}
              </span>
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground"
                  onClick={() => openEditor(sc)}
                  title="Edit scenario"
                >
                  <PencilIcon className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-destructive"
                  onClick={() => removeScenario(sc.id)}
                  title="Delete scenario"
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </span>
            </div>
            {result?.status === 'failed' && result.failures && (
              <div className="ml-11 space-y-0.5 pb-1">
                {result.failures.map((f, i) => (
                  <div key={i} className="font-mono text-[11px] text-destructive/90">
                    {f}
                  </div>
                ))}
              </div>
            )}
            {editor?.target === sc.id && (
              <ScenarioEditor
                state={editor}
                onChange={setEditor}
                onSave={saveEditor}
                onCancel={() => setEditor(null)}
              />
            )}
          </div>
        );
      })}
      {editor?.target === 'new' ? (
        <ScenarioEditor
          state={editor}
          onChange={setEditor}
          onSave={saveEditor}
          onCancel={() => setEditor(null)}
        />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1 gap-1.5 text-muted-foreground"
          onClick={() => openEditor()}
        >
          <PlusIcon className="size-3.5" />
          New scenario
        </Button>
      )}
    </div>
  );
}
