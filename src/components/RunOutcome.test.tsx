import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HistoryConversation, RunOutcome, operationIdFromFile } from './AgentConsole';

describe('operationIdFromFile', () => {
  it('maps operation files to ids and rejects sidecars/meta/non-ops', () => {
    expect(operationIdFromFile('emberflow/apis/billing/charge.json')).toBe('billing/charge');
    expect(operationIdFromFile('emberflow/apis/default/hello.json')).toBe('default/hello');
    expect(operationIdFromFile('emberflow/apis/default/hello.scenarios.json')).toBeNull();
    expect(operationIdFromFile('emberflow/apis/billing/_meta.json')).toBeNull();
    expect(operationIdFromFile('emberflow.config.mjs')).toBeNull();
    expect(operationIdFromFile('.gitignore')).toBeNull();
  });
});

describe('RunOutcome', () => {
  const files = [
    'emberflow/apis/billing/charge.json',
    'emberflow/apis/billing/charge.scenarios.json',
    '.gitignore',
  ];

  it('leads with an Open button for the touched operation; diff hidden; revert is a quiet link', () => {
    const out = renderToStaticMarkup(
      <RunOutcome diff="diff --git a b" files={files} done={true} onOpenOperation={() => {}} onRevert={() => {}} />,
    );
    expect(out).toContain('Open charge');
    // Files listed compactly.
    expect(out).toContain('billing/charge.scenarios.json');
    // Raw diff NOT rendered until the disclosure is opened.
    expect(out).not.toContain('diff --git');
    expect(out).toContain('View diff');
    // Revert demoted from a big destructive button to a quiet link.
    expect(out).toContain('Revert these changes');
    expect(out).not.toContain('Revert last change');
  });

  it('failed runs show the evidence but no revert and no Open CTA', () => {
    const out = renderToStaticMarkup(
      <RunOutcome diff="diff --git a b" files={files} done={false} onOpenOperation={() => {}} onRevert={() => {}} />,
    );
    expect(out).not.toContain('Open charge');
    expect(out).not.toContain('Revert these changes');
    expect(out).toContain('View diff');
  });

  it('no diff → single quiet line', () => {
    const out = renderToStaticMarkup(
      <RunOutcome files={[]} done={true} onOpenOperation={() => {}} onRevert={() => {}} />,
    );
    expect(out).toContain('No changes were made.');
  });

  it('shows a per-operation scenario verdict: pass count green, failing scenario named', () => {
    const out = renderToStaticMarkup(
      <RunOutcome
        diff="d" files={['emberflow/apis/billing/charge.json']} done={true}
        verdicts={{ 'billing/charge': { passed: 4, failed: 1, skipped: 0, results: [
          { opId: 'billing/charge', scenario: 'vip', status: 'passed' },
          { opId: 'billing/charge', scenario: 'declined-card', status: 'failed', failures: ['expected 402, got 200'] },
        ] } }}
        onOpenOperation={() => {}} onRevert={() => {}}
      />,
    );
    expect(out).toContain('4 passed');
    expect(out).toContain('1 failed');
    expect(out).toContain('declined-card');
    expect(out).toContain('expected 402, got 200');
  });
});

describe('HistoryConversation', () => {
  const run = {
    id: 'h1',
    action: 'edit-flow',
    instruction: 'add rate limiting',
    status: 'done' as const,
    startedAt: '2026-07-19T10:00:00Z',
    finishedAt: '2026-07-19T10:05:00Z',
    events: [{ type: 'message' as const, text: 'Added a limiter node.' }],
  };

  it('collapsed: shows the user message and outcome meta, not the transcript', () => {
    const out = renderToStaticMarkup(<HistoryConversation run={run} />);
    expect(out).toContain('add rate limiting');
    expect(out).toContain('completed');
    expect(out).not.toContain('Added a limiter node.');
  });

  it('falls back to an action label when the run carried no instruction', () => {
    const out = renderToStaticMarkup(<HistoryConversation run={{ ...run, instruction: '', action: 'build-api' }} />);
    expect(out).toContain('Build this API');
  });

  it('failed runs read as failed', () => {
    const out = renderToStaticMarkup(<HistoryConversation run={{ ...run, status: 'error' as const }} />);
    expect(out).toContain('failed');
  });
});
