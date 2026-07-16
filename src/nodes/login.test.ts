import { describe, expect, it } from 'vitest';
import { createLoginRegistry } from './login';
import { createDefaultRegistry } from './index';
import { createLoginFlow } from '../flows/login-flow';
import { startRun } from '../engine';

describe('login example', () => {
  it('registers the four login demo nodes (Result moved to flow-control)', () => {
    const types = createLoginRegistry(0).list().map((d) => d.type);
    expect(types).toEqual(
      expect.arrayContaining(['ValidateCredentials', 'FetchUser', 'CheckPlan', 'IssueToken']),
    );
  });

  it('runs the prebuilt flow end to end', async () => {
    const run = await startRun({ flow: createLoginFlow(), registry: createDefaultRegistry(0) }).runToEnd();
    expect(run.status).toBe('succeeded');
    const result = Object.values(run.nodeStates).find((s) => (s.output as any)?.token !== undefined);
    expect(result).toBeDefined();
  });

  it('result node output contains the token', async () => {
    const flow = createLoginFlow();
    const run = await startRun({ flow, registry: createDefaultRegistry(0) }).runToEnd();
    const resultNode = flow.nodes.find((n) => n.type === 'Result')!;
    expect((run.nodeStates[resultNode.id].output as any).data.token).toBe('tok_user-ada');
  });

  it('fails on short password', async () => {
    const flow = createLoginFlow();
    (flow.nodes.find((n) => n.id === 'input')!.config.defaults as Record<string, unknown>).password = 'x';
    const run = await startRun({ flow, registry: createDefaultRegistry(0) }).runToEnd();
    expect(run.status).toBe('failed');
  });

  it('takes the welcome branch for a run invoked with a new-user payload', async () => {
    const run = await startRun({
      flow: createLoginFlow(),
      registry: createDefaultRegistry(0),
      input: { username: 'new-zoe', password: 'longenough' },
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect((run.nodeStates.route.output as any).$branch).toBe('true');
    expect(run.nodeStates.welcome.status).toBe('succeeded');
    expect((run.nodeStates.issueToken.output as any).token).toBe('tok_user-new-zoe');
  });

  it('falls back to configured defaults when invoked with no input', async () => {
    const run = await startRun({
      flow: createLoginFlow(),
      registry: createDefaultRegistry(0),
    }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect((run.nodeStates.issueToken.output as any).token).toBe('tok_user-ada');
  });

  it('existing user (ada) routes through checkPlan and skips welcome', async () => {
    const flow = createLoginFlow();
    const run = await startRun({ flow, registry: createDefaultRegistry(0) }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates.route.status).toBe('succeeded');
    expect((run.nodeStates.route.output as any).$branch).toBe('existing');
    expect(run.nodeStates.checkPlan.status).toBe('succeeded');
    expect(run.nodeStates.welcome.status).toBe('skipped');
    expect(run.nodeStates.issueToken.status).toBe('succeeded');
  });

  it('new user (new-ada) routes through welcome and skips checkPlan', async () => {
    const flow = createLoginFlow();
    (flow.nodes.find((n) => n.id === 'input')!.config.defaults as Record<string, unknown>).username = 'new-ada';
    const run = await startRun({ flow, registry: createDefaultRegistry(0) }).runToEnd();
    expect(run.status).toBe('succeeded');
    expect((run.nodeStates.route.output as any).$branch).toBe('true');
    expect(run.nodeStates.welcome.status).toBe('succeeded');
    expect((run.nodeStates.welcome.output as any).message).toBe('Welcome aboard, new-ada!');
    expect(run.nodeStates.checkPlan.status).toBe('skipped');
    expect(run.nodeStates.issueToken.status).toBe('succeeded');
    // checkPlan skipped → plan input undefined → IssueToken defaults to 'free'.
    expect((run.nodeStates.issueToken.output as any).plan).toBe('free');
  });
});
